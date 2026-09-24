// Pages. Each handler runs its queries as the signed-in person (no agent
// claim) through asPerson(); the database decides what they may see and do.

import type pg from "pg";
import { asPerson } from "./db.js";
import { diffLines } from "./diff.js";
import { csrfField, html, page, when, type Raw, type Theme } from "./html.js";

export type Ctx = {
  userId: string;
  csrf: string;
  url: URL;
  form: URLSearchParams;
  method: string | undefined;
  flash?: string;
  theme: Theme;
  setFlash: (message: string) => void;
};
export type Reply = { status?: number; html?: string; redirect?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Errors from our own migrations are safe to show; others aren't.
function message(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (["42501", "P0002", "22023", "23505", "55000"].includes(e.code ?? "")) return e.message ?? "Not allowed";
  throw err;
}

const who = (ctx: Ctx, id: string | null, agent: string | null) =>
  `${id === ctx.userId ? "you" : id ? id.slice(0, 8) : "system"}${agent ? ` via ${agent}` : ""}`;

const tag = (policy: string) => html`<span class="tag ${policy}">${policy}</span>`;

const vaultPath = (id: string, rest = "") => `/v/${id}${rest}`;
const filePath = (id: string, path: string) => `/v/${id}/file?path=${encodeURIComponent(path)}`;

function render(ctx: Ctx, title: string, body: Raw, nav?: "vaults" | "tokens"): Reply {
  return {
    html: page(title, body, {
      user: ctx.userId,
      flash: ctx.flash,
      theme: ctx.theme,
      csrf: ctx.csrf,
      path: ctx.url.pathname + ctx.url.search,
      nav,
    }),
  };
}

async function vault(c: pg.PoolClient, ctx: Ctx, id: string) {
  if (!UUID.test(id)) return null;
  const { rows } = await c.query(
    `select v.id, v.name, m.role from public.vaults v
       join public.vault_members m on m.vault_id = v.id and m.user_id = $2
      where v.id = $1`,
    [id, ctx.userId],
  );
  return rows[0] as { id: string; name: string; role: string } | undefined;
}

const notFound = (ctx: Ctx): Reply => ({
  status: 404,
  html: page(
    "Not found",
    html`<h1>Not found</h1><p class="lede">There’s no such vault or file, or it isn’t shared with you.</p>
      <p><a href="/">Back to your vaults</a></p>`,
    { user: ctx.userId, theme: ctx.theme, csrf: ctx.csrf, path: "/" },
  ),
});

const crumb = (id: string, name: string) => html`<p class="crumb"><a href="${vaultPath(id)}">${name}</a></p>`;

// ---------------------------------------------------------------------------

async function home(ctx: Ctx): Promise<Reply> {
  const rows = await asPerson(ctx.userId, async (c) =>
    (
      await c.query(
        `select v.id, v.name, m.role,
                (select count(*) from public.proposals p where p.vault_id = v.id and p.status = 'open') as open,
                (select count(*) from public.files f where f.vault_id = v.id and f.deleted_at is null) as files
           from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by v.name`,
        [ctx.userId],
      )
    ).rows,
  );
  return render(
    ctx,
    "Vaults",
    html`<h1>Your vaults</h1>
    <p class="lede">Shared context your agents read and propose to. Canon changes wait here for you to approve them.</p>
    ${rows.length === 0
      ? html`<div class="empty"><strong>No vaults yet.</strong> Create one with <code>./mcp/dev.sh vault "Name"</code>, then connect an agent from Tokens.</div>`
      : html`<ul class="rows">${rows.map(
          (v) => html`<li>
            <span><a class="name" href="${vaultPath(v.id)}">${v.name}</a>
              <span class="muted small"> · ${v.role} · ${v.files} ${Number(v.files) === 1 ? "file" : "files"}</span></span>
            ${Number(v.open) > 0
              ? html`<a href="${vaultPath(v.id, "/proposals")}">${v.open} to review</a>`
              : html`<span class="muted small">Nothing to review</span>`}
          </li>`,
        )}</ul>`}`,
    "vaults",
  );
}

async function vaultHome(ctx: Ctx, id: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const files = (
      await c.query(
        `select f.path, (private.policy_for(f.vault_id, f.path)).policy, f.updated_at
           from public.files f where f.vault_id = $1 and f.deleted_at is null order by f.path`,
        [id],
      )
    ).rows;
    const open = (await c.query(`select count(*) from public.proposals where vault_id = $1 and status = 'open'`, [id]))
      .rows[0].count;
    const policies = (
      await c.query(`select path, policy, quorum from public.path_policies where vault_id = $1 order by path`, [id])
    ).rows;
    const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
    return { v, files, open: Number(open), policies, def };
  });
  if (!data) return notFound(ctx);
  const { v, files, open, policies, def } = data;
  const canWrite = v.role === "owner" || v.role === "editor";
  return render(
    ctx,
    v.name,
    html`<h1>${v.name}</h1>
    <div class="actions">
      ${canWrite ? html`<a class="button primary" href="${vaultPath(id, "/new")}">New file</a>` : ""}
      <a class="button" href="${vaultPath(id, "/proposals")}">Proposals${open ? html`<span class="count">${open}</span>` : ""}</a>
      <a class="button quiet" href="${vaultPath(id, "/log")}">Change log</a>
    </div>

    <h2>Files</h2>
    ${files.length === 0
      ? html`<div class="empty"><strong>No files yet.</strong> ${canWrite ? "Create one here, or ask a connected agent to write one." : "Nothing has been shared here yet."}</div>`
      : html`<div class="table-wrap"><table>
        <tr><th>Path</th><th>Policy</th><th class="num hide-sm">Updated</th></tr>
        ${files.map(
          (f) => html`<tr><td><a href="${filePath(id, f.path)}">${f.path}</a></td><td>${tag(f.policy)}</td>
            <td class="num small muted hide-sm">${when(f.updated_at)}</td></tr>`,
        )}</table></div>`}

    <h2>Policies</h2>
    <p class="muted small">Everything is ${tag(def)} unless a rule says otherwise. Folder rules end in <code>/</code>; the most specific rule wins. Canon changes need approval from people; agents can only propose them.</p>
    ${policies.length
      ? html`<div class="table-wrap"><table><tr><th>Path</th><th>Policy</th><th class="num">Approvals needed</th></tr>
        ${policies.map(
          (p) => html`<tr><td><code>${p.path}</code></td><td>${tag(p.policy)}</td><td class="num">${p.policy === "canon" ? p.quorum : ""}</td></tr>`,
        )}</table></div>`
      : ""}
    ${v.role === "owner"
      ? html`<form method="post" action="${vaultPath(id, "/policy")}" class="panel">
          ${csrfField(ctx.csrf)}
          <div class="fields">
            <div><label for="pp">Path or folder</label>
              <input id="pp" type="text" name="path" placeholder="canon/  or  clients/acme.md" required></div>
            <div><label for="pol">Policy</label>
              <select id="pol" name="policy"><option value="canon">Canon</option><option value="open">Open</option><option value="">Remove rule</option></select></div>
            <div><label for="q">Approvals</label><input id="q" class="narrow" type="text" name="quorum" value="1" inputmode="numeric"></div>
          </div>
          <div class="actions"><button>Save rule</button></div>
        </form>`
      : ""}`,
    "vaults",
  );
}

async function fileView(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const f = (
      await c.query(
        `select f.id, f.path, f.deleted_at, (private.policy_for(f.vault_id, f.path)).policy,
                (private.policy_for(f.vault_id, f.path)).quorum,
                fv.body, fv.author, fv.agent, fv.created_at, fv.erased_at
           from public.files f left join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2`,
        [id, path],
      )
    ).rows[0];
    if (!f) return { v, f: null, history: [] };
    const history = (
      await c.query(
        `select id, author, agent, created_at, erased_at from public.file_versions
          where file_id = $1 order by created_at desc limit 50`,
        [f.id],
      )
    ).rows;
    return { v, f, history };
  });
  if (!data || !data.f || data.f.deleted_at) return notFound(ctx);
  const { v, f, history } = data;
  const canWrite = v.role === "owner" || v.role === "editor";
  const canon = f.policy === "canon";
  return render(
    ctx,
    f.path,
    html`${crumb(id, v.name)}
    <h1 class="path">${f.path} ${tag(f.policy)}</h1>
    <p class="meta"><span>Last written by ${who(ctx, f.author, f.agent)}</span><span>${when(f.created_at)}</span>
      <span>${canon ? `Changes need ${f.quorum} approval${f.quorum > 1 ? "s" : ""}` : "Members and their agents edit directly"}</span></p>
    ${f.erased_at ? html`<div class="empty">This file’s content was erased.</div>` : html`<div class="file facet">${f.body}</div>`}

    ${canWrite && !f.erased_at
      ? html`<h2>${canon ? "Propose a change" : "Edit"}</h2>
        <form method="post" action="${vaultPath(id, "/file")}" class="panel">
          ${csrfField(ctx.csrf)}
          <input type="hidden" name="path" value="${f.path}">
          <input type="hidden" name="action" value="${canon ? "propose" : "write"}">
          <label for="content">Text</label>
          <textarea id="content" name="content">${f.body}</textarea>
          ${canon
            ? html`<label for="r">Why this change</label><input id="r" type="text" name="reason" required>
              <p class="hint">Reviewers see this next to the diff.</p>`
            : ""}
          <div class="actions"><button class="primary">${canon ? "Propose change" : "Save"}</button></div>
        </form>
        <form method="post" action="${vaultPath(id, "/file")}">
          ${csrfField(ctx.csrf)}
          <input type="hidden" name="path" value="${f.path}">
          <input type="hidden" name="action" value="${canon ? "propose-delete" : "delete"}">
          ${canon ? html`<input type="hidden" name="reason" value="Delete ${f.path}">` : ""}
          <div class="actions"><button class="danger">${canon ? "Propose deleting this file" : "Delete this file"}</button></div>
        </form>`
      : ""}

    <h2>History</h2>
    <div class="table-wrap"><table><tr><th>When</th><th>By</th><th></th></tr>
    ${history.map(
      (h) => html`<tr><td class="small">${when(h.created_at)}</td><td class="small">${who(ctx, h.author, h.agent)}</td>
        <td class="small muted">${h.erased_at ? "Erased" : ""}</td></tr>`,
    )}</table></div>`,
    "vaults",
  );
}

async function newFile(ctx: Ctx, id: string): Promise<Reply> {
  const v = await asPerson(ctx.userId, (c) => vault(c, ctx, id));
  if (!v) return notFound(ctx);
  return render(
    ctx,
    "New file",
    html`${crumb(id, v.name)}
    <h1>New file</h1>
    <form method="post" action="${vaultPath(id, "/file")}" class="panel">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="action" value="create">
      <label for="p">Path</label><input id="p" type="text" name="path" placeholder="notes/standup.md" required>
      <p class="hint">Folders are part of the path. A path under a canon folder becomes a proposal instead of a file.</p>
      <label for="c">Text</label><textarea id="c" name="content"></textarea>
      <label for="r">Why (only used if this becomes a proposal)</label>
      <input id="r" type="text" name="reason" value="New file">
      <div class="actions"><button class="primary">Create file</button>
        <a class="button quiet" href="${vaultPath(id)}">Cancel</a></div>
    </form>`,
    "vaults",
  );
}

async function fileAction(ctx: Ctx, id: string): Promise<Reply> {
  const f = ctx.form;
  const path = f.get("path") ?? "";
  const content = (f.get("content") ?? "").replaceAll("\r\n", "\n");
  const reason = f.get("reason") ?? "";
  let action = f.get("action") ?? "";
  try {
    const outcome = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return "missing";
      if (action === "create") {
        const policy = (await c.query(`select (private.policy_for($1, $2)).policy`, [id, path])).rows[0].policy;
        action = policy === "canon" ? "propose" : "write";
      }
      if (action === "write") await c.query(`select public.write_file($1, $2, $3)`, [id, path, content]);
      else if (action === "delete") await c.query(`select public.delete_file($1, $2)`, [id, path]);
      else if (action === "propose") await c.query(`select public.propose($1, $2, $3, $4)`, [id, path, content, reason]);
      else if (action === "propose-delete")
        await c.query(`select public.propose($1, $2, null, $3, true)`, [id, path, reason]);
      else return "bad";
      return action;
    });
    if (outcome === "missing") return notFound(ctx);
    if (outcome === "bad") return { status: 400, html: "Bad request" };
    if (outcome === "delete") {
      ctx.setFlash(`Deleted ${path}.`);
      return { redirect: vaultPath(id) };
    }
    if (outcome.startsWith("propose")) {
      ctx.setFlash("Proposed. It applies once enough people approve it.");
      return { redirect: vaultPath(id, "/proposals") };
    }
    ctx.setFlash(`Saved ${path}.`);
    return { redirect: filePath(id, path) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: path ? filePath(id, path) : vaultPath(id) };
  }
}

async function proposals(ctx: Ctx, id: string): Promise<Reply> {
  const status = ["open", "applied", "rejected", "stale"].includes(ctx.url.searchParams.get("status") ?? "")
    ? (ctx.url.searchParams.get("status") as string)
    : "open";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const rows = (
      await c.query(
        `select p.*, (private.policy_for(p.vault_id, p.path)).quorum,
                cur.body as current_body,
                coalesce((select json_agg(json_build_object('user', a.user_id, 'decision', a.decision) order by a.at)
                            from public.approvals a where a.proposal_id = p.id), '[]') as decisions
           from public.proposals p
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          where p.vault_id = $1 and p.status = $2
          order by p.created_at desc limit 100`,
        [id, status],
      )
    ).rows;
    return { v, rows };
  });
  if (!data) return notFound(ctx);
  const { v, rows } = data;
  const canDecide = v.role === "owner" || v.role === "editor";
  const tabs = ["open", "applied", "rejected", "stale"].map(
    (s) => html`<a href="${vaultPath(id, `/proposals?status=${s}`)}"${s === status ? html` aria-current="page"` : ""}>${s}</a>`,
  );
  const emptyCopy: Record<string, string> = {
    open: "Nothing waiting. When an agent proposes a change to a canon file, it shows up here.",
    applied: "No proposals have been applied yet.",
    rejected: "No proposals have been rejected.",
    stale: "No stale proposals. A proposal goes stale when its file changed before it was approved.",
  };
  return render(
    ctx,
    "Proposals",
    html`${crumb(id, v.name)}
    <h1>Proposals</h1>
    <nav class="tabs" aria-label="Proposal status">${tabs}</nav>
    ${rows.length === 0 ? html`<div class="empty">${emptyCopy[status]}</div>` : ""}
    ${rows.map((p) => {
      const approvals = (p.decisions as { user: string; decision: string }[]).filter((d) => d.decision === "approve");
      const mine = (p.decisions as { user: string }[]).some((d) => d.user === ctx.userId);
      const before = p.current_body ?? "";
      const after = p.kind === "delete" ? "" : p.body ?? "";
      const lines = diffLines(before, after);
      const verb = p.kind === "delete" ? "Delete" : before ? "Change" : "Create";
      return html`<article class="proposal">
        <h2>${verb} <a href="${filePath(id, p.path)}">${p.path}</a></h2>
        <p class="meta"><span>By ${who(ctx, p.proposed_by, p.agent)}</span><span>${when(p.created_at)}</span>
          <span>${approvals.length} of ${p.quorum} approvals</span></p>
        <p class="reason">${p.reason || "No reason given."}</p>
        ${p.agent ? html`<p class="caution">Proposed by an agent. Judge the change itself, not the reason: agent-written text can carry instructions aimed at reviewers.</p>` : ""}
        ${lines
          ? html`<div class="diff facet" aria-label="Changes">${lines.map((l) => html`<div class="${l.kind}"><span>${l.text}</span></div>`)}</div>`
          : html`<p class="muted">Too large to compare line by line. New text:</p><div class="file facet">${after}</div>`}
        ${p.status === "open" && canDecide && !mine
          ? html`<div class="actions">
              <form method="post" action="${vaultPath(id, `/proposals/${p.id}`)}">
                ${csrfField(ctx.csrf)}<input type="hidden" name="decision" value="approve">
                <button class="primary">Approve</button></form>
              <form method="post" action="${vaultPath(id, `/proposals/${p.id}`)}">
                ${csrfField(ctx.csrf)}<input type="hidden" name="decision" value="reject">
                <button class="danger">Reject</button></form>
            </div>`
          : p.status === "open" && mine
            ? html`<p class="muted small">You’ve decided on this one. It needs more approvals before it applies.</p>`
            : ""}
      </article>`;
    })}`,
    "vaults",
  );
}

async function decide(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const decision = ctx.form.get("decision") === "reject" ? "reject" : "approve";
  try {
    const result = await asPerson(ctx.userId, async (c) =>
      (await c.query(`select public.decide($1, $2) as r`, [pid, decision])).rows[0].r as string,
    );
    ctx.setFlash(
      {
        applied: "Approved and applied.",
        open: "Approved. It needs more approvals before it applies.",
        rejected: "Rejected. The file is unchanged.",
        stale: "The file changed after this was proposed, so it was marked stale instead of applied.",
      }[result] ?? result,
    );
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/proposals") };
}

async function log(ctx: Ctx, id: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const rows = (
      await c.query(`select * from public.log where vault_id = $1 order by seq desc limit 200`, [id])
    ).rows;
    return { v, rows };
  });
  if (!data) return notFound(ctx);
  return render(
    ctx,
    "Change log",
    html`${crumb(id, data.v.name)}
    <h1>Change log</h1>
    <p class="lede">Every change to this vault, newest first. The log can only be added to; nothing here is ever edited or deleted.</p>
    <div class="table-wrap"><table><tr><th class="num">#</th><th>When</th><th>Event</th><th>Path</th><th>By</th></tr>
    ${data.rows.map(
      (r) => html`<tr><td class="num small muted">${r.seq}</td><td class="small">${when(r.at)}</td>
        <td class="small">${r.event}</td><td>${r.path ?? ""}</td><td class="small">${who(ctx, r.actor, r.agent)}</td></tr>`,
    )}</table></div>`,
    "vaults",
  );
}

async function setPolicy(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.form.get("path") ?? "";
  const policy = ctx.form.get("policy") || null;
  const quorum = Math.max(1, Math.min(20, Number(ctx.form.get("quorum") ?? 1) || 1));
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_policy($1, $2, $3, $4)`, [id, path, policy, quorum]));
    ctx.setFlash(policy ? `${path} is now ${policy}.` : `Rule for ${path} removed.`);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id) };
}

async function tokens(ctx: Ctx, fresh?: { name: string; token: string }): Promise<Reply> {
  const rows = await asPerson(ctx.userId, async (c) =>
    (
      await c.query(
        `select id, name, created_at, expires_at, last_used_at, revoked_at from public.access_tokens
          order by revoked_at nulls first, created_at desc`,
      )
    ).rows,
  );
  return render(
    ctx,
    "Tokens",
    html`<h1>Tokens</h1>
    <p class="lede">A token lets one agent act as you over MCP. Agents can read, write open files and propose changes. They can never approve, set policies or manage members.</p>
    ${fresh
      ? html`<div class="reveal facet" role="status"><strong>${fresh.name}</strong>
          <p class="muted small">Copy it now. It won’t be shown again. Paste it into your agent’s settings, never into a chat.</p>
          <p class="secret">${fresh.token}</p></div>`
      : ""}
    <form method="post" action="/tokens/new" class="panel">
      ${csrfField(ctx.csrf)}
      <label for="tn">Name it after the agent and machine</label>
      <input id="tn" type="text" name="name" placeholder="Hermes on Linux" required>
      <div class="actions"><button class="primary">Create token</button></div>
    </form>
    <h2>Your tokens</h2>
    ${rows.length === 0
      ? html`<div class="empty">No tokens yet.</div>`
      : html`<div class="table-wrap"><table><tr><th>Name</th><th class="hide-sm">Created</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr>
    ${rows.map(
      (t) => html`<tr><td>${t.name}</td><td class="small hide-sm">${when(t.created_at)}</td>
        <td class="small">${when(t.last_used_at) || "Never"}</td><td class="small hide-sm">${when(t.expires_at)}</td>
        <td class="num">${t.revoked_at
          ? html`<span class="muted small">Revoked</span>`
          : html`<form method="post" action="/tokens/${t.id}/revoke">${csrfField(ctx.csrf)}<button class="danger">Revoke</button></form>`}</td></tr>`,
    )}</table></div>`}`,
    "tokens",
  );
}

async function createToken(ctx: Ctx): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  try {
    const token = await asPerson(ctx.userId, async (c) =>
      (await c.query(`select public.create_access_token($1, 90) as t`, [name])).rows[0].t as string,
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

export async function routes(ctx: Ctx): Promise<Reply> {
  const p = ctx.url.pathname;
  const get = ctx.method === "GET";
  if (get && p === "/") return home(ctx);
  if (get && p === "/tokens") return tokens(ctx);
  if (!get && p === "/tokens/new") return createToken(ctx);
  let m = /^\/tokens\/([^/]+)\/revoke$/.exec(p);
  if (!get && m) return revokeToken(ctx, m[1]);

  m = /^\/v\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return notFound(ctx);
  const [, id, rest = ""] = m;
  if (!UUID.test(id)) return notFound(ctx);
  if (get && rest === "") return vaultHome(ctx, id);
  if (get && rest === "/file") return fileView(ctx, id);
  if (!get && rest === "/file") return fileAction(ctx, id);
  if (get && rest === "/new") return newFile(ctx, id);
  if (get && rest === "/proposals") return proposals(ctx, id);
  if (get && rest === "/log") return log(ctx, id);
  if (!get && rest === "/policy") return setPolicy(ctx, id);
  const d = /^\/proposals\/([^/]+)$/.exec(rest);
  if (!get && d) return decide(ctx, id, d[1]);
  return notFound(ctx);
}
