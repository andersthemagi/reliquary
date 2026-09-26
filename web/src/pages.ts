// Pages. Each handler runs its queries as the signed-in person (no agent
// claim) through asPerson(); the database decides what they may see and do.
// Structure follows docs/research/ux-patterns.md.

import type { Writable } from "node:stream";
import type pg from "pg";
import type { Session } from "./auth.js";
import { asPerson, readOnlyRequest } from "./db.js";
import { authorize } from "./oauth.js";
import { activityBody } from "./activity.js";
import { callout, csrfField, emptyState, html, page, pageHeader, time, type Nav, type Raw, type Shell, type Theme } from "./html.js";
import { loadShell } from "./inbox.js";
import { searchAll } from "./search.js";
import { accountSettings, changeEmail, deleteAccount, deleteAccountPage, saveDisplayName, signOutEverywhere } from "./settings.js";
import { errorPage, refusalText } from "./errorpage.js";
import { failure } from "./failure.js";
import type { Flash, Tone } from "./flash.js";
import { fillPeople, personRef } from "./people.js";
import { pendingList, variablesRoutes } from "./variablespage.js";
import { pendingPushes } from "./variables.js";
import { adminRoutes } from "./vaultadmin.js";
import { deletionNotices, inviteRoutes } from "./members.js";
import { applyTemplate, templateById, templateChoices } from "./templates.js";
import { NO_LIMIT_COUNT, accountPage, myAdmission, myPlan, notAdmittedNote, type Plan } from "./plans.js";
import { OPERATOR } from "./site.js";
import { NOT_SNOOZED_SQL, postComment, snooze, snoozedList, snoozedSection, unsnooze } from "./thread.js";
import { editView, fileAction, fileView, folder, newFile, vaultShell } from "./files.js";
import {
  decide,
  editAndApprove,
  proposalEdit,
  proposalList,
  proposalRevise,
  proposalView,
  repropose,
  reviewRow,
  reviseProposal,
} from "./proposals.js";
import { rules, search, setRule } from "./rules.js";
import { accessRoutes } from "./access.js";

export type Ctx = {
  userId: string;
  csrf: string;
  url: URL;
  form: URLSearchParams;
  method: string | undefined;
  flash?: Flash; // the message a form left for this page, with its tone (flash.ts)
  theme: Theme;
  mcpUrl: string;
  reviewCount?: number; // proposals waiting on this person (the shell's count), on GET pages
  shell?: Shell; // the top bar's data, loaded once per GET page (inbox.ts)
  // A message for the next page. Say "success" for something done; a
  // refusal (message(err), ending in its ref) is danger without saying so.
  setFlash: (message: string, tone?: Tone) => void;
  ip: string; // the client's address, for rate limits only (ratelimit.ts)
  // The browser session behind the request (auth.ts), for what Account
  // settings asks of Supabase Auth: sign out everywhere, change of email. Absent where a
  // page is built without a request (tests).
  session?: Pick<Session, "signOutEverywhere" | "signOut" | "pendingEmail" | "changeEmail">;
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
export const tag = (policy: string) =>
  html`<span class="badge policy ${policy}">${policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy}</span>`;
export const canWrite = (v: Vault) => v.role === "owner" || v.role === "editor";

export const q = encodeURIComponent;
export const vaultPath = (id: string, rest = "") => `/v/${id}${rest}`;
export const filePath = (id: string, path: string, tab?: string) =>
  `/v/${id}/file?path=${q(path)}${tab ? `&tab=${tab}` : ""}`;
export const treePath = (id: string, dir: string) => (dir ? `/v/${id}/tree?path=${q(dir)}` : `/v/${id}`);
export const proposalPath = (id: string, pid: string, rest = "") => `/v/${id}/proposals/${pid}${rest}`;

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
      shell: ctx.shell,
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
      user: ctx.userId, flash: ctx.flash, theme: ctx.theme, csrf: ctx.csrf, path: "/", shell: ctx.shell,
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


// ---------------------------------------------------------------------------
// Home and Review

// "You own 2 of 5 vaults on the Free plan": the vaults counted against the
// plan are the ones the person created (plans.ts, myPlan).
const vaultWord = (n: number) => (n === 1 ? "vault" : "vaults");
const planFull = (p: Plan) => p.vaultsOwned >= p.maxVaults;
function ownedLine(p: Plan): string {
  if (p.maxVaults >= NO_LIMIT_COUNT) return `You own ${p.vaultsOwned} ${vaultWord(p.vaultsOwned)} on the ${p.planName} plan, which has no limit`;
  return `You own ${p.vaultsOwned} of ${p.maxVaults} ${vaultWord(p.maxVaults)} on the ${p.planName} plan`;
}
const ROLE_LABEL: Record<string, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

async function home(ctx: Ctx): Promise<Reply> {
  const waitingCount = ctx.reviewCount ?? 0;
  const counts = ctx.shell?.counts;
  const { vaults, waiting, plan, gone } = await asPerson(ctx.userId, async (c) => ({
    plan: await myPlan(c),
    // Each vault with what a person compares across them: their role, its
    // files, the proposals open in it, and when anything last happened
    // there (its newest log row, from the log's (vault_id, seq) key), most
    // recently active first.
    vaults: (
      await c.query(
        `select v.id, v.name, m.role,
                (select count(*) from public.files f where f.vault_id = v.id and f.deleted_at is null)::int as files,
                (select count(*) from public.proposals p where p.vault_id = v.id and p.status = 'open')::int as open,
                coalesce((select l.at from public.log l where l.vault_id = v.id order by l.seq desc limit 1), v.created_at) as updated
           from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by updated desc, v.name`,
        [ctx.userId],
      )
    ).rows as { id: string; name: string; role: string; files: number; open: number; updated: Date }[],
    // Asked only when the top bar's count says something waits, or there
    // are notices to show (and so take).
    waiting: waitingCount > 0 ? (await c.query(waitingSql("q.created_at", 5), [ctx.userId])).rows : [],
    gone: (counts?.notices ?? 1) > 0 ? await deletionNotices(c) : html``,
  }));
  const invites = counts?.invites ?? 0;
  const full = planFull(plan);
  // One primary per page: New vault. Review, when something waits, sits
  // before it as a secondary button. At the plan's limit New vault is a
  // secondary button: it leads to the page that says why and what to do.
  // A section with nothing in it isn't shown: what needs the person is in
  // the inbox. The title is the nav item's name, Home.
  return render(
    ctx,
    "Home",
    html`${pageHeader({
      title: "Home",
      description: "Shared context your agents read and propose to. Changes to canon files wait for your approval.",
      meta: html`<p class="meta plan-line"><span>${ownedLine(plan)}${full ? html` <span class="badge warning">At the limit</span>` : ""}</span><span><a href="/account">Plan and usage</a></span></p>`,
      secondary: waitingCount > 0 ? html`<a class="button" href="/inbox">Review ${waitingCount} waiting</a>` : "",
      primary: full ? html`<a class="button" href="/vaults/new">New vault</a>` : html`<a class="button primary" href="/vaults/new">New vault</a>`,
    })}
    ${gone}
    ${waiting.length
      ? html`<h2>Needs your review</h2>
        <ul class="rows">${waiting.map((p) => reviewRow(ctx, p, true))}</ul>
        ${waitingCount > waiting.length ? html`<p class="small"><a href="/inbox">All ${waitingCount} waiting</a></p>` : ""}`
      : ""}
    <h2>Your vaults</h2>
    ${vaults.length === 0
      ? html`<div class="empty first-vault"><strong>Create your first vault.</strong>
          <p>A vault holds the files you and your agents share: notes, briefs, decisions. You choose which of them are canon, so an agent can only propose changes and you approve them.</p>
          <p>Start blank, or from a template: a client engagement, personal projects or a product team, with folders, rules and a README that tells agents how to work there.</p>
          <p><a class="button" href="/vaults/new">Create your first vault</a></p>
          <p class="small">Joining someone else’s vault? Open the invite link they sent you. It works once you’re signed in with the address it was sent to.${
            invites ? html` You have ${invites === 1 ? "an invite" : `${invites} invites`} waiting: <a href="/inbox#invites">see your inbox</a>.` : ""}</p></div>`
      : html`<div class="table-wrap"><table class="vault-list table-stack">
        <thead><tr><th>Name</th><th>Your role</th><th class="num">Files</th><th class="num">Open proposals</th><th>Updated</th></tr></thead>
        <tbody>${vaults.map(
          (v) => html`<tr>
            <td data-label="Name" class="vault-name"><a href="${vaultPath(v.id)}">${v.name}</a></td>
            <td data-label="Your role">${ROLE_LABEL[v.role] ?? v.role}</td>
            <td data-label="Files" class="num">${v.files}</td>
            <td data-label="Open proposals" class="num">${v.open
              ? html`<a href="${vaultPath(v.id, "/proposals")}" aria-label="${v.open} open ${v.open === 1 ? "proposal" : "proposals"} in ${v.name}">${v.open}</a>`
              : html`<span class="muted">0</span>`}</td>
            <td data-label="Updated">${time(v.updated)}</td>
          </tr>`,
        )}</tbody></table></div>`}`,
    "home",
  );
}

// ---------------------------------------------------------------------------
// New vault. The database decides who may create one (a person, or their
// agent through an all-vaults read-write token); here it is always the
// person. They become its owner.

// A refused create that the page explains on its own (the plan's vault
// limit, RLP01; not admitted, RLP02) comes back as ?refused=<ref>, not as a
// flash, so the reason is said once, with the reference beside it.
const REF = /^[0-9a-f]{8}$/;
const refusedLine = (ref: string) =>
  html`<p class="small refused-ref">Your vault wasn’t created, for this reason (ref <code>${ref}</code>).</p>`;

async function newVault(ctx: Ctx): Promise<Reply> {
  const { plan, admission } = await asPerson(ctx.userId, async (c) => ({ plan: await myPlan(c), admission: await myAdmission(c) }));
  const full = planFull(plan);
  const blocked = !admission.admitted || full;
  const asked = ctx.url.searchParams.get("refused") ?? "";
  const ref = blocked && REF.test(asked) ? asked : "";
  const bigger = `mailto:${OPERATOR.contactEmail}?subject=${encodeURIComponent("Reliquary: a bigger plan")}`;
  // Where the page can't create a vault, it doesn't offer the form: it
  // says why, and the way on.
  const why = !admission.admitted
    ? html`${notAdmittedNote()}${ref ? refusedLine(ref) : ""}`
    : callout(
        "warning",
        html`<p>You own ${plan.vaultsOwned} of the ${plan.maxVaults} ${vaultWord(plan.maxVaults)} the ${plan.planName} plan allows, so a new one can’t be created.</p>
          <p>To make room, delete a vault you no longer need from its <strong>Settings</strong>. For more vaults, ask the operator for a bigger plan: nothing is billed during the beta.</p>
          ${ref ? refusedLine(ref) : ""}
          <p class="callout-actions"><a class="button" href="/account">Plan and usage</a><a class="button ghost" href="${bigger}">Ask for a bigger plan</a></p>`,
        { title: "You’re at your plan’s vault limit" },
      );
  return render(
    ctx,
    "New vault",
    html`${pageHeader({
      crumb: [{ label: "Home", href: "/" }, { label: "New vault" }],
      title: "New vault",
      description: "A vault holds the files you and your agents share. You’ll be its owner: you add members and set its rules.",
      secondary: blocked ? html`<a class="button ghost" href="/">Back to Home</a>` : html`<a class="button ghost" href="/">Cancel</a>`,
      primary: blocked ? "" : html`<button class="primary" form="new-vault">Create vault</button>`,
    })}
    ${blocked
      ? why
      : html`<p class="small muted plan-line">${ownedLine(plan)}. <a href="/account">Plan and usage</a></p>
    <form method="post" action="/vaults/new" class="panel choice-form new-vault-form" id="new-vault">
      ${csrfField(ctx.csrf)}
      <label for="vn">Name</label>
      <input id="vn" type="text" name="name" placeholder="Client work" required maxlength="100">
      ${templateChoices()}
      <fieldset class="choice-cards policy-cards" aria-describedby="policy-hint">
        <legend>Files without a rule are</legend>
        <p class="hint" id="policy-hint">Templates set rules for their folders; this applies to everything else, like the README at the top. You can change it later on the vault’s Settings, or per folder on Rules.</p>
        <div class="choice-card-grid">
          <label class="choice-card"><input type="radio" name="default_policy" value="open" checked>
            <span class="choice-card-body"><span class="choice-card-title">Open</span>
            <span class="choice-card-text">Members and their agents write directly. Every change is logged.</span></span></label>
          <label class="choice-card"><input type="radio" name="default_policy" value="canon">
            <span class="choice-card-body"><span class="choice-card-title">Canon</span>
            <span class="choice-card-text">Every change is a proposal a person approves before it applies.</span></span></label>
        </div>
      </fieldset>
      <div class="actions"><button class="primary">Create vault</button>
        <a class="button ghost" href="/">Cancel</a></div>
    </form>`}`,
    "vaults",
  );
}

// The refusals New vault explains by itself, when it next shows: the plan's
// vault limit (RLP01 with limit "vaults"; a template's files can meet a
// storage limit, also RLP01, which the page wouldn't explain) and not
// admitted (RLP02).
function explainedByPage(err: unknown): boolean {
  const e = err as { code?: string; detail?: string };
  if (e?.code === "RLP02") return true;
  if (e?.code !== "RLP01") return false;
  try {
    return (JSON.parse(e.detail ?? "{}") as { limit?: string }).limit === "vaults";
  } catch {
    return false;
  }
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
      "success",
    );
    return { redirect: vaultPath(id) };
  } catch (err) {
    // message() logs the refusal with its ref either way.
    const text = message(err);
    const ref = /\(ref ([0-9a-f]{8})\)/.exec(text)?.[1];
    if (ref && explainedByPage(err)) return { redirect: `/vaults/new?refused=${ref}` };
    ctx.setFlash(text);
    return { redirect: "/vaults/new" };
  }
}

// The Inbox: everything that needs this person, across their vaults. The
// top bar's counts (ctx.shell) say which sections have anything, so a
// section with nothing in it costs no query. Deletion notices are shown
// here and so taken, as on Home.
async function inbox(ctx: Ctx): Promise<Reply> {
  const counts = ctx.shell?.counts;
  const has = (n: number | undefined) => (n ?? 1) > 0;
  const { waiting, revising, snoozed, mine, invites, gone } = await asPerson(ctx.userId, async (c) => ({
    gone: has(counts?.notices) ? await deletionNotices(c) : html``,
    invites: has(counts?.invites)
      ? ((await c.query(`select vault_name, role, invited_by_email, expires_at from public.my_invites()`)).rows as {
          vault_name: string;
          role: string;
          invited_by_email: string | null;
          expires_at: Date;
        }[])
      : [],
    // Your own proposals (yours or your agents'), sent back with changes requested.
    mine: has(counts?.revise)
      ? (
          await c.query(
            withQuorums(`select p.id, p.vault_id, v.name as vault, p.kind, p.path, p.proposed_by, p.agent, p.created_at,
                    p.revision, p.body, cur.body as current_body, 0 as approvals,
                    row_number() over (order by p.created_at desc) as ord
               from public.proposals p join public.vaults v on v.id = p.vault_id
               left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
               left join public.file_versions cur on cur.id = f.current_version_id
              where p.status = 'changes_requested' and p.proposed_by = $1`),
            [ctx.userId],
          )
        ).rows
      : [],
    waiting: has(ctx.reviewCount) ? (await c.query(waitingSql("q.vault, q.created_at"), [ctx.userId])).rows : [],
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
  const pushes = has(counts?.imports) ? (await pendingPushes(ctx.userId)).filter((p) => p.mayApply) : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byVault = new Map<string, any[]>();
  for (const p of waiting) byVault.set(p.vault, [...(byVault.get(p.vault) ?? []), p]);
  const nothing = !waiting.length && !pushes.length && !mine.length && !invites.length && !gone.html.trim();
  const days = (d: Date) => Math.max(1, Math.ceil((d.getTime() - Date.now()) / 86_400_000));
  return render(
    ctx,
    "Inbox",
    html`${pageHeader({
      title: "Inbox",
      badge: waiting.length ? html`<span class="badge count-badge">${waiting.length} to review</span>` : undefined,
      description: "What needs you across your vaults: changes to review, proposals sent back, .env imports and invites.",
    })}
    ${gone.html.trim() ? html`<div id="notices">${gone}</div>` : ""}
    ${invites.length
      ? html`<h2 id="invites">Invites</h2>
        <p class="muted small">Someone invited your address to a vault. To join, open the invite link they sent you while you’re signed in as this address. Can’t find it? Ask them to send a new one.</p>
        <ul class="rows">${invites.map(
          (i) => html`<li><span><span class="name">${i.vault_name}</span>
            <span class="muted small"> · as ${i.role} · from ${i.invited_by_email ?? "an owner"} · expires in ${days(new Date(i.expires_at))} ${days(new Date(i.expires_at)) === 1 ? "day" : "days"}</span></span></li>`,
        )}</ul>`
      : ""}
    ${pushes.length ? pendingList(ctx, pushes, true) : ""}
    ${mine.length
      ? html`<h2 id="revise">Changes requested on your proposals</h2>
        <p class="muted small">A reviewer asked for changes. Open one to read their note and revise it; it comes back to them when you do.</p>
        <ul class="rows">${mine.map((p) => reviewRow(ctx, p, true))}</ul>`
      : ""}
    ${nothing
      ? emptyState({
          title: "Nothing needs you.",
          body: "When an agent proposes a change to a canon file, someone asks for changes on your proposal, a .env import waits to be applied or someone invites you, it shows up here.",
        })
      : [...byVault.entries()].map(
          ([name, items]) => html`<h2>${name}</h2><ul class="rows review-rows">${items.map((p) => reviewRow(ctx, p, false, true))}</ul>`,
        )}
    ${revising.length
      ? html`<h2>Waiting on the proposer</h2>
        <p class="muted small">You asked for changes. These come back here when they’re revised.</p>
        <ul class="rows">${revising.map((p) => reviewRow(ctx, p, true))}</ul>`
      : ""}
    ${snoozedSection(ctx, snoozed)}`,
    "inbox",
  );
}

// ---------------------------------------------------------------------------
// Activity

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

// A GET page runs in one transaction (db.ts, readOnlyRequest): the top
// bar's summary below and every query the page makes. Not the OAuth
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
  // The top bar (who you are, your vaults, the inbox) is only drawn on
  // pages: a POST almost always redirects, so it doesn't pay for it. One
  // call, in the page's transaction.
  if (get) {
    ctx.shell = await asPerson(ctx.userId, loadShell);
    ctx.reviewCount = ctx.shell.counts.review;
  }
  if (get && p === "/") return home(ctx);
  if (get && p === "/inbox") return inbox(ctx);
  // The Review page became the Inbox; old links and bookmarks land there.
  if (get && p === "/review") return { redirect: `/inbox${ctx.url.search}` };
  if (get && p === "/search") return searchAll(ctx);
  if (get && p === "/settings") return accountSettings(ctx);
  if (!get && p === "/settings/name") return saveDisplayName(ctx);
  if (!get && p === "/settings/sign-out-everywhere") return signOutEverywhere(ctx);
  if (!get && p === "/settings/email") return changeEmail(ctx);
  if (p === "/settings/delete") return get ? deleteAccountPage(ctx) : deleteAccount(ctx);
  if (get && p === "/activity") return allActivity(ctx);
  if (p === "/connect" || p === "/tokens" || p.startsWith("/tokens/")) return accessRoutes(ctx);
  if (get && p === "/account") return accountPage(ctx);
  if (get && p === "/vaults/new") return newVault(ctx);
  if (!get && p === "/vaults/new") return createVault(ctx);
  let m: RegExpExecArray | null;
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
