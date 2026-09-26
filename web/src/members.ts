// Members, invites and members' agent connections, in the vault's Settings
// (/v/:id/config/members), and the invite page (/invite?token=...).
// supabase/migrations/20260925140000_invites.sql decides everything: every
// function it calls is an owner's (or, for accepting, the invitee's) in
// person. These pages only choose what to offer.
//
//   GET  /v/:id/config/members                          members, invites, connections
//   POST /v/:id/config/members/role                     change a role (user, role)
//   GET  /v/:id/config/members/remove?user=             confirm; POST removes
//   POST /v/:id/config/members/invite                   make an invite; shows its link once
//   POST /v/:id/config/members/invites/:iid/revoke
//   POST /v/:id/config/members/connections/:tid/revoke  cut a connection off from this vault
//   GET  /v/:id/config/leave                            confirm leaving; POST leaves
//   GET  /invite?token=                                 what the invite is; Accept
//   POST /invite                                        accept (token)
//
// Nothing here logs an address or a token; the server logs method, path
// and status only.

import type pg from "pg";
import { authMode } from "./auth.js";
import { asPerson } from "./db.js";
import { errorBody } from "./errorpage.js";
import { failure } from "./failure.js";
import { csrfField, html, pageHeader, raw, when, type Raw } from "./html.js";
import { deliverInvite, INVITE_TOKEN, inviteLink, maskEmail, peekInvite, ROLE_TEXT, type Peek } from "./invites.js";
import { limit, tooManyPage } from "./ratelimit.js";
import { ago, message, notFound, render, UUID, vault, vaultPath, vaultShell, type Ctx, type Reply, type Vault } from "./pages.js";

const ROLES = ["viewer", "editor", "owner"] as const;
const membersPath = (id: string, rest = "") => vaultPath(id, `/config/members${rest}`);
const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Member = { user_id: string; email: string | null; role: string; added_at: Date };
type Invite = { id: string; email: string; role: string; created_at: Date; expires_at: Date };
type Conn = {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  client_name: string | null;
  access: string;
  all_vaults: boolean;
  last_used_at: Date | null;
  expires_at: Date;
};

const label = (m: { email: string | null; user_id: string }) => m.email ?? `Account ${m.user_id.slice(0, 8)}`;
const kindText = (c: Conn) =>
  c.kind === "cli" ? "Reliquary CLI (environment variables)" : c.kind === "oauth" ? "MCP app" : "MCP token";

async function shell(ctx: Ctx, id: string, title: string, build: (c: pg.PoolClient, v: Vault) => Promise<Raw | null>, status?: number): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const body = await build(c, v);
    if (!body) return null;
    return vaultShell(c, ctx, v, { section: "settings" }, body);
  });
  if (!out) return notFound(ctx);
  return { ...render(ctx, title, out, "vaults"), status };
}

const crumb = (id: string, v: Vault, sub?: boolean) =>
  html`<p class="crumb"><a href="${vaultPath(id)}">${v.name}</a><span aria-hidden="true"> / </span><a href="${vaultPath(id, "/config")}">Settings</a>${
    sub ? html`<span aria-hidden="true"> / </span><a href="${membersPath(id)}">Members</a>` : ""
  }</p>`;

// ---------------------------------------------------------------------------
// The Members page

async function membersPage(ctx: Ctx, id: string, fresh?: { email: string; role: string; link: string; sent: boolean; expires: Date }): Promise<Reply> {
  return shell(ctx, id, "Members", async (c, v) => {
    const owner = v.role === "owner";
    const members = (await c.query(`select user_id, email, role, added_at from public.list_members($1)`, [id])).rows as Member[];
    const invites = owner
      ? ((await c.query(`select id, email, role, created_at, expires_at from public.list_invites($1)`, [id])).rows as Invite[])
      : [];
    const conns = owner
      ? ((
          await c.query(
            `select id, user_id, name, kind, client_name, access, all_vaults, last_used_at, expires_at
               from public.member_connections($1)`,
            [id],
          )
        ).rows as Conn[])
      : [];
    const owners = members.filter((m) => m.role === "owner").length;
    const byUser = new Map<string, Conn[]>();
    for (const cn of conns) byUser.set(cn.user_id, [...(byUser.get(cn.user_id) ?? []), cn]);

    const roleCell = (m: Member) => {
      const lastOwner = m.role === "owner" && owners <= 1;
      if (!owner || lastOwner) {
        return html`${roleName(m.role)}${lastOwner && owner ? html`<span class="muted token-client">The only owner</span>` : ""}`;
      }
      return html`<form method="post" action="${membersPath(id, "/role")}" class="role-form">
        ${csrfField(ctx.csrf)}<input type="hidden" name="user" value="${m.user_id}">
        <select name="role" aria-label="Role for ${label(m)}">${ROLES.map(
          (r) => html`<option value="${r}"${r === m.role ? raw(" selected") : ""}>${roleName(r)}</option>`,
        )}</select>
        <button class="quiet">Change</button>
      </form>`;
    };

    return html`
      ${pageHeader({
        crumb: crumb(id, v),
        title: "Members",
        actions: owner ? html`<a class="button primary" href="#invite">Invite someone</a>` : "",
      })}
      <p class="lede">The people in ${v.name} and what each can do. Their agents act as them, but can never approve, manage members, reveal a value, export or delete.</p>
      ${fresh
        ? html`<div class="callout attention reveal" role="status" id="invite-link">
            <strong>Invite for ${fresh.email} (${roleName(fresh.role)})</strong>
            ${fresh.sent
              ? html`<p>We emailed them the link. It works once, for that address, until ${when(fresh.expires)}.</p>`
              : html`<p>Copy this link and send it to them yourself: Reliquary doesn’t email invites yet. It works once, only for someone signed in as <strong>${fresh.email}</strong>, until ${when(fresh.expires)}. It won’t be shown again.</p>
                <p class="secret">${fresh.link}</p>`}
          </div>`
        : ""}
      ${owner && owners === 1 && members.length > 1
        ? html`<p class="callout info">This vault has one owner. Two are recommended, so someone can carry on if the owner can’t.</p>`
        : ""}
      <h2>People</h2>
      <div class="table-wrap"><table class="token-list member-list">
        <tr><th>Member</th><th>Role</th><th class="hide-sm">Joined</th>${owner ? html`<th></th>` : ""}</tr>
        ${members.map(
          (m) => html`<tr><td>${label(m)}${m.user_id === ctx.userId ? html` <span class="badge">You</span>` : ""}</td>
            <td class="small">${roleCell(m)}</td>
            <td class="small hide-sm">${when(m.added_at)}</td>
            ${owner
              ? html`<td class="num">${m.user_id === ctx.userId || (m.role === "owner" && owners <= 1)
                  ? ""
                  : html`<a class="button quiet" href="${membersPath(id, `/remove?user=${m.user_id}`)}">Remove</a>`}</td>`
              : ""}</tr>`,
        )}
      </table></div>
      ${owner ? "" : html`<p class="hint">Only owners invite people, change roles or remove members.</p>`}
      ${owner
        ? html`
          <h2 id="invite">Invite someone</h2>
          <form method="post" action="${membersPath(id, "/invite")}" class="panel choice-form">
            ${csrfField(ctx.csrf)}
            <label for="ie">Email</label>
            <input id="ie" type="text" name="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" required>
            <fieldset>
              <legend>Role</legend>
              ${ROLES.map(
                (r) => html`<label class="choice"><input type="radio" name="role" value="${r}"${r === "editor" ? raw(" checked") : ""}> <span>${ROLE_TEXT[r]}</span></label>`,
              )}
            </fieldset>
            <p class="hint">You’ll get a link to send them. It works once, for that address only, for 7 days. They sign in with that address (a new account is made if they have none) and join as the role you chose.</p>
            <div class="actions"><button class="primary">Create invite link</button></div>
          </form>
          <h2>Pending invites</h2>
          ${invites.length
            ? html`<div class="table-wrap"><table class="token-list">
                <tr><th>Email</th><th>Role</th><th class="hide-sm">Expires</th><th></th></tr>
                ${invites.map(
                  (i) => html`<tr><td>${i.email}</td><td class="small">${roleName(i.role)}</td>
                    <td class="small hide-sm">${when(i.expires_at)}</td>
                    <td class="num"><form method="post" action="${membersPath(id, `/invites/${i.id}/revoke`)}">${csrfField(ctx.csrf)}<button class="danger">Revoke</button></form></td></tr>`,
                )}
              </table></div>`
            : html`<div class="empty">No invites waiting.</div>`}
          <h2>Agent connections</h2>
          <p>The tokens and apps each member has connected that reach this vault. Revoking one here cuts it off from ${v.name} only; the member’s other vaults keep it.</p>
          ${conns.length
            ? html`<div class="table-wrap"><table class="token-list">
                <tr><th>Member</th><th>Connection</th><th>Access</th><th>Last used</th><th></th></tr>
                ${members.flatMap((m) =>
                  (byUser.get(m.user_id) ?? []).map(
                    (cn) => html`<tr><td class="small">${label(m)}</td>
                      <td>${cn.name}<span class="muted token-client">${kindText(cn)}${cn.client_name ? html` · ${cn.client_name}` : ""}</span></td>
                      <td class="small">${cn.kind === "cli" ? "Environment variables" : cn.access === "write" ? "Read and write" : "Read only"}${cn.all_vaults ? html`<span class="muted token-client">All their vaults</span>` : ""}</td>
                      <td class="small">${cn.last_used_at ? ago(cn.last_used_at) : "Never"}</td>
                      <td class="num"><form method="post" action="${membersPath(id, `/connections/${cn.id}/revoke`)}">${csrfField(ctx.csrf)}<button class="danger">Revoke</button></form></td></tr>`,
                  ),
                )}
              </table></div>`
            : html`<div class="empty">No member has an agent connected to this vault.</div>`}`
        : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Actions

async function setRole(ctx: Ctx, id: string): Promise<Reply> {
  const user = ctx.form.get("user") ?? "";
  const role = ctx.form.get("role") ?? "";
  if (!UUID.test(user)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_member($1, $2, $3)`, [id, user, role]));
    ctx.setFlash(`Role changed to ${roleName(role)}.`);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

async function removePage(ctx: Ctx, id: string): Promise<Reply> {
  const user = ctx.url.searchParams.get("user") ?? "";
  if (!UUID.test(user)) return notFound(ctx);
  return shell(ctx, id, "Remove member", async (c, v) => {
    if (v.role !== "owner") {
      return html`${pageHeader({ crumb: crumb(id, v, true), title: "Remove member" })}<p class="callout info">Only owners remove members.</p>`;
    }
    const m = (await c.query(`select user_id, email, role, added_at from public.list_members($1) where user_id = $2`, [id, user]))
      .rows[0] as Member | undefined;
    if (!m) return null;
    const n = (await c.query(`select count(*)::int as n from public.member_connections($1) where user_id = $2`, [id, user])).rows[0]
      .n as number;
    return html`
      ${pageHeader({ crumb: crumb(id, v, true), title: `Remove ${label(m)}` })}
      <p class="lede">${label(m)} (${roleName(m.role)}) loses access to ${v.name} at once: its files, proposals and variables.</p>
      <ul>
        <li>${n ? html`Their ${plural(n, "agent connection")} to this vault stop working on the next request.` : "They have no agent connected to this vault."}</li>
        <li>What they wrote, proposed and approved stays, with their name on it, in the files and the activity log.</li>
        <li>To bring them back, invite them again.</li>
      </ul>
      <form method="post" action="${membersPath(id, "/remove")}" class="actions">
        ${csrfField(ctx.csrf)}<input type="hidden" name="user" value="${m.user_id}">
        <a class="button quiet" href="${membersPath(id)}">Cancel</a><button class="danger">Remove from ${v.name}</button>
      </form>`;
  });
}

async function remove(ctx: Ctx, id: string): Promise<Reply> {
  const user = ctx.form.get("user") ?? "";
  if (!UUID.test(user)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_member($1, $2, null)`, [id, user]));
    ctx.setFlash("Removed. They can no longer open this vault, and nor can their agents.");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

async function createInvite(ctx: Ctx, id: string): Promise<Reply> {
  const email = (ctx.form.get("email") ?? "").trim().toLowerCase();
  const role = ctx.form.get("role") ?? "";
  let made: { token: string; name: string } | null;
  try {
    made = await asPerson(ctx.userId, async (c) => {
      const v = await vault(c, ctx, id);
      if (!v) return null;
      const token = (await c.query(`select public.create_invite($1, $2, $3) as t`, [id, email, role])).rows[0].t as string;
      return { token, name: v.name };
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    ctx.setFlash(e.code === "54000" ? `${(e.message ?? "Too many invites").replace(/^./, (s) => s.toUpperCase())}.` : message(err));
    return { redirect: membersPath(id) };
  }
  if (!made) return notFound(ctx);
  const link = inviteLink(ctx.url.origin, made.token);
  const expires = new Date(Date.now() + 7 * 86400_000);
  const { sent } = await deliverInvite({ to: email, link, vaultName: made.name, role, expiresAt: expires });
  return membersPage(ctx, id, { email, role, link, sent, expires });
}

async function revokeInvite(ctx: Ctx, id: string, iid: string): Promise<Reply> {
  if (!UUID.test(iid)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_invite($1)`, [iid]));
    ctx.setFlash("Invite revoked. Its link no longer works.");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

async function revokeConnection(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  if (!UUID.test(tid)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_member_connection($1, $2)`, [id, tid]));
    ctx.setFlash("Connection cut off from this vault. It stops working here on its next request.");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

// ---------------------------------------------------------------------------
// Leaving a vault (public.leave_vault: a member, in person; the last owner
// can't). Settings links here; GET confirms, POST leaves.

async function leavePage(ctx: Ctx, id: string): Promise<Reply> {
  return shell(ctx, id, "Leave vault", async (c, v) => {
    const owners = (await c.query(`select count(*)::int as n from public.vault_members where vault_id = $1 and role = 'owner'`, [id]))
      .rows[0].n as number;
    const head = pageHeader({ crumb: crumb(id, v), title: `Leave ${v.name}` });
    if (v.role === "owner" && owners <= 1) {
      return html`${head}<p class="callout info">You’re the only owner of ${v.name}. Make someone else an owner on <a href="${membersPath(id)}">Members</a> first, or delete the vault.</p>`;
    }
    return html`${head}
      <p class="lede">You lose access to ${v.name} at once: its files, proposals and variables. So do your agents.</p>
      <ul>
        <li>What you wrote, proposed and approved stays, with your name on it.</li>
        <li>To come back, an owner has to invite you again.</li>
      </ul>
      <form method="post" action="${vaultPath(id, "/config/leave")}" class="actions">
        ${csrfField(ctx.csrf)}
        <a class="button quiet" href="${vaultPath(id, "/config")}">Cancel</a><button class="danger">Leave ${v.name}</button>
      </form>`;
  });
}

async function leave(ctx: Ctx, id: string): Promise<Reply> {
  try {
    const name = await asPerson(ctx.userId, async (c) => {
      const v = await vault(c, ctx, id);
      if (!v) return null;
      await c.query(`select public.leave_vault($1)`, [id]);
      return v.name;
    });
    if (name === null) return notFound(ctx);
    ctx.setFlash(`You left ${name}. You and your agents can no longer open it.`);
    return { redirect: "/" };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: vaultPath(id, "/config") };
  }
}

export async function leaveRoutes(ctx: Ctx, id: string): Promise<Reply> {
  return ctx.method === "GET" ? leavePage(ctx, id) : leave(ctx, id);
}

// ---------------------------------------------------------------------------
// Deletion notices, for Home: each shown once (public.take_deletion_notices
// deletes what it returns), within 30 days of the deletion.

type Notice = { vault_name: string; deleted_by_email: string | null; deleted_at: Date };

export async function deletionNotices(c: pg.PoolClient): Promise<Raw> {
  const rows = (await c.query(`select vault_name, deleted_by_email, deleted_at from public.take_deletion_notices()`)).rows as Notice[];
  return html`${rows.map(
    (n) => html`<p class="callout attention" role="status"><strong>${n.vault_name}</strong> was deleted by ${
      n.deleted_by_email ?? "an owner"
    } on ${n.deleted_at.toISOString().slice(0, 10)}. Its files, history and variables are gone.</p>`,
  )}`;
}

export async function membersRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  const get = ctx.method === "GET";
  if (rest === "/config/members") return get ? membersPage(ctx, id) : notFound(ctx);
  if (rest === "/config/members/remove") return get ? removePage(ctx, id) : remove(ctx, id);
  if (get) return notFound(ctx);
  if (rest === "/config/members/role") return setRole(ctx, id);
  if (rest === "/config/members/invite") return createInvite(ctx, id);
  let m = /^\/config\/members\/invites\/([^/]+)\/revoke$/.exec(rest);
  if (m) return revokeInvite(ctx, id, m[1]);
  m = /^\/config\/members\/connections\/([^/]+)\/revoke$/.exec(rest);
  if (m) return revokeConnection(ctx, id, m[1]);
  return notFound(ctx);
}

// ---------------------------------------------------------------------------
// The invite page (signed in: server.ts sends a signed-out visitor to sign
// in and back here, and the sign-in page explains the invite).

function invitePageBody(ctx: Ctx, token: string, p: Peek | undefined, me: string | null, error?: string): Raw {
  const head = (title: string) => pageHeader({ title });
  if (!p) {
    // A failure like any other: what, where, why and a reference. Unknown,
    // cut short and made-up links look the same.
    const f = failure({ status: 404, where: "invites", why: "This link isn’t a valid invite: it may be cut short, or already replaced" });
    return errorBody(f, { title: "Invite not found", lede: "This invite link isn’t valid. Check you copied all of it, or ask the person who invited you for a new one." });
  }
  if (p.state !== "pending") {
    const why = {
      accepted: "This invite has already been used.",
      revoked: "This invite was withdrawn.",
      expired: "This invite has expired: invites last 7 days.",
    }[p.state];
    return html`${head(`Invite to ${p.vaultName}`)}<p class="lede">${why} Ask the person who invited you for a new one.</p>
      <p><a href="/">Your vaults</a></p>`;
  }
  const mine = me !== null && me === p.email;
  return html`${head(`Join ${p.vaultName}`)}
    ${error ? html`<p class="callout danger" role="alert">${error}</p>` : ""}
    <p class="lede">You’ve been invited to <strong>${p.vaultName}</strong> as ${p.role === "owner" ? "an" : "a"} <strong>${roleName(p.role)}</strong>.</p>
    <p>${ROLE_TEXT[p.role]}. The invite is valid until ${when(p.expiresAt)}.</p>
    ${mine
      ? html`<form method="post" action="/invite" class="actions">
          ${csrfField(ctx.csrf)}<input type="hidden" name="token" value="${token}">
          <button class="primary">Join ${p.vaultName}</button><a class="button quiet" href="/">Not now</a>
        </form>`
      : html`<div class="callout attention" role="alert">
          <p>This invite is for <strong>${maskEmail(p.email)}</strong>, and you’re signed in as <strong>${me ?? "an account with no email"}</strong>.</p>
          ${authMode() === "supabase"
            ? html`<p>Sign out, then open the invite link again and sign in with the address it was sent to.</p>
              <form method="post" action="/signout">${csrfField(ctx.csrf)}<button class="quiet">Sign out</button></form>`
            : html`<p>Open the invite link while signed in with the address it was sent to.</p>`}
        </div>`}`;
}

async function myEmail(ctx: Ctx): Promise<string | null> {
  return asPerson(ctx.userId, async (c) => (await c.query(`select public.my_email() as e`)).rows[0].e as string | null);
}

export async function inviteRoutes(ctx: Ctx): Promise<Reply> {
  // Guessing protection: invite links opened or accepted per address
  // (ratelimit.ts), before any lookup. Fails open.
  const wait = await limit([{ name: "invite_ip", kind: "ip", value: ctx.ip }]);
  if (wait) return { status: 429, retryAfter: wait, html: tooManyPage(wait, ctx.theme, "That was too many invite links in a short time") };
  if (ctx.method === "GET") {
    const token = ctx.url.searchParams.get("token") ?? "";
    const p = await peekInvite(token);
    return { ...render(ctx, "Invite", invitePageBody(ctx, token, p, await myEmail(ctx))), status: p ? 200 : 404 };
  }
  const token = ctx.form.get("token") ?? "";
  if (!INVITE_TOKEN.test(token)) return { ...render(ctx, "Invite", invitePageBody(ctx, token, undefined, null)), status: 404 };
  try {
    const joined = await asPerson(ctx.userId, async (c) => {
      const v = (await c.query(`select public.accept_invite($1) as v`, [token])).rows[0].v as string;
      return (await vault(c, ctx, v))!;
    });
    ctx.setFlash(`You’re a member of ${joined.name}, as ${joined.role === "owner" ? "an" : "a"} ${joined.role}.`);
    return { redirect: vaultPath(joined.id) };
  } catch (err) {
    const error = message(err);
    const p = await peekInvite(token);
    return { ...render(ctx, "Invite", invitePageBody(ctx, token, p, await myEmail(ctx), error)), status: 400 };
  }
}
