// Pages. Each handler runs its queries as the signed-in person (no agent
// claim) through asPerson(); the database decides what they may see and do.
// Structure follows docs/research/ux-patterns.md.

import type { Writable } from "node:stream";
import type pg from "pg";
import { asPerson, readOnlyRequest } from "./db.js";
import { authorize } from "./oauth.js";
import { activityBody } from "./activity.js";
import { diffMode, diffSection } from "./diffview.js";
import { csrfField, html, page, pageHeader, raw, when, type Nav, type Raw, type Theme } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import { errorPage, refusalText } from "./errorpage.js";
import { failure } from "./failure.js";
import { fillPeople, personRef } from "./people.js";
import { pendingList, variablesRoutes } from "./variablespage.js";
import { pendingPushes } from "./variables.js";
import { adminRoutes } from "./vaultadmin.js";
import { deletionNotices, inviteRoutes } from "./members.js";
import { applyTemplate, templateById, templateChoices } from "./templates.js";
import { accountPage, myAdmission, myPlan, notAdmittedNote, planLine } from "./plans.js";
import {
  latestFeedback,
  NOT_SNOOZED_SQL,
  postComment,
  rowSnooze,
  snooze,
  snoozeControl,
  snoozedList,
  snoozedSection,
  threadSection,
  unsnooze,
} from "./thread.js";

export type Ctx = {
  userId: string;
  csrf: string;
  url: URL;
  form: URLSearchParams;
  method: string | undefined;
  flash?: string;
  theme: Theme;
  mcpUrl: string;
  reviewCount?: number;
  setFlash: (message: string) => void;
  ip: string; // the client's address, for rate limits only (ratelimit.ts)
};
// formAction: one more origin the page's forms may submit (and redirect) to.
// download: a file streamed as the response (no-store, as an attachment).
// retryAfter: seconds, sent as Retry-After (a 429).
export type Download = { filename: string; type: string; write: (out: Writable) => Promise<void> };
export type Reply = { status?: number; html?: string; redirect?: string; formAction?: string; download?: Download; retryAfter?: number };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type Vault = { id: string; name: string; role: string };

// A refusal from the database, as the reason and a reference to show on the
// page (errorpage.ts); anything else is thrown on to the error page.
export const message = refusalText;

// Who did something: "you", someone's email where the reader may see it
// (people.ts), or "system".
export const who = (ctx: Ctx, id: string | null, agent: string | null) =>
  `${id === ctx.userId ? "you" : id ? personRef(id) : "system"}${agent ? ` via ${agent}` : ""}`;

// Canon and open as badges: a filled or hollow diamond (drawn in CSS) and
// the word, so the policy never rests on the mark alone.
const tag = (policy: string) =>
  html`<span class="badge policy ${policy}">${policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy}</span>`;
const canWrite = (v: Vault) => v.role === "owner" || v.role === "editor";

const q = encodeURIComponent;
export const vaultPath = (id: string, rest = "") => `/v/${id}${rest}`;
const filePath = (id: string, path: string, tab?: string) =>
  `/v/${id}/file?path=${q(path)}${tab ? `&tab=${tab}` : ""}`;
const treePath = (id: string, dir: string) => (dir ? `/v/${id}/tree?path=${q(dir)}` : `/v/${id}`);
const proposalPath = (id: string, pid: string, rest = "") => `/v/${id}/proposals/${pid}${rest}`;

export function ago(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function render(ctx: Ctx, title: string, body: Raw, nav?: Nav): Reply {
  return {
    html: page(title, body, {
      user: ctx.userId,
      flash: ctx.flash,
      theme: ctx.theme,
      csrf: ctx.csrf,
      path: ctx.url.pathname + ctx.url.search,
      nav,
      reviewCount: ctx.reviewCount,
    }),
  };
}

// Not found, saying what was looked for. Someone else's vault, file or
// proposal must look exactly like one that doesn't exist, so the reason
// never says which (web/test/web.test.mjs, "isolation").
export const notFound = (ctx: Ctx): Reply => {
  const inVault = ctx.url.pathname.startsWith("/v/");
  const f = failure({
    status: 404,
    where: inVault ? "database (only what’s shared with you is visible)" : "web app",
    why: inVault ? "There’s no such vault, file or proposal, or it isn’t shared with you." : `There’s no page at ${ctx.url.pathname}.`,
  });
  return {
    status: 404,
    html: errorPage(f, {
      title: "Not found",
      // The flash too: a refused write of a new path lands here, and its
      // message must not be dropped.
      user: ctx.userId, flash: ctx.flash, theme: ctx.theme, csrf: ctx.csrf, path: "/", reviewCount: ctx.reviewCount,
    }),
  };
};

export async function vault(c: pg.PoolClient, ctx: Ctx, id: string): Promise<Vault | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await c.query(
    `select v.id, v.name, m.role from public.vaults v
       join public.vault_members m on m.vault_id = v.id and m.user_id = $2
      where v.id = $1`,
    [id, ctx.userId],
  );
  return rows[0];
}

// Quorums for a list of proposals that spans vaults, from one
// rules_for_pairs() call for the whole list (one membership check), not
// rule_for() per row (100 waiting across 10 vaults: see server-load.md,
// "Third pass"). `list` is a query with vault_id, path and ord columns;
// the result is its rows with `quorum`, in `ord` order.
const withQuorums = (list: string) => `
  with w as (${list}),
       k as (select array_agg(vault_id) as vs, array_agg(path) as ps
               from (select distinct vault_id, path from w) d)
  select w.*, r.quorum
    from w cross join k
    left join private.rules_for_pairs(k.vs, k.ps) r on r.vault_id = w.vault_id and r.path = w.path
   order by w.ord`;

// Proposals waiting on this person: open, in a vault they can approve in, and
// not yet decided by them at the current revision.
const WAITING_SQL = `
  select p.id, p.vault_id, v.name as vault, p.kind, p.path, p.proposed_by, p.agent, p.created_at,
         p.revision, p.status, cur.body as current_body, p.body,
         (select count(*) from public.approvals a
           where a.proposal_id = p.id and a.decision = 'approve' and a.revision = p.revision)::int as approvals
    from public.proposals p
    join public.vaults v on v.id = p.vault_id
    join public.vault_members m on m.vault_id = p.vault_id and m.user_id = $1 and m.role in ('owner', 'editor')
    left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
    left join public.file_versions cur on cur.id = f.current_version_id
   where p.status = 'open'
     and not exists (select 1 from public.approvals a
                      where a.proposal_id = p.id and a.user_id = $1 and a.revision = p.revision)${NOT_SNOOZED_SQL}`;

// The waiting list in `order` (over WAITING_SQL's columns, as q.*), at
// most `limit` rows, each with its quorum.
const waitingSql = (order: string, limit?: number) =>
  withQuorums(`select q.*, row_number() over (order by ${order}) as ord from (${WAITING_SQL}) q
                order by ${order}${limit ? ` limit ${limit}` : ""}`);

export async function reviewCount(userId: string): Promise<number> {
  return asPerson(userId, async (c) => (await c.query(`select count(*)::int as n from (${WAITING_SQL}) w`, [userId])).rows[0].n);
}

// ---------------------------------------------------------------------------
// Risk: facts about a change that deserve a closer look. Computed from the
// change itself, never from what the agent says about it.

function risks(
  p: { kind: string; body: string | null; current_body: string | null; revision: number },
  extra: string[] = [],
): string[] {
  const out: string[] = [];
  if (p.kind === "delete") out.push("Deletes the file");
  const before = (p.current_body ?? "").split("\n").filter((l) => l.trim());
  const after = new Set((p.kind === "delete" ? "" : p.body ?? "").split("\n"));
  const removed = before.filter((l) => !after.has(l)).length;
  if (p.kind !== "delete" && before.length >= 4 && removed / before.length >= 0.5)
    out.push(`Removes ${removed} of ${before.length} lines`);
  if (p.current_body === null && p.kind !== "delete") out.push("Creates a new file");
  if (p.revision > 1) out.push(`Revised ${p.revision - 1} time${p.revision > 2 ? "s" : ""}; earlier approvals don’t count`);
  return [...out, ...extra];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reviewRow = (ctx: Ctx, p: any, showVault = false, snoozable = false) => {
  // A new file is shown as a neutral label; only real risks get the amber badge.
  const r = risks(p).filter((x) => x !== "Creates a new file");
  const verb = p.kind === "delete" ? "Delete" : p.current_body === null ? "Create" : "Change";
  return html`<li>
    <span><a class="name" href="${proposalPath(p.vault_id, p.id)}">${verb} ${p.path}</a>
      <span class="muted small"> · ${showVault ? `${p.vault} · ` : ""}by ${who(ctx, p.proposed_by, p.agent)} · ${ago(p.created_at)}</span></span>
    <span class="row-end small">${verb === "Create" ? html`<span class="badge">New file</span> ` : ""}${r.length ? html`<span class="badge attention risk-count" title="${r.join("; ")}">${r[0]}${r.length > 1 ? ` +${r.length - 1} more` : ""}</span> ` : ""}<span class="muted">${p.approvals} of ${p.quorum}</span>${
      snoozable ? rowSnooze(ctx, p.vault_id, p.id, `${verb} ${p.path}`) : ""
    }</span>
  </li>`;
};

// ---------------------------------------------------------------------------
// Vault shell: sidebar with search, links and the folder tree.

type TreeNode = { dirs: Map<string, TreeNode>; files: { name: string; path: string; policy: string }[] };
export type Section = "files" | "proposals" | "activity" | "rules" | "search" | "variables" | "settings";

export async function vaultShell(c: pg.PoolClient, ctx: Ctx, v: Vault, current: { path?: string; section?: Section }, body: Raw): Promise<Raw> {
  // One round trip: the live files, every folder above them, each one's
  // rule in one set-based call (one membership check, not rule_for() per
  // row), and the open proposals' count.
  const shell = (
    await c.query(
      `with p as (select path from public.files where vault_id = $1 and deleted_at is null),
            d as (select distinct array_to_string(s[1:i], '/') || '/' as path
                    from (select string_to_array(path, '/') as s from p) x, generate_series(1, cardinality(s) - 1) i),
            r as (select * from private.rules_for($1, array(select path from p union all select path from d)))
       select (select coalesce(json_agg(json_build_array(p.path, coalesce(r.policy, 'open')) order by p.path), '[]')
                 from p left join r on r.path = p.path) as files,
              (select coalesce(json_object_agg(d.path, coalesce(r.policy, 'open')), '{}')
                 from d left join r on r.path = d.path) as dirs,
              (select count(*)::int from public.proposals where vault_id = $1 and status = 'open') as open`,
      [v.id],
    )
  ).rows[0] as { files: [string, string][]; dirs: Record<string, string>; open: number };
  const files = shell.files.map(([path, policy]) => ({ path, policy }));
  const dirPolicy = new Map<string, string>(Object.entries(shell.dirs));
  const open = shell.open;

  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path, policy: f.policy });
  }
  const here = current.path ?? "";
  const renderNode = (node: TreeNode, prefix: string): Raw =>
    html`<ul>${[...node.dirs.entries()].map(([name, child]) => {
      const dir = `${prefix}${name}/`;
      const policy = dirPolicy.get(dir) ?? "open";
      return html`<li><details${here.startsWith(dir) ? raw(" open") : ""}><summary><span class="mark ${policy}" title="${policy}"></span><a href="${treePath(v.id, dir)}"${here === dir ? raw(' aria-current="page"') : ""}>${name}</a></summary>${renderNode(child, dir)}</details></li>`;
    })}${node.files.map(
      (f) => html`<li class="leaf"><a href="${filePath(v.id, f.path)}"${here === f.path ? raw(' aria-current="page"') : ""}>${f.name}</a></li>`,
    )}</ul>`;

  const link = (section: Section, href: string, label: Raw | string) =>
    html`<a href="${href}"${current.section === section ? raw(' aria-current="page"') : ""}>${label}</a>`;
  // Settings holds Rules, so the Rules page marks Settings as current.
  const settingsLink = () => link(current.section === "rules" ? "rules" : "settings", vaultPath(v.id, "/config"), "Settings");
  const tree = files.length ? renderNode(root, "") : html`<p class="muted small tree-empty">No files yet.</p>`;
  return html`<div class="vault">
    <aside class="side">
      <a class="side-title" href="${vaultPath(v.id)}">${v.name}</a>
      <form class="side-search" method="get" action="${vaultPath(v.id, "/search")}" role="search">
        <input type="search" name="q" placeholder="Search this vault" aria-label="Search this vault" value="${current.section === "search" ? ctx.url.searchParams.get("q") ?? "" : ""}">
      </form>
      <nav class="side-links" aria-label="Vault">
        ${link("files", vaultPath(v.id), "Files")}
        ${link("proposals", vaultPath(v.id, "/proposals"), html`Proposals${open ? html`<span class="count">${open}</span>` : ""}`)}
        ${link("activity", vaultPath(v.id, "/activity"), "Activity")}
        ${link("variables", vaultPath(v.id, "/variables"), "Variables")}
        ${settingsLink()}
      </nav>
      <nav class="tree" aria-label="Files">${tree}</nav>
    </aside>
    <details class="tree-mobile"><summary>Browse ${v.name}</summary>
      <nav class="side-links" aria-label="Vault (mobile)">
        ${link("files", vaultPath(v.id), "Files")}${link("proposals", vaultPath(v.id, "/proposals"), "Proposals")}${link("activity", vaultPath(v.id, "/activity"), "Activity")}${link("variables", vaultPath(v.id, "/variables"), "Variables")}${settingsLink()}
      </nav>
      <nav class="tree" aria-label="Files (mobile)">${tree}</nav></details>
    <div class="content">${body}</div>
  </div>`;
}

type RuleInfo = {
  rule?: { path: string; policy: string; quorum: number; set_by: string | null; set_at: Date | null };
  def: string;
};

async function ruleFor(c: pg.PoolClient, id: string, path: string): Promise<RuleInfo> {
  const rule = (
    await c.query(
      `select pp.path, pp.policy, pp.quorum,
              (select l.actor from public.log l where l.vault_id = $1 and l.event = 'policy.set' and l.path = pp.path
                order by l.seq desc limit 1) as set_by,
              (select l.at from public.log l where l.vault_id = $1 and l.event = 'policy.set' and l.path = pp.path
                order by l.seq desc limit 1) as set_at
         from public.path_policies pp
        where pp.vault_id = $1
          and (pp.path = $2 or (right(pp.path, 1) = '/' and starts_with($2, pp.path)))
        order by (pp.path = $2) desc, length(pp.path) desc
        limit 1`,
      [id, path],
    )
  ).rows[0];
  const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
  return { rule, def };
}

function ruleLine(ctx: Ctx, id: string, r: RuleInfo): Raw {
  if (!r.rule) return html`<p class="rule">${tag(r.def)} <span>The vault default. <a href="${vaultPath(id, "/rules")}">Rules</a></span></p>`;
  const needs = r.rule.policy === "canon" ? ` Changes need ${r.rule.quorum} approval${r.rule.quorum > 1 ? "s" : ""}.` : "";
  return html`<p class="rule">${tag(r.rule.policy)} <span>From the rule on <a href="${vaultPath(id, "/rules")}"><code>${r.rule.path}</code></a>${
    r.rule.set_at ? `, set by ${who(ctx, r.rule.set_by, null)} ${ago(r.rule.set_at)}` : ""
  }.${needs}</span></p>`;
}

function crumbs(id: string, v: Vault, path: string, isDir: boolean): Raw {
  const parts = path.split("/").filter(Boolean);
  const links: Raw[] = [html`<a href="${vaultPath(id)}">${v.name}</a>`];
  const upto = isDir ? parts.length : parts.length - 1;
  for (let i = 0; i < upto; i++) {
    const dir = parts.slice(0, i + 1).join("/") + "/";
    links.push(html`<a href="${treePath(id, dir)}">${parts[i]}</a>`);
  }
  return html`<p class="crumb">${links.map((l, i) => html`${i ? html`<span aria-hidden="true"> / </span>` : ""}${l}`)}</p>`;
}

// ---------------------------------------------------------------------------
// Home and Review

async function home(ctx: Ctx): Promise<Reply> {
  const { vaults, waiting, plan } = await asPerson(ctx.userId, async (c) => ({
    plan: await myPlan(c),
    vaults: (
      await c.query(
        `select v.id, v.name, m.role,
                (select count(*) from public.files f where f.vault_id = v.id and f.deleted_at is null)::int as files
           from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by v.name`,
        [ctx.userId],
      )
    ).rows,
    waiting: (await c.query(waitingSql("q.created_at", 5), [ctx.userId])).rows,
  }));
  const gone = await asPerson(ctx.userId, deletionNotices);
  // One primary per page: New vault. Review, when something waits, sits
  // before it as a secondary button.
  return render(
    ctx,
    "Home",
    html`${pageHeader({
      title: "Reliquary",
      actions: html`${(ctx.reviewCount ?? 0) > 0 ? html`<a class="button" href="/review">Review ${ctx.reviewCount} waiting</a>` : ""}
        <a class="button primary" href="/vaults/new">New vault</a>`,
    })}
    <p class="lede">Shared context your agents read and propose to. Changes to canon files wait for your approval.</p>
    ${gone}
    ${vaults.length === 0
      ? ""
      : html`<h2>Needs your review</h2>
    ${waiting.length
      ? html`<ul class="rows">${waiting.map((p) => reviewRow(ctx, p, true))}</ul>
        ${(ctx.reviewCount ?? 0) > waiting.length ? html`<p class="small"><a href="/review">All ${ctx.reviewCount} waiting</a></p>` : ""}`
      : html`<div class="empty">Nothing is waiting on you.</div>`}`}
    <h2>Your vaults</h2>
    <p class="small muted plan-line"><a href="/account">${planLine(plan)}</a></p>
    ${vaults.length === 0
      ? html`<div class="empty first-vault"><strong>Create your first vault.</strong>
          <p>A vault holds the files you and your agents share: notes, briefs, decisions. You choose which of them are canon, so an agent can only propose changes and you approve them.</p>
          <p>Start blank, or from a template: a client engagement, personal projects or a product team, with folders, rules and a README that tells agents how to work there.</p>
          <p><a class="button" href="/vaults/new">Create your first vault</a></p>
          <p class="small">Joining someone else’s vault? Open the invite link they sent you. It works once you’re signed in with the address it was sent to.</p></div>`
      : html`<ul class="rows">${vaults.map(
          (v) => html`<li>
            <span><a class="name" href="${vaultPath(v.id)}">${v.name}</a>
              <span class="muted small"> · ${v.role} · ${v.files} ${v.files === 1 ? "file" : "files"}</span></span>
          </li>`,
        )}</ul>`}`,
    "home",
  );
}

// ---------------------------------------------------------------------------
// New vault. The database decides who may create one (a person, or their
// agent through an all-vaults read-write token); here it is always the
// person. They become its owner.

async function newVault(ctx: Ctx): Promise<Reply> {
  const { plan, admission } = await asPerson(ctx.userId, async (c) => ({ plan: await myPlan(c), admission: await myAdmission(c) }));
  const full = plan.vaultsOwned >= plan.maxVaults;
  return render(
    ctx,
    "New vault",
    html`${pageHeader({
      crumb: html`<p class="crumb"><a href="/">Vaults</a></p>`,
      title: "New vault",
      actions: html`<a class="button quiet" href="/">Cancel</a>
        <button class="primary" form="new-vault">Create vault</button>`,
    })}
    <p class="lede">A vault holds the files you and your agents share. You’ll be its owner: you add members and set its rules.</p>
    ${!admission.admitted
      ? notAdmittedNote()
      : full
      ? html`<p class="callout attention" role="status">You own ${plan.vaultsOwned} of the ${plan.maxVaults} vaults the ${plan.planName} plan allows, so a new one can’t be created. Delete a vault you no longer need first. <a href="/account">Plan and usage</a></p>`
      : html`<p class="small muted plan-line">${planLine(plan)}. <a href="/account">Plan and usage</a></p>`}
    <form method="post" action="/vaults/new" class="panel choice-form" id="new-vault">
      ${csrfField(ctx.csrf)}
      <label for="vn">Name</label>
      <input id="vn" type="text" name="name" placeholder="Client work" required maxlength="100">
      ${templateChoices()}
      <fieldset>
        <legend>Default policy</legend>
        <label class="choice"><input type="radio" name="default_policy" value="open" checked>
          <span><strong>Open:</strong> members and their agents write files directly. Every change is logged.</span></label>
        <label class="choice"><input type="radio" name="default_policy" value="canon">
          <span><strong>Canon:</strong> every change is a proposal that people approve before it applies.</span></label>
        <p class="hint">This is what a file is unless a rule says otherwise. You can make folders or files canon or open later, on the vault’s Rules page.</p>
      </fieldset>
      <div class="actions"><button class="primary">Create vault</button>
        <a class="button quiet" href="/">Cancel</a></div>
    </form>`,
    "vaults",
  );
}

async function createVault(ctx: Ctx): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  // Anything but canon is the ordinary default, open.
  const policy = ctx.form.get("default_policy") === "canon" ? "canon" : "open";
  // No template field is Blank, as before templates.
  const template = templateById(ctx.form.get("template") || "blank");
  if (!template) {
    ctx.setFlash("Choose one of the templates on the form.");
    return { redirect: "/vaults/new" };
  }
  try {
    // One transaction: a template that fails partway leaves no vault.
    const id = await asPerson(ctx.userId, (c) => applyTemplate(c, name, policy, template));
    ctx.setFlash(
      template.files.length
        ? `Created ${name} from the ${template.name} template. You’re its owner. Start with README.md.`
        : `Created ${name}. You’re its owner. Add files, or connect an agent to it.`,
    );
    return { redirect: vaultPath(id) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: "/vaults/new" };
  }
}

async function review(ctx: Ctx): Promise<Reply> {
  const { waiting, revising, snoozed } = await asPerson(ctx.userId, async (c) => ({
    waiting: (await c.query(waitingSql("q.vault, q.created_at"), [ctx.userId])).rows,
    snoozed: await snoozedList(c, ctx.userId),
    revising: (
      await c.query(
        withQuorums(`select p.id, p.vault_id, v.name as vault, p.kind, p.path, p.proposed_by, p.agent, p.created_at,
                p.revision, p.body, cur.body as current_body, 0 as approvals,
                row_number() over (order by p.created_at) as ord
           from public.proposals p join public.vaults v on v.id = p.vault_id
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          where p.status = 'changes_requested'
            and exists (select 1 from public.approvals a where a.proposal_id = p.id and a.user_id = $1
                         and a.decision = 'request_changes')`),
        [ctx.userId],
      )
    ).rows,
  }));
  // Environment variables sent with `reliquary env push` that this person
  // may apply (docs/variables.md, "Imports").
  const pushes = (await pendingPushes(ctx.userId)).filter((p) => p.mayApply);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byVault = new Map<string, any[]>();
  for (const p of waiting) byVault.set(p.vault, [...(byVault.get(p.vault) ?? []), p]);
  return render(
    ctx,
    "Review",
    html`${pageHeader({ title: "Review" })}
    <p class="lede">Every change waiting on your approval, across your vaults. Read the change itself before the reason. Not now? Snooze one: it comes back when its time is up or it changes.</p>
    ${pushes.length ? pendingList(ctx, pushes, true) : ""}
    ${waiting.length === 0 && pushes.length === 0
      ? html`<div class="empty"><strong>Nothing is waiting on you.</strong> When an agent proposes a change to a canon file, it shows up here.</div>`
      : [...byVault.entries()].map(
          ([name, items]) => html`<h2>${name}</h2><ul class="rows review-rows">${items.map((p) => reviewRow(ctx, p, false, true))}</ul>`,
        )}
    ${revising.length
      ? html`<h2>Waiting on the proposer</h2>
        <p class="muted small">You asked for changes. These come back here when they’re revised.</p>
        <ul class="rows">${revising.map((p) => reviewRow(ctx, p, true))}</ul>`
      : ""}
    ${snoozedSection(ctx, snoozed)}`,
    "review",
  );
}

// ---------------------------------------------------------------------------
// Folders and files

async function folder(ctx: Ctx, id: string, rawDir: string): Promise<Reply> {
  const dir = rawDir ? rawDir.replace(/^\/+/, "").replace(/\/*$/, "/") : "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const children = (
      await c.query(
        // Every file under the folder, but only the README's text: the rest
        // is listing, and a folder of large files shouldn't be read whole.
        `with here as (
           select f.path, f.updated_at,
                  case when lower(f.path) = lower($2 || 'readme.md') then fv.body end as body
             from public.files f left join public.file_versions fv on fv.id = f.current_version_id
            where f.vault_id = $1 and f.deleted_at is null and starts_with(f.path, $2))
         select here.path, r.policy, here.updated_at, here.body
           from here join private.rules_for($1, array(select path from here)) r using (path)
          order by here.path`,
        [id, dir],
      )
    ).rows;
    if (dir && children.length === 0) return null;
    const rule = dir ? await ruleFor(c, id, dir) : null;
    const subdirs = new Map<string, Date>();
    const here: typeof children = [];
    for (const f of children) {
      const rest = f.path.slice(dir.length);
      if (rest.includes("/")) {
        const name = rest.split("/")[0];
        const prev = subdirs.get(name);
        if (!prev || prev < f.updated_at) subdirs.set(name, f.updated_at);
      } else here.push(f);
    }
    const readme = here.find((f) => /^readme\.md$/i.test(f.path.slice(dir.length)));
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true) : undefined,
        title: dir ? dir.slice(0, -1).split("/").pop()! : v.name,
        path: !!dir,
        meta: rule ? ruleLine(ctx, id, rule) : undefined,
        actions: html`${!dir ? html`<a class="button" href="/connect">Connect an agent</a>` : ""}
          ${canWrite(v) ? html`<a class="button primary" href="${vaultPath(id, `/new${dir ? `?dir=${q(dir)}` : ""}`)}">New file${dir ? " here" : ""}</a>` : ""}`,
      })}
      ${children.length === 0
        ? html`<div class="empty"><strong>This vault is empty.</strong> ${canWrite(v) ? "Create the first file, or connect an agent and ask it to write one." : "Nothing has been shared here yet."}</div>`
        : html`<div class="table-wrap"><table>
          <tr><th>Name</th><th>Policy</th><th class="num hide-sm">Updated</th></tr>
          ${[...subdirs.entries()].map(
            ([name, at]) => html`<tr><td><a class="dir" href="${treePath(id, `${dir}${name}/`)}">${name}/</a></td><td></td>
              <td class="num small muted hide-sm">${ago(at)}</td></tr>`,
          )}
          ${here.map(
            (f) => html`<tr><td><a href="${filePath(id, f.path)}">${f.path.slice(dir.length)}</a></td><td>${tag(f.policy)}</td>
              <td class="num small muted hide-sm">${ago(f.updated_at)}</td></tr>`,
          )}</table></div>`}
      ${readme?.body ? html`<h2>${readme.path.slice(dir.length)}</h2><div class="prose entry">${raw(renderMarkdown(readme.body))}</div>` : ""}`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, dir || data.v.name, data.shell, "vaults");
}

async function fileView(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  const t = ctx.url.searchParams.get("tab");
  const tab = t === "source" || t === "history" ? t : "preview";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const f = (
      await c.query(
        `select f.id, f.path, (private.rule_for(f.vault_id, f.path)).policy,
                fv.body, fv.author, fv.agent, fv.created_at, fv.erased_at
           from public.files f left join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null`,
        [id, path],
      )
    ).rows[0];
    if (!f) return null;
    const rule = await ruleFor(c, id, path);
    const pending = (
      await c.query(`select id from public.proposals where vault_id = $1 and path = $2 and status in ('open', 'changes_requested')`, [id, path])
    ).rows;
    const history =
      tab === "history"
        ? await activityBody(c, { me: ctx.userId, url: ctx.url, base: vaultPath(id, "/file"), keep: { path, tab }, scope: { vaultId: id, file: path } })
        : "";
    const canon = f.policy === "canon";
    const tabLink = (name: string, label: string) =>
      html`<a href="${filePath(id, path, name === "preview" ? undefined : name)}"${tab === name ? raw(' aria-current="page"') : ""}>${label}</a>`;
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false),
        title: path.split("/").pop()!,
        path: true,
        meta: html`${ruleLine(ctx, id, rule)}
          <p class="meta"><span>Last written by ${who(ctx, f.author, f.agent)}</span><span>${when(f.created_at)}</span></p>`,
        actions: html`${v.role === "owner" ? moreMenu(id, path) : ""}${
          canWrite(v) && !f.erased_at
            ? html`<a class="button${canon ? "" : " primary"}" href="${vaultPath(id, `/edit?path=${q(path)}`)}">${canon ? "Propose a change" : "Edit"}</a>`
            : ""
        }`,
      })}
      ${pending.length
        ? html`<p class="callout info">${pending.length === 1
            ? html`There’s an open proposal for this file. <a href="${proposalPath(id, pending[0].id)}">Review it</a>`
            : html`There are ${pending.length} open proposals for this file. <a href="${vaultPath(id, "/proposals")}">Review them</a>`}</p>`
        : ""}
      <nav class="tabs" aria-label="File view">${tabLink("preview", "Preview")}${tabLink("source", "Source")}${tabLink("history", "History")}</nav>
      ${f.erased_at
        ? html`<div class="empty">This file’s content was erased.</div>`
        : tab === "preview"
          ? html`<div class="prose entry">${raw(renderMarkdown(f.body ?? ""))}</div>`
          : tab === "source"
            ? html`<div class="file">${f.body}</div>`
            : history}`;
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, path, data.shell, "vaults");
}

// The file page's "More" menu: rare or irreversible actions, each through
// its own confirm page.
const moreMenu = (id: string, path: string) =>
  html`<details class="menu-wrap more-menu"><summary class="button quiet">More</summary>
    <div class="menu"><a class="danger" href="${vaultPath(id, `/erase?path=${q(path)}`)}">Erase this file…</a></div></details>`;

async function editView(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const f = (
      await c.query(
        `select f.path, (private.rule_for(f.vault_id, f.path)).policy, fv.body
           from public.files f join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null and fv.erased_at is null`,
        [id, path],
      )
    ).rows[0];
    if (!f) return null;
    const canon = f.policy === "canon";
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false),
        title: `${canon ? "Propose a change to" : "Edit"} ${path.split("/").pop()}`,
        path: true,
        actions: html`<a class="button quiet" href="${filePath(id, path)}">Cancel</a>
          <button class="primary" form="edit-file">${canon ? "Propose change" : "Save"}</button>`,
      })}
      ${canon ? html`<p class="lede">This file is canon, so your edit becomes a proposal that people approve.</p>` : ""}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="edit-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="${canon ? "propose" : "write"}">
        <label for="content">Text</label>
        <textarea id="content" name="content">${f.body}</textarea>
        ${canon ? html`<label for="r">Why this change</label><input id="r" type="text" name="reason" required>
          <p class="hint">Reviewers see this after the diff.</p>` : ""}
        <div class="actions"><button class="primary">${canon ? "Propose change" : "Save"}</button>
          <a class="button quiet" href="${filePath(id, path)}">Cancel</a></div>
      </form>
      <h2>Delete</h2>
      <form method="post" action="${vaultPath(id, "/file")}" class="danger-zone">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="${canon ? "propose-delete" : "delete"}">
        ${canon ? html`<input type="hidden" name="reason" value="Delete ${path}">` : ""}
        <p class="muted small">${canon ? "Deleting a canon file is a proposal too." : "The file’s history stays in the activity log."}</p>
        <button class="danger">${canon ? "Propose deleting this file" : "Delete this file"}</button>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Edit ${path}`, data.shell, "vaults");
}

async function newFile(ctx: Ctx, id: string): Promise<Reply> {
  const dir = (ctx.url.searchParams.get("dir") ?? "").replace(/^\/+/, "");
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true) : undefined,
        title: "New file",
        actions: html`<a class="button quiet" href="${treePath(id, dir)}">Cancel</a>
          <button class="primary" form="new-file">Create file</button>`,
      })}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="new-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="action" value="create">
        <label for="p">Path</label><input id="p" type="text" name="path" value="${dir}" placeholder="notes/standup.md" required>
        <p class="hint">Folders are part of the path. A path under a canon folder becomes a proposal.</p>
        <label for="c">Text</label><textarea id="c" name="content"></textarea>
        <label for="r">Why (only used if this becomes a proposal)</label>
        <input id="r" type="text" name="reason" value="New file">
        <div class="actions"><button class="primary">Create file</button>
          <a class="button quiet" href="${treePath(id, dir)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "New file", data.shell, "vaults");
}

async function fileAction(ctx: Ctx, id: string): Promise<Reply> {
  const f = ctx.form;
  const path = (f.get("path") ?? "").trim();
  const content = (f.get("content") ?? "").replaceAll("\r\n", "\n");
  const reason = f.get("reason") ?? "";
  const action = f.get("action") ?? "";
  if (!["create", "write", "delete", "propose", "propose-delete"].includes(action)) {
    const f = failure({ status: 400, where: "web app (the file form)", why: "The form named no action (create, write, delete, propose or propose-delete), so nothing was changed." });
    // No signed-in frame: it names the person, a lookup this refusal
    // shouldn't cost (web/test/final_sweep.test.mjs).
    return { status: 400, html: errorPage(f, { theme: ctx.theme, back: filePath(id, path) }) };
  }
  try {
    // One query in the transaction: the vault is checked inside it
    // (private.vault_ref, under RLS: RLV01 when the person can't see it), as
    // the MCP tools do. "create" follows the path's rule: a canon path
    // becomes a proposal, an open one a write (only the branch taken runs).
    const outcome = await asPerson(ctx.userId, async (c) => {
      const V = `(select private.vault_ref($1) as id offset 0) v`;
      if (action === "create") {
        const r = (
          await c.query(
            `select case when x.canon then public.propose(x.id, $2, $3, $4, false) end as pid,
                    case when not x.canon then public.write_file(x.id, $2, $3) end as written
               from (select v.id, (private.rule_for(v.id, $2)).policy = 'canon' as canon from ${V} offset 0) x`,
            [id, path, content, reason],
          )
        ).rows[0];
        return r.pid ? ({ kind: "proposed", pid: r.pid as string } as const) : ({ kind: "write" } as const);
      }
      if (action === "write") {
        await c.query(`select public.write_file(v.id, $2, $3) from ${V}`, [id, path, content]);
        return { kind: "write" } as const;
      }
      if (action === "delete") {
        await c.query(`select public.delete_file(v.id, $2) from ${V}`, [id, path]);
        return { kind: "delete" } as const;
      }
      const del = action === "propose-delete";
      const pid = (await c.query(`select public.propose(v.id, $2, $3, $4, $5) as id from ${V}`, [id, path, del ? null : content, reason, del]))
        .rows[0].id as string;
      return { kind: "proposed", pid } as const;
    });
    if (outcome.kind === "delete") {
      ctx.setFlash(`Deleted ${path}.`);
      return { redirect: vaultPath(id) };
    }
    if (outcome.kind === "proposed") {
      ctx.setFlash("Proposed. It applies once enough people approve it.");
      return { redirect: proposalPath(id, outcome.pid) };
    }
    ctx.setFlash(`Saved ${path}.`);
    return { redirect: filePath(id, path) };
  } catch (err) {
    if ((err as { code?: string }).code === "RLV01") return notFound(ctx);
    ctx.setFlash(message(err));
    return { redirect: path ? filePath(id, path) : vaultPath(id) };
  }
}

// ---------------------------------------------------------------------------
// Proposals

const STATES = [
  ["open", "Open"],
  ["changes_requested", "Changes requested"],
  ["applied", "Applied"],
  ["rejected", "Rejected"],
  ["stale", "Stale"],
] as const;

async function proposalList(ctx: Ctx, id: string): Promise<Reply> {
  const requested = ctx.url.searchParams.get("status");
  const status = STATES.find(([s]) => s === requested)?.[0] ?? "open";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const rows = (
      await c.query(
        // Quorums from one set-based rules_for() for the page, not
        // rule_for() per row.
        `with page as (
           select p.id, p.vault_id, p.kind, p.path, p.proposed_by, p.agent, p.created_at, p.revision, p.body,
                  row_number() over (order by p.created_at desc) as ord
             from public.proposals p where p.vault_id = $1 and p.status = $2 order by p.created_at desc limit 100)
         select p.*, cur.body as current_body, r.quorum,
                (select count(*) from public.approvals a where a.proposal_id = p.id and a.decision = 'approve'
                  and a.revision = p.revision)::int as approvals
           from page p
           join private.rules_for($1, array(select distinct path from page)) r on r.path = p.path
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          order by p.ord`,
        [id, status],
      )
    ).rows;
    const empty: Record<string, string> = {
      open: "Nothing waiting. When an agent proposes a change to a canon file, it shows up here.",
      changes_requested: "Nothing is waiting on a revision.",
      applied: "No proposals have been applied yet.",
      rejected: "No proposals have been rejected.",
      stale: "No stale proposals. One goes stale when its file changes before it’s approved.",
    };
    const body = html`
      ${pageHeader({ title: "Proposals" })}
      <nav class="tabs" aria-label="Proposal status">${STATES.map(
        ([s, label]) => html`<a href="${vaultPath(id, `/proposals?status=${s}`)}"${s === status ? raw(' aria-current="page"') : ""}>${label}</a>`,
      )}</nav>
      ${rows.length ? html`<ul class="rows">${rows.map((p) => reviewRow(ctx, p))}</ul>` : html`<div class="empty">${empty[status]}</div>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Proposals", data.shell, "vaults");
}

const STATE_TEXT: Record<string, string> = {
  open: "Open",
  changes_requested: "Changes requested",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};

async function proposalView(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const p = (
      await c.query(
        `select p.*, cur.body as current_body, (private.rule_for(p.vault_id, p.path)).quorum
           from public.proposals p
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          where p.id = $1 and p.vault_id = $2`,
        [pid, id],
      )
    ).rows[0];
    if (!p) return null;
    const approvals = (
      await c.query(`select user_id, decision, at from public.approvals where proposal_id = $1 and revision = $2 order by at`, [
        pid,
        p.revision,
      ])
    ).rows;
    const firstFromAgent = p.agent
      ? (
          await c.query(`select count(*)::int as n from public.proposals where vault_id = $1 and agent = $2 and created_at < $3`, [
            id,
            p.agent,
            p.created_at,
          ])
        ).rows[0].n === 0
      : false;
    const verb = p.kind === "delete" ? "Delete" : p.current_body === null ? "Create" : "Change";
    const approvers = approvals.filter((a) => a.decision === "approve");
    const mine = approvals.some((a) => a.user_id === ctx.userId);
    const flags = p.status === "open" || p.status === "changes_requested"
      ? risks(p, firstFromAgent ? [`First proposal from ${p.agent} in this vault`] : [])
      : [];
    const decidable = canWrite(v) && p.status === "open" && !mine;
    const rejectable = canWrite(v) && (decidable || p.status === "changes_requested");
    const editable = canWrite(v) && (p.status === "open" || p.status === "changes_requested") && p.kind === "write" && p.body !== null;
    // The proposer revises their own proposal (as their agent can over MCP):
    // a new revision, approved by nobody.
    const revisable = editable && p.proposed_by === ctx.userId;
    const thread = await threadSection(c, ctx, { vaultId: id, p, canWrite: canWrite(v) });
    const feedback = await latestFeedback(c, ctx, p);
    const snoozeForm = await snoozeControl(c, ctx, { vaultId: id, p, waitingOnMe: decidable });

    // The decision sits at the top, under the title, as on a GitHub pull
    // request: the note, then the verdicts, all visible without opening
    // anything. The diff follows immediately. (docs/research/ux-patterns.md)
    const controls = rejectable
      ? html`<form method="post" action="${proposalPath(id, pid, "/decide")}" class="panel decide" aria-label="Your review">
          ${csrfField(ctx.csrf)}
          <label for="note">Note <span class="hint">Required to request changes or reject. The proposer sees it.</span></label>
          <textarea id="note" name="note" class="note-field" rows="2"></textarea>
          <div class="actions">
            ${decidable
              ? html`<button class="primary" name="decision" value="approve">Approve</button>
                <button name="decision" value="request_changes">Request changes</button>`
              : ""}
            <button class="danger" name="decision" value="reject">Reject</button>
          </div>
        </form>`
      : "";
    const status =
      p.status === "stale" && canWrite(v) && p.kind === "write" && p.body !== null
        ? html`<div class="callout attention"><p>The file changed after this was proposed, so it wasn’t applied. You can propose the same text again against the current version; the diff will show what it would change now.</p>
            <form method="post" action="${proposalPath(id, pid, "/repropose")}">${csrfField(ctx.csrf)}
              <button class="primary">Propose again</button></form></div>`
        : p.status === "changes_requested"
          ? html`<p class="callout neutral">Waiting for the proposer to revise.${rejectable ? " You can still edit it yourself, or reject it." : ""}</p>`
          : p.status === "open" && mine
            ? html`<p class="callout neutral">You’ve decided on this revision. It needs more approvals before it applies.</p>`
            : "";

    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${vaultPath(id, "/proposals")}">Proposals</a></p>`,
        title: `${verb} ${p.path}`,
        path: true,
        badge: html`<span class="badge state ${p.status}">${STATE_TEXT[p.status]}</span>`,
        meta: html`<p class="meta"><span>Revision ${p.revision}</span>
          <span>By ${who(ctx, p.proposed_by, p.agent)}</span><span>${when(p.created_at)}</span></p>`,
        actions: html`${revisable ? html`<a class="button" href="${proposalPath(id, pid, "/revise")}">Revise</a>` : ""}${
          editable && rejectable ? html`<a class="button" href="${proposalPath(id, pid, "/edit")}">Edit, then approve</a>` : ""
        }`,
      })}
      <div class="review-top">
        ${p.proposed_by === ctx.userId && p.agent
          ? html`<p class="callout info">You’re reviewing a change your own agent (${p.agent}) proposed. That’s allowed: the agent can’t approve, you can.</p>`
          : ""}
        ${feedback}
        ${flags.length ? html`<ul class="risks" aria-label="Worth a closer look">${flags.map((f) => html`<li class="badge attention">${f}</li>`)}</ul>` : ""}
        ${status}${controls}${snoozeForm}
      </div>

      ${p.body === null && p.kind === "write"
        ? html`<div class="empty">This proposal’s content was erased.</div>`
        : diffSection({
            before: p.current_body,
            after: p.kind === "delete" ? null : p.body,
            mode: diffMode(ctx.url.searchParams),
            href: (m) => proposalPath(id, pid, `?diff=${m}`),
          })}

      <h2>${p.agent ? "Agent’s stated reason (unverified)" : "Reason"}</h2>
      <blockquote class="claim">${p.reason || "No reason given."}</blockquote>

      <h2>Approvals</h2>
      <p>${approvers.length} of ${p.quorum} for revision ${p.revision}${
        approvers.length ? `: ${approvers.map((a) => who(ctx, a.user_id, null)).join(", ")}` : "."
      }</p>

      ${thread}`;
    return { v, p, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Proposal: ${data.p.path}`, data.shell, "vaults");
}

async function proposalEdit(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const p = (
      await c.query(
        `select * from public.proposals where id = $1 and vault_id = $2 and kind = 'write'
            and status in ('open', 'changes_requested') and body is not null`,
        [pid, id],
      )
    ).rows[0];
    if (!p) return null;
    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${proposalPath(id, pid)}">Back to the proposal</a></p>`,
        title: "Edit, then approve",
        path: true,
        actions: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>
          <button class="primary" form="edit-approve">Save edit and approve</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving records your edit as a new revision and approves it. If this path needs more than one approval, the others approve your edited version.</p>
      <form method="post" action="${proposalPath(id, pid, "/edit")}" class="panel" id="edit-approve">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="note">What you changed</label>
        <input id="note" type="text" name="note" placeholder="Optional, for the history">
        <div class="actions"><button class="primary">Save edit and approve</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Edit, then approve", data.shell, "vaults");
}

// Revising your own proposal: the same editor, without approving. The
// database only lets the proposer (or their agent) revise.
async function proposalRevise(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const p = (
      await c.query(
        `select * from public.proposals where id = $1 and vault_id = $2 and kind = 'write' and proposed_by = $3
            and status in ('open', 'changes_requested') and body is not null`,
        [pid, id, ctx.userId],
      )
    ).rows[0];
    if (!p) return null;
    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${proposalPath(id, pid)}">Back to the proposal</a></p>`,
        title: "Revise your proposal",
        path: true,
        actions: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>
          <button class="primary" form="revise-proposal">Save revision</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving makes it revision ${p.revision + 1} and sends it back for review; approvals of earlier revisions no longer count.</p>
      <form method="post" action="${proposalPath(id, pid, "/revise")}" class="panel" id="revise-proposal">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="reason">What changed</label>
        <input id="reason" type="text" name="reason" placeholder="Optional, for the reviewers">
        <div class="actions"><button class="primary">Save revision</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Revise your proposal", data.shell, "vaults");
}

async function reviseProposal(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const revision = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.revise_proposal($1, $2, $3) as r`, [
            pid,
            (ctx.form.get("content") ?? "").replaceAll("\r\n", "\n"),
            ctx.form.get("reason") || null,
          ])
        ).rows[0].r as number,
    );
    ctx.setFlash(`Revised. This is revision ${revision}, waiting for review again.`);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

const DECIDED: Record<string, string> = {
  applied: "Approved and applied.",
  open: "Approved. It needs more approvals before it applies.",
  rejected: "Rejected. The file is unchanged.",
  changes_requested: "Changes requested. The proposer can see your note and revise.",
  stale: "The file changed after this was proposed, so it was marked stale instead of applied.",
};

async function decide(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const d = ctx.form.get("decision");
  const decision = d === "reject" || d === "request_changes" ? d : "approve";
  try {
    const result = await asPerson(
      ctx.userId,
      async (c) => (await c.query(`select public.decide($1, $2, $3) as r`, [pid, decision, ctx.form.get("note") || null])).rows[0].r as string,
    );
    ctx.setFlash(DECIDED[result] ?? result);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

async function editAndApprove(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const result = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.edit_and_approve($1, $2, $3) as r`, [
            pid,
            (ctx.form.get("content") ?? "").replaceAll("\r\n", "\n"),
            ctx.form.get("note") || null,
          ])
        ).rows[0].r as string,
    );
    ctx.setFlash(DECIDED[result] ?? result);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

async function repropose(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const next = await asPerson(ctx.userId, async (c) => {
      const p = (
        await c.query(`select * from public.proposals where id = $1 and vault_id = $2 and status = 'stale' and kind = 'write'`, [pid, id])
      ).rows[0];
      if (!p || p.body === null) return null;
      return (await c.query(`select public.propose($1, $2, $3, $4) as id`, [id, p.path, p.body, `Proposed again: ${p.reason}`])).rows[0]
        .id as string;
    });
    if (!next) return notFound(ctx);
    ctx.setFlash("Proposed again against the current version.");
    return { redirect: proposalPath(id, next) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: proposalPath(id, pid) };
  }
}

// ---------------------------------------------------------------------------
// Rules, search, activity

// `form` is the Add form as it was sent, when saving it was refused: the
// refusal is shown in the form, with its reference, and the typed values kept.
type RuleForm = { path: string; policy: string; quorum: string; error: string };

async function rules(ctx: Ctx, id: string, form?: RuleForm): Promise<Reply> {
  const check = (ctx.url.searchParams.get("check") ?? "").trim();
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const list = (
      await c.query(
        `select pp.path, pp.policy, pp.quorum,
                (select l.actor from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                  and l.path = pp.path order by l.seq desc limit 1) as set_by,
                (select l.at from public.log l where l.vault_id = pp.vault_id and l.event = 'policy.set'
                  and l.path = pp.path order by l.seq desc limit 1) as set_at
           from public.path_policies pp where pp.vault_id = $1 order by pp.path`,
        [id],
      )
    ).rows;
    const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
    const checked = check ? await ruleFor(c, id, check) : null;
    const owner = v.role === "owner";
    const body = html`
      ${pageHeader({ title: "Rules" })}
      <p class="lede">Everything is ${tag(def)} unless a rule says otherwise. A rule on a folder (ending in <code>/</code>) covers everything inside it; the most specific rule wins. Canon changes need approval from people. Agents can only propose them.</p>
      ${owner
        ? html`<form method="post" action="${vaultPath(id, "/rules")}" class="panel" id="add-rule" aria-labelledby="add-rule-title">
            <h2 id="add-rule-title" class="form-title">Add or change a rule</h2>
            ${csrfField(ctx.csrf)}
            ${form ? html`<p class="callout danger" role="alert" id="rule-error">${form.error}</p>` : ""}
            <div class="fields">
              <div><label for="pp">Path or folder</label><input id="pp" type="text" name="path" placeholder="clients/" required value="${form?.path ?? ""}"${form ? html` aria-invalid="true" aria-describedby="rule-error"` : ""}></div>
              <div><label for="pol">Policy</label><select id="pol" name="policy"><option value="canon">Canon</option><option value="open"${form?.policy === "open" ? " selected" : ""}>Open</option></select></div>
              <div><label for="qq">Approvals</label><input id="qq" class="narrow" type="text" name="quorum" value="${form?.quorum ?? "1"}" inputmode="numeric"></div>
            </div>
            <div class="actions"><button class="primary">Save rule</button></div>
          </form>`
        : html`<p class="muted small">Only owners change rules.</p>`}
      <form method="get" action="${vaultPath(id, "/rules")}" class="panel">
        <label for="check">What applies to a path?</label>
        <div class="inline-field"><input id="check" type="text" name="check" value="${check}" placeholder="clients/acme/brief.md">
          <button>Check</button></div>
        ${checked
          ? html`<p class="result"><code>${check}</code> is ${tag(checked.rule?.policy ?? checked.def)} ${
              checked.rule
                ? html`from the rule on <code>${checked.rule.path}</code>${
                    checked.rule.policy === "canon"
                      ? `, and changes need ${checked.rule.quorum} approval${checked.rule.quorum > 1 ? "s" : ""}`
                      : ""
                  }.`
                : "by the vault default."
            }</p>`
          : ""}
      </form>
      ${list.length === 0
        ? html`<div class="empty">No rules yet.${owner ? " Add one above, for example to make a clients/ folder canon." : ""}</div>`
        : html`<div class="table-wrap"><table><tr><th>Path</th><th>Policy</th><th class="num">Approvals</th><th class="hide-sm">Set</th>${owner ? html`<th></th>` : ""}</tr>
          ${list.map(
            (r) => html`<tr><td><code>${r.path}</code></td><td>${tag(r.policy)}</td>
              <td class="num">${r.policy === "canon" ? r.quorum : ""}</td>
              <td class="small muted hide-sm">${r.set_at ? `${who(ctx, r.set_by, null)}, ${ago(r.set_at)}` : ""}</td>
              ${owner
                ? html`<td class="num"><form method="post" action="${vaultPath(id, "/rules")}">${csrfField(ctx.csrf)}
                    <input type="hidden" name="path" value="${r.path}"><input type="hidden" name="policy" value="">
                    <button class="quiet">Remove</button></form></td>`
                : ""}</tr>`,
          )}</table></div>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "rules" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Rules", data.shell, "vaults"), ...(form ? { status: 400 } : {}) };
}

async function setRule(ctx: Ctx, id: string): Promise<Reply> {
  const path = (ctx.form.get("path") ?? "").trim();
  const policy = ctx.form.get("policy") || null;
  const quorum = Math.max(1, Math.min(20, Number(ctx.form.get("quorum") ?? 1) || 1));
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_policy($1, $2, $3, $4)`, [id, path, policy, quorum]));
    ctx.setFlash(policy ? `${path} is now ${policy}.` : `Rule on ${path} removed.`);
  } catch (err) {
    // A path the database won't take (22023, 20260926120000_rule_paths.sql):
    // the page again, with the reason in the form and what was typed kept.
    // Other refusals (not an owner) come back as a notice, as before.
    if (policy && (err as { code?: string }).code === "22023") {
      return rules(ctx, id, { path, policy, quorum: String(quorum), error: message(err) });
    }
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/rules") };
}

async function search(ctx: Ctx, id: string): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim();
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    // Only the start of each text, for its snippet: 30 whole files could be 30 MB.
    const rows = query ? (await c.query(`select path, policy, left(body, 4000) as body from public.search($1, $2, 30)`, [id, query])).rows : [];
    const body = html`
      ${pageHeader({ title: "Search" })}
      ${query
        ? rows.length
          ? html`<p class="muted small">${rows.length} result${rows.length > 1 ? "s" : ""} for “${query}”</p>
            <ul class="rows results">${rows.map(
              (r) => html`<li><span><a class="name" href="${filePath(id, r.path)}">${r.path}</a> ${tag(r.policy)}
                <span class="snippet">${(r.body as string).replace(/\s+/g, " ").slice(0, 200)}</span></span></li>`,
            )}</ul>`
          : html`<div class="empty">Nothing matches “${query}”. Try fewer words, or part of a file name.</div>`
        : html`<p class="muted">Search file names and text. Use quotes for a phrase, or <code>or</code> between words.</p>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "search" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, query ? `Search: ${query}` : "Search", data.shell, "vaults");
}

async function activity(ctx: Ctx, id: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const body = html`
      ${pageHeader({ title: "Activity" })}
      <p class="lede">Every change to this vault, newest first. This log can only be added to: nothing in it is ever edited or deleted.</p>
      ${await activityBody(c, { me: ctx.userId, url: ctx.url, base: vaultPath(id, "/activity"), scope: { vaultId: id } })}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "activity" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Activity", data.shell, "vaults");
}

async function allActivity(ctx: Ctx): Promise<Reply> {
  const body = await asPerson(ctx.userId, (c) =>
    activityBody(c, { me: ctx.userId, url: ctx.url, base: "/activity", scope: {}, showVault: true }),
  );
  return render(
    ctx,
    "Activity",
    html`${pageHeader({ title: "Activity" })}
    <p class="lede">What people and agents did across your vaults, newest first. Only vaults you’re a member of appear here.</p>
    ${body}`,
    "activity",
  );
}

// ---------------------------------------------------------------------------
// Connect

function connect(ctx: Ctx): Reply {
  const url = ctx.mcpUrl;
  const helper = JSON.stringify({ reliquary: { type: "http", url, headersHelper: "/path/to/reliquary/mcp/headers-helper.sh" } }, null, 2);
  const cursorConfig = { url, headers: { Authorization: "Bearer ${env:RELIQUARY_TOKEN}" } };
  const cursorJson = JSON.stringify({ mcpServers: { reliquary: cursorConfig } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=reliquary&config=${q(
    Buffer.from(JSON.stringify(cursorConfig)).toString("base64"),
  )}`;
  const vscodeJson = JSON.stringify(
    {
      inputs: [{ type: "promptString", id: "reliquary-token", description: "Reliquary access token", password: true }],
      servers: { reliquary: { type: "http", url, headers: { Authorization: "Bearer ${input:reliquary-token}" } } },
    },
    null,
    2,
  );
  return render(
    ctx,
    "Connect",
    html`${pageHeader({ title: "Connect an agent", actions: html`<a class="button primary" href="/tokens">Create a token</a>` })}
    <p class="lede">Any MCP client can use your vaults through one URL. Clients that support sign-in (Claude Code, Claude.ai, ChatGPT) connect with your Reliquary account: you choose which vaults they reach and whether they can write. Others use a <a href="/tokens">token</a>. Either way the agent acts as you, but can never approve, change rules or manage members.</p>
    <p class="endpoint"><span class="muted small">MCP URL</span><code>${url}</code></p>
    <nav class="tabs" aria-label="Clients"><a href="#claude-code">Claude Code</a><a href="#chat">Claude.ai and ChatGPT</a><a href="#cursor">Cursor</a><a href="#vscode">VS Code</a><a href="#hermes">Hermes and others</a><a href="#cli">Environment variables</a></nav>

    <section id="claude-code"><h2>Claude Code (app or CLI)</h2>
      <p>On each computer, add Reliquary once for your user:</p>
      <pre class="code">claude mcp add --transport http --scope user reliquary ${url}</pre>
      <p>Then in Claude Code run <code>/mcp</code>, choose <strong>reliquary</strong> and <strong>Authenticate</strong>. Your browser opens Reliquary: sign in, pick the vaults and access, and approve. Claude Code keeps the connection and refreshes it by itself. Revoke it any time on the <a href="/tokens">Tokens</a> page.</p></section>

    <section id="chat"><h2>Claude.ai and ChatGPT</h2>
      <p><strong>Claude.ai:</strong> Settings, Connectors, <strong>Add custom connector</strong>. Name it Reliquary and paste the MCP URL. Claude sends you here to sign in and approve.</p>
      <p><strong>ChatGPT:</strong> Settings, Apps and Connectors, turn on developer mode under Advanced, then create a connector with the MCP URL and OAuth authentication. ChatGPT sends you here to sign in and approve.</p></section>

    <section id="cursor"><h2>Cursor</h2>
      <p class="callout info">Tokens are for clients without sign-in. Keep them out of config files and chats: anything an agent can read, it can leak. The setups below read the token from an environment variable or a password prompt.</p>
      <p>Create a token on the <a href="/tokens">Tokens</a> page, set it as <code>RELIQUARY_TOKEN</code> in the environment Cursor starts from, then <a href="${cursorLink}">add Reliquary to Cursor</a>. If the link doesn’t open, put this in <code>~/.cursor/mcp.json</code>:</p>
      <pre class="code">${cursorJson}</pre></section>

    <section id="vscode"><h2>VS Code</h2>
      <p>Add this to <code>.vscode/mcp.json</code>. VS Code asks for a token from the <a href="/tokens">Tokens</a> page once and stores it securely.</p>
      <pre class="code">${vscodeJson}</pre></section>

    <section id="hermes"><h2>Hermes and other clients</h2>
      <p>Use Streamable HTTP with the MCP URL and this header, reading the token from wherever the client keeps secrets:</p>
      <pre class="code">Authorization: Bearer &lt;your token&gt;</pre>
      <details><summary>Local development (a Reliquary checkout on this machine)</summary>
        <p>With <code>./mcp/dev.sh token "Claude Code on Linux"</code> the token stays in a file, and Claude Code reads it through a helper at connect time. Add this under <code>mcpServers</code> in <code>~/.claude.json</code>:</p>
        <pre class="code">${helper}</pre></details></section>

    <section id="cli"><h2>Environment variables (the Reliquary CLI)</h2>
      <p>Your programs get a vault’s variables through the CLI, never through an agent. Sign this computer in once; your browser opens Reliquary to choose which vaults it reads:</p>
      <pre class="code">npx @reliquary-ai/cli login</pre>
      <p>Then run a command with one environment’s variables, written nowhere on disk:</p>
      <pre class="code">npx @reliquary-ai/cli run --env development -- &lt;command&gt;</pre>
      <p>Or write them to a <code>.env</code> file, which the CLI only does where git ignores it:</p>
      <pre class="code">npx @reliquary-ai/cli env pull --env development</pre>
      <p>To add a project’s <code>.env</code> to the vault, send it; you apply it on the Variables page, where only names are shown. An agent can run this for you without ever seeing a value:</p>
      <pre class="code">npx @reliquary-ai/cli env push --env development --file .env</pre>
      <p class="small muted">Add <code>--vault &lt;name&gt;</code> if you belong to more than one vault. The sign-in is on the <a href="/tokens">Tokens</a> page as Reliquary CLI; revoke it there. Set values on a vault’s Variables page.</p></section>`,
    "connect",
  );
}

// ---------------------------------------------------------------------------
// Tokens

// Scope (which vaults, read or read-write) is enforced by the database for
// every call the token makes, and can't be edited: revoke and recreate. The
// token itself is shown once, in this response only, and never logged.
async function tokens(ctx: Ctx, fresh?: { name: string; token: string }): Promise<Reply> {
  const { rows, vaults } = await asPerson(ctx.userId, async (c) => ({
    rows: (
      await c.query(
        `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
                t.all_vaults, t.access, t.kind, t.env_push, t.client_name, t.expires_at <= now() as expired,
                cardinality(t.vault_ids) as n_vaults,
                (select array_agg(v.name order by v.name) from public.vaults v
                  where v.id = any(t.vault_ids)) as vault_names
           from public.access_tokens t
          order by t.revoked_at nulls first, (t.expires_at <= now()), t.created_at desc`,
      )
    ).rows,
    vaults: (
      await c.query(
        `select v.id, v.name from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by v.name`,
        [ctx.userId],
      )
    ).rows as { id: string; name: string }[],
  }));

  const scope = (t: { all_vaults: boolean; n_vaults: number; vault_names: string[] | null }) => {
    if (t.all_vaults) return "All your vaults";
    const names = t.vault_names ?? [];
    const gone = t.n_vaults - names.length;
    return names.join(", ") + (gone > 0 ? `${names.length ? ", and " : ""}${gone} you no longer belong to` : "");
  };
  const status = (t: { id: string; revoked_at: Date | null; expired: boolean }) =>
    t.revoked_at
      ? html`<span class="muted small">Revoked</span>`
      : t.expired
        ? html`<span class="muted small">Expired</span>`
        : html`<form method="post" action="/tokens/${t.id}/revoke">${csrfField(ctx.csrf)}<button class="danger">Revoke</button></form>`;

  return render(
    ctx,
    "Tokens",
    html`${pageHeader({ title: "Tokens", actions: html`<button class="primary" form="new-token">Create token</button>` })}
    <p class="lede">A token lets one agent act as you over MCP, in the vaults you choose. A read-only agent can read, search and follow changes. A read-write agent can also write open files and propose changes. No agent can approve, change rules or manage members. <a href="/connect">How to connect an agent</a></p>
    ${fresh
      ? html`<div class="callout attention reveal" role="status"><strong>${fresh.name}</strong>
          <p class="muted small">Copy it now. It won’t be shown again. Put it in your agent’s settings, never in a chat.</p>
          <p class="secret">${fresh.token}</p></div>`
      : ""}
    <form method="post" action="/tokens/new" class="panel token-form" id="new-token">
      ${csrfField(ctx.csrf)}
      <label for="tn">Name it after the agent and machine</label>
      <input id="tn" type="text" name="name" placeholder="Hermes on Linux" required maxlength="100">
      <fieldset>
        <legend>Vaults</legend>
        <label class="choice"><input type="radio" name="scope" value="all" checked> All my vaults, including ones I join later</label>
        <label class="choice"><input type="radio" name="scope" value="some"> Only the vaults I tick</label>
        ${vaults.length
          ? html`<div class="choice-list">${vaults.map(
              (v) => html`<label class="choice"><input type="checkbox" name="vault" value="${v.id}"> ${v.name}</label>`,
            )}</div>`
          : html`<p class="hint">You don’t belong to any vaults yet. <a href="/vaults/new">Create one</a>.</p>`}
        <p class="hint">Ticking a vault limits the token to the ticked vaults.</p>
      </fieldset>
      <fieldset>
        <legend>Access</legend>
        <label class="choice"><input type="radio" name="access" value="read" checked> Read only: read, search and follow changes</label>
        <label class="choice"><input type="radio" name="access" value="write"> Read and write: also write open files and propose changes</label>
      </fieldset>
      <label for="te">Expires after</label>
      <select id="te" name="days" class="token-expiry">
        ${[7, 30, 90, 180, 366].map((d) => html`<option value="${d}"${d === 90 ? raw(" selected") : ""}>${d === 366 ? "1 year" : `${d} days`}</option>`)}
      </select>
      <div class="actions"><button class="primary">Create token</button></div>
      <p class="hint">A token’s vaults and access can’t be changed later. To change them, revoke it and create another.</p>
    </form>
    <h2>Your tokens</h2>
    ${rows.length === 0
      ? html`<div class="empty">No tokens yet. <a href="/connect">Connect an agent</a> to get started.</div>`
      : html`<div class="table-wrap"><table class="token-list"><tr><th>Name</th><th>Vaults</th><th>Access</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr>
    ${rows.map(
      (t) => html`<tr${t.revoked_at || t.expired ? raw(' class="inactive"') : ""}><td>${t.name}</td>
        <td class="small">${scope(t)}</td>
        <td class="small">${t.kind === "cli" ? (t.env_push ? "Environment variables (reads; sends for approval)" : "Environment variables") : t.access === "write" ? "Read and write" : "Read only"}</td>
        <td class="small">${t.last_used_at ? ago(t.last_used_at) : "Never"}${t.client_name
          ? html`<span class="muted token-client">from ${t.client_name}</span>`
          : ""}</td>
        <td class="small hide-sm">${when(t.expires_at)}</td>
        <td class="num">${status(t)}</td></tr>`,
    )}</table></div>`}`,
    "tokens",
  );
}

async function createToken(ctx: Ctx): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  // Ticked vaults always narrow the scope, whatever the radio says: a
  // mismatch between the two must never produce the broader token.
  const ticked = ctx.form.getAll("vault");
  const some = ticked.length > 0 || ctx.form.get("scope") === "some";
  const access = ctx.form.get("access") === "write" ? "write" : "read";
  const days = Number.parseInt(ctx.form.get("days") ?? "90", 10);
  if (some && ticked.length === 0) {
    ctx.setFlash("Tick at least one vault, or choose all your vaults.");
    return { redirect: "/tokens" };
  }
  if (!ticked.every((v) => UUID.test(v))) return notFound(ctx);
  try {
    const token = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.create_access_token($1, $2, $3::uuid[], $4) as t`, [
            name,
            Number.isFinite(days) ? days : null,
            some ? ticked : null,
            access,
          ])
        ).rows[0].t as string,
    );
    return tokens(ctx, { name, token });
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: "/tokens" };
  }
}

async function revokeToken(ctx: Ctx, tid: string): Promise<Reply> {
  if (!UUID.test(tid)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_access_token($1)`, [tid]));
    ctx.setFlash("Token revoked. Any agent using it is cut off on its next request.");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: "/tokens" };
}

// ---------------------------------------------------------------------------

// A GET page runs in one transaction (db.ts, readOnlyRequest): the Review
// badge's count below and every query the page makes. Not the OAuth
// consent page: it fetches the client's metadata over the network, and a
// transaction mustn't stay open across that.
export async function routes(ctx: Ctx): Promise<Reply> {
  const shared = ctx.method === "GET" && ctx.url.pathname !== "/oauth/authorize";
  // The people a page names, by email where the reader may see it, in one
  // lookup (people.ts), inside the page's own transaction on a GET.
  const run = async (): Promise<Reply> => {
    const reply = await route(ctx);
    return reply.html ? { ...reply, html: await fillPeople(ctx.userId, reply.html) } : reply;
  };
  return shared ? readOnlyRequest(ctx.userId, run) : run();
}

async function route(ctx: Ctx): Promise<Reply> {
  const p = ctx.url.pathname;
  const get = ctx.method === "GET";
  // The Review badge is only drawn on pages: a POST almost always redirects,
  // so it doesn't pay for the count.
  if (get) ctx.reviewCount = await reviewCount(ctx.userId);
  if (get && p === "/") return home(ctx);
  if (get && p === "/review") return review(ctx);
  if (get && p === "/activity") return allActivity(ctx);
  if (get && p === "/connect") return connect(ctx);
  if (get && p === "/tokens") return tokens(ctx);
  if (get && p === "/account") return accountPage(ctx);
  if (get && p === "/vaults/new") return newVault(ctx);
  if (!get && p === "/vaults/new") return createVault(ctx);
  if (!get && p === "/tokens/new") return createToken(ctx);
  let m = /^\/tokens\/([^/]+)\/revoke$/.exec(p);
  if (!get && m) return revokeToken(ctx, m[1]);
  if (p === "/oauth/authorize") return authorize(ctx);
  if (p === "/invite") return inviteRoutes(ctx);

  m = /^\/v\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return notFound(ctx);
  const [, id, rest = ""] = m;
  if (!UUID.test(id)) return notFound(ctx);
  if (get && rest === "") return folder(ctx, id, "");
  if (get && rest === "/tree") return folder(ctx, id, ctx.url.searchParams.get("path") ?? "");
  if (get && rest === "/file") return fileView(ctx, id);
  if (!get && rest === "/file") return fileAction(ctx, id);
  if (get && rest === "/edit") return editView(ctx, id);
  if (get && rest === "/new") return newFile(ctx, id);
  if (get && rest === "/proposals") return proposalList(ctx, id);
  if (get && (rest === "/activity" || rest === "/log")) return activity(ctx, id);
  if (get && rest === "/rules") return rules(ctx, id);
  if (!get && rest === "/rules") return setRule(ctx, id);
  if (get && rest === "/search") return search(ctx, id);
  if (rest === "/variables" || rest.startsWith("/variables/")) return variablesRoutes(ctx, id, rest);
  if (rest === "/config" || rest.startsWith("/config/") || rest === "/erase") return adminRoutes(ctx, id, rest);
  const pm = /^\/proposals\/([^/]+)(\/[a-z]+)?$/.exec(rest);
  if (pm) {
    const [, pid, action = ""] = pm;
    if (get && action === "") return proposalView(ctx, id, pid);
    if (get && action === "/edit") return proposalEdit(ctx, id, pid);
    if (!get && action === "/edit") return editAndApprove(ctx, id, pid);
    if (get && action === "/revise") return proposalRevise(ctx, id, pid);
    if (!get && action === "/revise") return reviseProposal(ctx, id, pid);
    if (!get && action === "/decide") return decide(ctx, id, pid);
    if (!get && action === "/repropose") return repropose(ctx, id, pid);
    if (!get && action === "/comment") return postComment(ctx, id, pid, () => notFound(ctx));
    if (!get && action === "/snooze") return snooze(ctx, id, pid, () => notFound(ctx));
    if (!get && action === "/unsnooze") return unsnooze(ctx, id, pid, () => notFound(ctx));
  }
  return notFound(ctx);
}
