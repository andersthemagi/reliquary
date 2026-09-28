// A path's named owners (docs/design.md, "Path ownership"), reached from
// each rule's menu on the Rules page. The database decides
// (supabase/migrations/20260928130000_path_ownership.sql): naming and
// removing are an owner's, in person (set_path_owner, remove_path_owner),
// and only on a path that has a rule; every member reads the list. These
// pages only choose what to offer.
//
// Naming someone hands them, and their agents, direct writes to the path,
// with no review: a bigger trust delta than an editor's role. So both naming
// and removing go through a confirm page (design.md's guardrail: never a
// quiet toggle in a form), and a POST without that page's confirm field is
// sent to it instead of acting.
//
//   GET  /v/:id/rules/owners?path=                the path's owners; owners also get the form to name one
//   GET  /v/:id/rules/owners?path=&add=<user>     confirm naming them
//   GET  /v/:id/rules/owners?path=&remove=<user>  confirm removing them
//   POST /v/:id/rules/owners                      action add or remove, path, user, confirm=1

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, confirmPage, emptyState, html, pageHeader, policyBadge, time, type Raw } from "./html.js";
import { Refusal } from "./failure.js";
import { vaultShell } from "./files.js";
import { roleName } from "./invites.js";
import { personRef } from "./people.js";
import { message, notFound, render, UUID, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { approvals, ownersPath, rulesCrumb } from "./rules.js";

type Rule = { path: string; policy: string; quorum: number };
type Member = { user_id: string; email: string | null; role: string };
// role and email are null for someone named who is no longer a member.
type Owner = { user_id: string; added_by: string | null; added_at: Date; email: string | null; role: string | null };

// A path typed into a URL, said back only when it's plain (as rules.ts does).
const shown = (path: string) => (/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that path");
// By email where the reader may see it (people.ts fills it in), as members.ts does.
const label = (m: { user_id: string; email: string | null }) => (m.email ? personRef(m.user_id) : `Account ${m.user_id.slice(0, 8)}`);
// The same, for a flash: a flash outlives this process, so no marker.
const plainName = (m: { user_id: string; email: string | null } | undefined, user: string) => m?.email ?? `Account ${user.slice(0, 8)}`;
const aRole = (role: string) => `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;

async function loadRule(c: pg.PoolClient, id: string, path: string): Promise<Rule | undefined> {
  return (await c.query(`select path, policy, quorum from public.path_policies where vault_id = $1 and path = $2`, [id, path])).rows[0];
}

async function loadOwners(c: pg.PoolClient, id: string, path: string): Promise<Owner[]> {
  return (
    await c.query(
      `select po.user_id, po.added_by, po.added_at, m.email, m.role
         from public.path_owners po
         left join public.list_members($1) m on m.user_id = po.user_id
        where po.vault_id = $1 and po.path = $2
        order by po.added_at, po.user_id`,
      [id, path],
    )
  ).rows;
}

const members = async (c: pg.PoolClient, id: string): Promise<Member[]> =>
  (await c.query(`select user_id, email, role from public.list_members($1)`, [id])).rows;

// Rules inside a folder rule: they keep owners of their own, since the most
// specific rule is the one whose owners count (private.matched_policy_path).
const innerRules = async (c: pg.PoolClient, id: string, path: string): Promise<string[]> =>
  path.endsWith("/")
    ? (
        await c.query(`select path from public.path_policies where vault_id = $1 and path <> $2 and starts_with(path, $2) order by path`, [id, path])
      ).rows.map((r) => r.path as string)
    : [];

// The page, in the vault shell under Settings; or, when it can't be shown,
// a note for the page it sends the person back to.
type Built = { shell: Raw; title: string } | { back: string; note: string; tone: "warning" | "info" } | null;

async function build(ctx: Ctx, id: string, fn: (c: pg.PoolClient, v: Vault) => Promise<{ body: Raw; title: string } | { back: string; note: string; tone: "warning" | "info" } | null>): Promise<Reply> {
  const out: Built = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const r = await fn(c, v);
    if (!r || "back" in r) return r;
    return { shell: await vaultShell(c, ctx, v, { section: "rules" }, r.body), title: r.title };
  });
  if (!out) return notFound(ctx);
  if ("back" in out) {
    ctx.setFlash(out.note, out.tone);
    return { redirect: out.back };
  }
  return render(ctx, out.title, out.shell, "vaults");
}

const noRule = (id: string, path: string) => ({
  back: vaultPath(id, "/rules"),
  note: `There’s no rule on ${shown(path)}, so it can’t have named owners. Add a rule for it first, then name its owners from the rule’s menu.`,
  tone: "warning" as const,
});

// ---------------------------------------------------------------------------
// The owners of one rule's path

export async function pathOwners(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  const add = ctx.url.searchParams.get("add");
  const remove = ctx.url.searchParams.get("remove");
  if (add !== null) return confirmAdd(ctx, id, path, add);
  if (remove !== null) return confirmRemove(ctx, id, path, remove);
  return build(ctx, id, async (c, v) => {
    const rule = await loadRule(c, id, path);
    if (!rule) return noRule(id, path);
    const owner = v.role === "owner";
    const owners = await loadOwners(c, id, path);
    const named = new Set(owners.map((o) => o.user_id));
    const candidates = owner ? (await members(c, id)).filter((m) => !named.has(m.user_id)) : [];
    const canon = rule.policy === "canon";

    const roleCell = (o: Owner) =>
      o.role === null
        ? html`<span class="muted">Not a member any more</span><span class="token-client">Named before they left the vault</span>`
        : html`${roleName(o.role)}${o.role === "viewer" ? html`<span class="token-client">Writes and approves this path only; reads the rest</span>` : ""}`;

    const table = owners.length
      ? html`<div class="table-wrap"><table class="table-stack member-list owner-list">
          <thead><tr><th scope="col">Owner</th><th scope="col">Role in the vault</th><th scope="col">Named</th>${owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
          <tbody>${owners.map(
            (o) => html`<tr><td>${label(o)}${o.user_id === ctx.userId ? html` <span class="badge">You</span>` : ""}</td>
              <td class="small" data-label="Role in the vault">${roleCell(o)}</td>
              <td class="small" data-label="Named">${o.added_by ? html`by ${who(ctx, o.added_by, null)} · ` : ""}${time(o.added_at)}</td>
              ${owner
                ? html`<td class="num row-actions"><a class="button quiet" href="${ownersPath(id, path)}&amp;remove=${o.user_id}" aria-label="Remove ${label(o)} as an owner of ${path}">Remove</a></td>`
                : ""}</tr>`,
          )}</tbody></table></div>`
      : emptyState({
          title: "No named owners",
          body: html`Everyone with write access follows the rule on <code>${path}</code>.${owner ? " Name someone below to let them write it directly." : ""}`,
        });

    const form = !owner
      ? html`<p class="hint">Only owners name or remove a path’s owners.</p>`
      : candidates.length
        ? html`<form method="get" action="${vaultPath(id, "/rules/owners")}" class="panel owner-form" id="add-owner" aria-labelledby="add-owner-title">
            <h2 id="add-owner-title" class="form-title">Name an owner</h2>
            <input type="hidden" name="path" value="${path}">
            <label for="po-user">Member</label>
            <select id="po-user" name="add" required aria-describedby="po-hint">${candidates.map(
              (m) => html`<option value="${m.user_id}">${label(m)} (${roleName(m.role)})</option>`,
            )}</select>
            <p class="hint" id="po-hint">Any member can be named, a viewer too: they write this path, and only this path, directly. You confirm on the next page.</p>
            <div class="actions"><button class="primary">Name owner…</button></div>
          </form>`
        : html`<p class="hint">Every member of ${v.name} is already a named owner of <code>${path}</code>.</p>`;

    const body = html`
      ${pageHeader({
        crumb: rulesCrumb(v, "Owners"),
        title: `Owners of ${path}`,
        path: true,
        description: "Named owners write this path directly, with no review, and theirs are the only approvals its quorum counts. Everyone else follows the rule.",
        meta: html`<p class="rule">${policyBadge(rule.policy)} <span>The rule on <code>${path}</code>${canon ? `: changes need ${approvals(rule.quorum)}` : ""}. <a href="${vaultPath(id, "/rules")}">Rules</a></span></p>`,
        primary: owner && candidates.length ? html`<a class="button primary" href="#add-owner">Name an owner</a>` : "",
      })}
      ${canon
        ? ""
        : callout("info", html`<p><code>${path}</code> is open, so everyone with write access already writes it directly. Named owners make a difference once its rule is canon.</p>`)}
      ${table}
      ${form}
      <p class="hint rules-help">A vault owner who isn’t named here proposes on this path like anyone else. <a href="/docs/concepts/path-ownership">Path ownership</a></p>`;
    return { body, title: `Owners of ${path}` };
  });
}

// ---------------------------------------------------------------------------
// Confirm naming someone. A GET: nothing changes until its form is sent.

async function confirmAdd(ctx: Ctx, id: string, path: string, user: string): Promise<Reply> {
  return build(ctx, id, async (c, v) => {
    const back = ownersPath(id, path);
    if (v.role !== "owner") return { back, note: "Only owners name a path’s owners; ask an owner of this vault.", tone: "warning" };
    const rule = await loadRule(c, id, path);
    if (!rule) return noRule(id, path);
    const m = UUID.test(user) ? (await members(c, id)).find((x) => x.user_id === user) : undefined;
    if (!m) return { back, note: "That person isn’t a member of this vault, so they can’t be named an owner. Invite them first.", tone: "warning" };
    const owners = await loadOwners(c, id, path);
    if (owners.some((o) => o.user_id === user)) return { back, note: `${plainName(m, user)} is already a named owner of ${path}.`, tone: "info" };
    const inner = await innerRules(c, id, path);
    const who_ = label(m);
    const consequences: (Raw | string)[] = [
      rule.policy === "canon"
        ? owners.length
          ? html`Their approval counts toward its ${approvals(rule.quorum)}, with ${owners.length === 1 ? "the other named owner’s" : `the other ${owners.length} named owners’`}. Nobody else’s does.`
          : html`From now on only named owners’ approvals count toward its ${approvals(rule.quorum)}. Until now any editor’s or owner’s did; they now propose and wait like anyone else.`
        : html`The rule on <code>${path}</code> is open today, so this changes nothing yet. It takes effect if the rule becomes canon.`,
      m.role === "viewer" ? `They stay a viewer everywhere else in ${v.name}: this is write access to this path only.` : `They stay ${aRole(m.role)} everywhere else in ${v.name}.`,
      ...(inner.length
        ? [html`${inner.length === 1 ? html`The rule on <code>${inner[0]}</code>` : `The ${inner.length} rules`} inside it keep${inner.length === 1 ? "s" : ""} ${inner.length === 1 ? "its" : "their"} own owners: naming someone here doesn’t cover ${inner.length === 1 ? "it" : "them"}.`]
        : []),
      "It’s logged in Activity. You can remove them at any time.",
    ];
    const body = confirmPage({
      title: `Name ${who_} an owner of ${path}?`,
      crumb: rulesCrumb(v, "Name an owner"),
      lede: html`${who_} (${roleName(m.role)}) will write and delete <code>${path}</code> directly, with no proposal and no review, and so will their agents.`,
      consequences,
      action: vaultPath(id, "/rules/owners"),
      csrf: ctx.csrf,
      fields: { path, user, action: "add", confirm: "1" },
      button: `Name ${who_} owner of ${path}`,
      cancel: back,
    });
    return { body, title: "Name an owner" };
  });
}

// ---------------------------------------------------------------------------
// Confirm removing someone

async function confirmRemove(ctx: Ctx, id: string, path: string, user: string): Promise<Reply> {
  return build(ctx, id, async (c, v) => {
    const back = ownersPath(id, path);
    if (v.role !== "owner") return { back, note: "Only owners remove a path’s owners; ask an owner of this vault.", tone: "warning" };
    const rule = await loadRule(c, id, path);
    if (!rule) return noRule(id, path);
    const owners = await loadOwners(c, id, path);
    const o = UUID.test(user) ? owners.find((x) => x.user_id === user) : undefined;
    if (!o) return { back, note: `That person isn’t a named owner of ${shown(path)}; they may have been removed already.`, tone: "warning" };
    const who_ = label(o);
    const canon = rule.policy === "canon";
    const after =
      o.role === null
        ? "They’re no longer a member of this vault."
        : o.role === "viewer"
          ? `They go back to reading it only, like the rest of ${v.name}.`
          : canon
            ? `As ${aRole(o.role)}, they propose changes to it and wait for approval, like anyone else.`
            : `The rule is open, so as ${aRole(o.role)} they still write it directly.`;
    const body = confirmPage({
      title: `Remove ${who_} as an owner of ${path}?`,
      crumb: rulesCrumb(v, "Remove an owner"),
      lede: html`${who_} stops writing <code>${path}</code> directly, and so do their agents.`,
      consequences: [
        after,
        ...(owners.length === 1 && canon
          ? [`They’re its last named owner, so any editor’s or owner’s approval counts toward its ${approvals(rule.quorum)} again.`]
          : []),
        "It’s logged in Activity. You can name them again at any time.",
      ],
      action: vaultPath(id, "/rules/owners"),
      csrf: ctx.csrf,
      fields: { path, user, action: "remove", confirm: "1" },
      button: `Remove ${who_} as owner`,
      cancel: back,
    });
    return { body, title: "Remove an owner" };
  });
}

// ---------------------------------------------------------------------------
// POST: name or remove, once confirmed. The database refuses anyone but an
// owner, in person, and a path with no rule; its refusal comes back as a
// flash with its reference.

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (a path’s owners)", why }));

export async function pathOwnerAction(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.form.get("path") ?? "";
  const user = ctx.form.get("user") ?? "";
  const action = ctx.form.get("action") ?? "";
  const back = ownersPath(id, path);
  if (action !== "add" && action !== "remove") {
    ctx.setFlash(refuse("The form didn’t say whether to name or remove an owner, so nothing changed"));
    return { redirect: back };
  }
  if (!UUID.test(user)) {
    ctx.setFlash(refuse("The form didn’t say which member, so nothing changed: choose them again"));
    return { redirect: back };
  }
  // Only the confirm page's form carries this: anything else is sent there.
  if (ctx.form.get("confirm") !== "1") return { redirect: `${back}&${action}=${user}` };
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      const m = (await members(c, id)).find((x) => x.user_id === user);
      const name = plainName(m, user);
      if (action === "add") {
        await c.query(`select public.set_path_owner($1, $2, $3)`, [id, path, user]);
        return { name, changed: true };
      }
      const named = (await c.query(`select 1 from public.path_owners where vault_id = $1 and path = $2 and user_id = $3`, [id, path, user])).rowCount;
      if (!named) return { name, changed: false };
      await c.query(`select public.remove_path_owner($1, $2, $3)`, [id, path, user]);
      return { name, changed: true };
    });
    if (!done) return notFound(ctx);
    if (action === "add") ctx.setFlash(`${done.name} is now a named owner of ${path}: they, and their agents, write it directly.`, "success");
    else if (done.changed) ctx.setFlash(`${done.name} is no longer a named owner of ${path}.`, "success");
    else ctx.setFlash(`${done.name} isn’t a named owner of ${path}, so nothing changed; they may have been removed already.`, "warning");
  } catch (err) {
    ctx.setFlash(message(err));
    // With no rule there's no owners page to go back to: Rules, with the reason.
    const rule = await asPerson(ctx.userId, (c) => loadRule(c, id, path)).catch(() => undefined);
    if (!rule) return { redirect: vaultPath(id, "/rules") };
  }
  return { redirect: back };
}
