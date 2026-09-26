// Members, invites and members' agent connections, the Members tab of the
// vault's Settings (/v/:id/config/members), and the invite page
// (/invite?token=...). supabase/migrations/20260925140000_invites.sql
// decides everything: every function it calls is an owner's (or, for
// accepting, the invitee's) in person. These pages only choose what to
// offer.
//
//   GET  /v/:id/config/members                          members, invites, connections
//   POST /v/:id/config/members/role                     change a role (user, role)
//   GET  /v/:id/config/members/remove?user=             confirm; POST removes
//   GET  /v/:id/config/members/invite                   the invite form (or why not: a full vault)
//   POST /v/:id/config/members/invite                   make an invite; shows its link once
//   GET  /v/:id/config/members/invites/:iid/revoke      confirm; POST revokes
//   GET  /v/:id/config/members/connections/:tid/revoke  confirm; POST cuts it off from this vault
//   GET  /v/:id/config/leave                            confirm leaving; POST leaves
//   GET  /invite?token=                                 what the invite is; Accept
//   POST /invite                                        accept (token)
//
// Nothing here logs an address or a token; the server logs method, path
// and status only.

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, confirmPage, csrfField, emptyState, html, pageHeader, raw, time, type Raw } from "./html.js";
import { deliverInvite, INVITE_TOKEN, invitePageBody, inviteLink, peekInvite, ROLE_TEXT, roleName } from "./invites.js";
import { personRef } from "./people.js";
import { limit, tooManyPage } from "./ratelimit.js";
import { message, notFound, render, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { vaultShell } from "./files.js";
import { peopleFullNote, peopleLimited, peopleOver, placesText, vaultUsages, type VaultUsage } from "./plans.js";
import { settingsCrumb, settingsHeader } from "./vaultadmin.js";

const ROLES = ["viewer", "editor", "owner"] as const;
const membersPath = (id: string, rest = "") => vaultPath(id, `/config/members${rest}`);
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
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
};

// By email, with their display name when they gave one (people.ts fills it in).
const label = (m: { email: string | null; user_id: string }) => (m.email ? personRef(m.user_id) : `Account ${m.user_id.slice(0, 8)}`);

// A connection as its owner's co-member sees it. The CLI's sign-in stores
// the client name "this computer" (create_cli_grant), which is true for the
// person who signed in and wrong for anyone else reading it, so it is never
// shown here: the CLI is named once, with what it does.
const CONN_KIND: Record<string, string> = { cli: "Command-line sign-in", oauth: "MCP app" };
export function connectionDetail(c: Pick<Conn, "kind" | "name" | "client_name">): string {
  const kind = CONN_KIND[c.kind] ?? "MCP token";
  const client = c.kind === "cli" || !c.client_name || c.client_name === "this computer" || c.client_name === c.name ? null : c.client_name;
  return client ? `${kind} · from ${client}` : kind;
}
const accessText = (c: Conn) => (c.kind === "cli" ? "Environment variables" : c.access === "write" ? "Read and write" : "Read only");

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

const membersCrumb = (id: string, v: Vault, here: string) =>
  settingsCrumb(id, v, { label: "Members", href: membersPath(id) }, { label: here });

const usageOf = async (c: pg.PoolClient, id: string): Promise<VaultUsage | undefined> => (await vaultUsages(c, [id])).get(id);
const full = (u: VaultUsage | undefined) => !!u && peopleLimited(u) && peopleOver(u);

// ---------------------------------------------------------------------------
// The Members tab

type Fresh = { email: string; role: string; link: string; sent: boolean; expires: Date };

async function membersPage(ctx: Ctx, id: string, fresh?: Fresh): Promise<Reply> {
  return shell(ctx, id, "Members", async (c, v) => {
    const owner = v.role === "owner";
    const members = (await c.query(`select user_id, email, role, added_at from public.list_members($1)`, [id])).rows as Member[];
    const invites = owner
      ? ((await c.query(`select id, email, role, created_at, expires_at from public.list_invites($1)`, [id])).rows as Invite[])
      : [];
    const conns = owner
      ? ((
          await c.query(
            `select id, user_id, name, kind, client_name, access, all_vaults, created_at, last_used_at, expires_at
               from public.member_connections($1)`,
            [id],
          )
        ).rows as Conn[])
      : [];
    const u = await usageOf(c, id);
    const noRoom = owner && full(u);
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

    const invite = !owner
      ? ""
      : noRoom
        ? html`<button type="button" class="primary" disabled title="No places left: see below">Invite someone</button>`
        : html`<a class="button primary" href="${membersPath(id, "/invite")}">Invite someone</a>`;

    return html`
      ${settingsHeader(id, v, "members", {
        description: `The people in ${v.name} and what each can do.`,
        primary: invite,
      })}
      ${fresh
        ? html`<div class="callout success reveal" role="status" id="invite-link">
            <p class="callout-title"><strong>Invite for ${fresh.email} (${roleName(fresh.role)})</strong></p>
            ${fresh.sent
              ? html`<p>We emailed them the link. It works once, for that address, until ${time(fresh.expires, { absolute: true })}.</p>`
              : html`<p>Copy this link and send it to them yourself: Reliquary doesn’t email invites yet. It works once, only for someone signed in as <strong>${fresh.email}</strong>, until ${time(fresh.expires, { absolute: true })}. It won’t be shown again.</p>
                <p class="secret">${fresh.link}</p>`}
          </div>`
        : ""}
      ${noRoom && u ? peopleFullNote(u, v.name) : ""}
      ${owner && owners === 1 && members.length > 1
        ? callout("info", "This vault has one owner. Two are recommended, so someone can carry on if the owner can’t.")
        : ""}
      <div class="section-head"><h2>People</h2>${u && peopleLimited(u) ? html`<p class="section-meta">${placesText(u)}</p>` : ""}</div>
      <div class="table-wrap"><table class="table-stack member-list">
        <thead><tr><th>Member</th><th>Role</th><th>Joined</th>${owner ? html`<th><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
        <tbody>${members.map(
          (m) => html`<tr><td>${label(m)}${m.user_id === ctx.userId ? html` <span class="badge">You</span>` : ""}</td>
            <td class="small" data-label="Role">${roleCell(m)}</td>
            <td class="small" data-label="Joined">${time(m.added_at)}</td>
            ${owner
              ? html`<td class="num row-actions">${m.user_id === ctx.userId || (m.role === "owner" && owners <= 1)
                  ? ""
                  : html`<a class="button quiet" href="${membersPath(id, `/remove?user=${m.user_id}`)}">Remove</a>`}</td>`
              : ""}</tr>`,
        )}</tbody>
      </table></div>
      <p class="hint">Agents act as their person, but never approve, manage members, reveal a value, export or delete. <a href="/docs/concepts/agents">Agents and the ceiling</a></p>
      ${owner ? "" : html`<p class="hint">Only owners invite people, change roles or remove members.</p>`}
      ${owner
        ? html`
          <h2>Pending invites</h2>
          ${invites.length
            ? html`<div class="table-wrap"><table class="table-stack token-list invite-list">
                <thead><tr><th>Email</th><th>Role</th><th>Sent</th><th>Expires</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${invites.map(
                  (i) => html`<tr><td>${i.email}</td><td class="small" data-label="Role">${roleName(i.role)}</td>
                    <td class="small" data-label="Sent">${time(i.created_at)}</td>
                    <td class="small" data-label="Expires">${time(i.expires_at)}</td>
                    <td class="num row-actions"><a class="button danger" href="${membersPath(id, `/invites/${i.id}/revoke`)}">Revoke</a></td></tr>`,
                )}</tbody>
              </table></div>`
            : emptyState({
                title: "No invites waiting",
                body: "An invite shows here until it is used, revoked, or expires after 7 days.",
              })}
          <h2>Agent connections</h2>
          <p class="section-lede">The tokens, apps and command-line sign-ins each member has that reach this vault. Revoking one here cuts it off from ${v.name} only; the member’s other vaults keep it.</p>
          ${conns.length
            ? html`<div class="table-wrap"><table class="table-stack token-list connection-list">
                <thead><tr><th>Connection</th><th>Member</th><th>Access</th><th>Created</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${members.flatMap((m) =>
                  (byUser.get(m.user_id) ?? []).map(
                    (cn) => html`<tr><td><span class="conn-name">${cn.name}</span><span class="muted token-client">${connectionDetail(cn)}</span></td>
                      <td class="small" data-label="Member">${label(m)}</td>
                      <td class="small" data-label="Access">${accessText(cn)}${cn.all_vaults ? html`<span class="muted token-client">All their vaults</span>` : ""}</td>
                      <td class="small" data-label="Created">${time(cn.created_at)}</td>
                      <td class="small" data-label="Last used">${cn.last_used_at ? time(cn.last_used_at) : "Never"}</td>
                      <td class="num row-actions"><a class="button danger" href="${membersPath(id, `/connections/${cn.id}/revoke`)}">Revoke</a></td></tr>`,
                  ),
                )}</tbody>
              </table></div>`
            : emptyState({
                title: "No agent connections",
                body: "When a member connects an agent or the CLI with access to this vault, it shows here.",
              })}`
        : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Inviting: a page of its own, reached from the Members tab's header. A
// full vault gets the reason and the way to make room instead of the form.

type InviteDraft = { error?: string; email?: string; role?: string };

async function invitePage(ctx: Ctx, id: string, d: InviteDraft = {}): Promise<Reply> {
  return shell(
    ctx,
    id,
    "Invite someone",
    async (c, v) => {
      const head = html`${pageHeader({
        crumb: membersCrumb(id, v, "Invite someone"),
        title: "Invite someone",
        description: `A link that lets one person join ${v.name}, with the role you choose.`,
      })}${d.error ? callout("danger", d.error) : ""}`;
      if (v.role !== "owner") return html`${head}${d.error ? "" : callout("info", "Only owners invite people.")}`;
      const u = await usageOf(c, id);
      if (u && full(u)) {
        return html`${head}${peopleFullNote(u, v.name)}
          <p class="actions"><a class="button secondary" href="${membersPath(id)}">Back to Members</a></p>`;
      }
      const role = ROLES.includes(d.role as (typeof ROLES)[number]) ? d.role : "editor";
      return html`${head}
        <form method="post" action="${membersPath(id, "/invite")}" class="panel choice-form invite-form">
          ${csrfField(ctx.csrf)}
          <label for="ie">Email</label>
          <input id="ie" type="text" name="email" value="${d.email ?? ""}" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" required aria-describedby="ie-hint">
          <p class="hint" id="ie-hint">They sign in with this address (a new account is made if they have none).</p>
          <fieldset>
            <legend>Role</legend>
            ${ROLES.map(
              (r) => html`<label class="choice"><input type="radio" name="role" value="${r}"${r === role ? raw(" checked") : ""}> <span>${ROLE_TEXT[r]}</span></label>`,
            )}
          </fieldset>
          <p class="hint">You’ll get a link to send them. It works once, for that address only, for 7 days.${
            u && peopleLimited(u) ? ` ${v.name} has ${placesText(u)}.` : ""
          }</p>
          <div class="actions"><button class="primary">Create invite link</button><a class="button quiet" href="${membersPath(id)}">Cancel</a></div>
        </form>`;
    },
    d.error ? 400 : undefined,
  );
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
    // Refused: the form again, with what was typed and the reason.
    const e = err as { code?: string; message?: string };
    const error = e.code === "54000" ? `${(e.message ?? "Too many invites").replace(/^./, (s) => s.toUpperCase())}.` : message(err);
    return invitePage(ctx, id, { error, email, role });
  }
  if (!made) return notFound(ctx);
  const link = inviteLink(ctx.url.origin, made.token);
  const expires = new Date(Date.now() + 7 * 86400_000);
  const { sent } = await deliverInvite({ to: email, link, vaultName: made.name, role, expiresAt: expires });
  return membersPage(ctx, id, { email, role, link, sent, expires });
}

// ---------------------------------------------------------------------------
// Roles and removal

async function setRole(ctx: Ctx, id: string): Promise<Reply> {
  const user = ctx.form.get("user") ?? "";
  const role = ctx.form.get("role") ?? "";
  if (!UUID.test(user)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_member($1, $2, $3)`, [id, user, role]));
    ctx.setFlash(`Role changed to ${roleName(role)}.`, "success");
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
      return html`${pageHeader({ crumb: membersCrumb(id, v, "Remove"), title: "Remove member" })}${callout("info", "Only owners remove members.")}`;
    }
    const m = (await c.query(`select user_id, email, role, added_at from public.list_members($1) where user_id = $2`, [id, user]))
      .rows[0] as Member | undefined;
    if (!m) return null;
    const n = (await c.query(`select count(*)::int as n from public.member_connections($1) where user_id = $2`, [id, user])).rows[0]
      .n as number;
    return confirmPage({
      title: `Remove ${label(m)}`,
      crumb: membersCrumb(id, v, "Remove"),
      lede: `${label(m)} (${roleName(m.role)}) loses access to ${v.name} at once: its files, proposals and variables.`,
      consequences: [
        n ? `Their ${plural(n, "agent connection")} to this vault stop working on the next request.` : "They have no agent connected to this vault.",
        "What they wrote, proposed and approved stays, with their name on it, in the files and the activity log.",
        "To bring them back, invite them again.",
      ],
      action: membersPath(id, "/remove"),
      csrf: ctx.csrf,
      fields: { user: m.user_id },
      button: `Remove from ${v.name}`,
      cancel: membersPath(id),
    });
  });
}

async function remove(ctx: Ctx, id: string): Promise<Reply> {
  const user = ctx.form.get("user") ?? "";
  if (!UUID.test(user)) return notFound(ctx);
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_member($1, $2, null)`, [id, user]));
    ctx.setFlash("Removed. They can no longer open this vault, and nor can their agents.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

// ---------------------------------------------------------------------------
// Revoking an invite, and cutting off a member's connection: each asks
// first, naming what stops working.

async function revokeInvitePage(ctx: Ctx, id: string, iid: string): Promise<Reply> {
  return shell(ctx, id, "Revoke invite", async (c, v) => {
    if (v.role !== "owner") {
      return html`${pageHeader({ crumb: membersCrumb(id, v, "Revoke invite"), title: "Revoke invite" })}${callout("info", "Only owners revoke invites.")}`;
    }
    const i = (await c.query(`select id, email, role, created_at, expires_at from public.list_invites($1) where id = $2`, [id, iid]))
      .rows[0] as Invite | undefined;
    if (!i) return null;
    return confirmPage({
      title: `Revoke the invite for ${i.email}`,
      crumb: membersCrumb(id, v, "Revoke invite"),
      lede: html`The link for <strong>${i.email}</strong> (${roleName(i.role)}) stops working at once, so they can’t join ${v.name} with it.`,
      consequences: [
        "Nobody has joined with it yet, so nobody loses access.",
        "Its place is free again for another invite.",
        "To invite them later, make a new invite: it has a new link.",
      ],
      action: membersPath(id, `/invites/${i.id}/revoke`),
      csrf: ctx.csrf,
      button: `Revoke invite for ${i.email}`,
      cancel: membersPath(id),
    });
  });
}

async function revokeInvite(ctx: Ctx, id: string, iid: string): Promise<Reply> {
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_invite($1)`, [iid]));
    ctx.setFlash("Invite revoked. Its link no longer works.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

async function revokeConnectionPage(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  return shell(ctx, id, "Revoke connection", async (c, v) => {
    if (v.role !== "owner") {
      return html`${pageHeader({ crumb: membersCrumb(id, v, "Revoke connection"), title: "Revoke connection" })}${callout("info", "Only owners revoke agent connections.")}`;
    }
    const cn = (
      await c.query(
        `select id, user_id, name, kind, client_name, access, all_vaults, created_at, last_used_at, expires_at
           from public.member_connections($1) where id = $2`,
        [id, tid],
      )
    ).rows[0] as Conn | undefined;
    if (!cn) return null;
    const m = (await c.query(`select user_id, email from public.list_members($1) where user_id = $2`, [id, cn.user_id])).rows[0] as
      | Pick<Member, "user_id" | "email">
      | undefined;
    const who = m ? label(m) : "The member";
    return confirmPage({
      title: `Revoke ${cn.name} for ${v.name}`,
      crumb: membersCrumb(id, v, "Revoke connection"),
      lede: html`${who}’s <strong>${cn.name}</strong> (${connectionDetail(cn)}) stops reaching ${v.name} on its next request.`,
      consequences: [
        cn.all_vaults
          ? "It keeps working in their other vaults. Only they can revoke it everywhere, on their Tokens page."
          : "If it reaches other vaults of theirs, it keeps working there. Only they can revoke it everywhere, on their Tokens page.",
        "Nothing it wrote or proposed is undone.",
        "To reach this vault again, they connect again.",
      ],
      action: membersPath(id, `/connections/${cn.id}/revoke`),
      csrf: ctx.csrf,
      button: `Revoke ${cn.name}`,
      cancel: membersPath(id),
    });
  });
}

async function revokeConnection(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.revoke_member_connection($1, $2)`, [id, tid]));
    ctx.setFlash("Connection cut off from this vault. It stops working here on its next request.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: membersPath(id) };
}

// ---------------------------------------------------------------------------
// Leaving a vault (public.leave_vault: a member, in person; the last owner
// can't). The Danger zone tab links here; GET confirms, POST leaves.

async function leavePage(ctx: Ctx, id: string): Promise<Reply> {
  return shell(ctx, id, "Leave vault", async (c, v) => {
    const owners = (await c.query(`select count(*)::int as n from public.vault_members where vault_id = $1 and role = 'owner'`, [id]))
      .rows[0].n as number;
    const where = settingsCrumb(id, v, { label: "Danger zone", href: vaultPath(id, "/config/danger") }, { label: "Leave" });
    if (v.role === "owner" && owners <= 1) {
      return html`${pageHeader({ crumb: where, title: `Leave ${v.name}` })}${callout(
        "info",
        html`<p>You’re the only owner of ${v.name}. Make someone else an owner on <a href="${membersPath(id)}">Members</a> first, or delete the vault.</p>`,
      )}`;
    }
    return confirmPage({
      title: `Leave ${v.name}`,
      crumb: where,
      lede: `You lose access to ${v.name} at once: its files, proposals and variables. So do your agents.`,
      consequences: ["What you wrote, proposed and approved stays, with your name on it.", "To come back, an owner has to invite you again."],
      action: vaultPath(id, "/config/leave"),
      csrf: ctx.csrf,
      button: `Leave ${v.name}`,
      cancel: vaultPath(id, "/config/danger"),
    });
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
    ctx.setFlash(`You left ${name}. You and your agents can no longer open it.`, "success");
    return { redirect: "/" };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: vaultPath(id, "/config/danger") };
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
  if (rest === "/config/members/invite") return get ? invitePage(ctx, id) : createInvite(ctx, id);
  if (rest === "/config/members/role") return get ? notFound(ctx) : setRole(ctx, id);
  let m = /^\/config\/members\/invites\/([^/]+)\/revoke$/.exec(rest);
  if (m) {
    if (!UUID.test(m[1])) return notFound(ctx);
    return get ? revokeInvitePage(ctx, id, m[1]) : revokeInvite(ctx, id, m[1]);
  }
  m = /^\/config\/members\/connections\/([^/]+)\/revoke$/.exec(rest);
  if (m) {
    if (!UUID.test(m[1])) return notFound(ctx);
    return get ? revokeConnectionPage(ctx, id, m[1]) : revokeConnection(ctx, id, m[1]);
  }
  return notFound(ctx);
}


// ---------------------------------------------------------------------------
// The invite page (signed in: server.ts sends a signed-out visitor to sign
// in and back here, and the sign-in page explains the invite). The page's
// body is invites.ts invitePageBody().

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
    ctx.setFlash(`You’re a member of ${joined.name}, as ${joined.role === "owner" ? "an" : "a"} ${joined.role}.`, "success");
    return { redirect: vaultPath(joined.id) };
  } catch (err) {
    const error = message(err);
    const p = await peekInvite(token);
    return { ...render(ctx, "Invite", invitePageBody(ctx, token, p, await myEmail(ctx), error)), status: 400 };
  }
}
