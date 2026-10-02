// Members, invites and members' connections to the vault, the Members tab of the
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
//   POST /inbox/invites/join                            join from the Inbox (invite id)
//   POST /inbox/invites/decline                         decline from the Inbox (invite id)
//
// Nothing here logs an address or a token; the server logs method, path
// and status only.

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, confirmPage, csrfField, emptyState, html, pageHeader, plural, raw, time, type Raw } from "./html.js";
import { deliverInvite, INVITE_TOKEN, type Delivery, invitePageBody, inviteLink, peekInvite, ROLE_TEXT, roleName } from "./invites.js";
import { publicSiteOrigin } from "./hosts.js";
import { mailerOn } from "./mailer.js";
import { personRef } from "./people.js";
import { Refusal } from "./failure.js";
import { limit, tooManyPage } from "./ratelimit.js";
import { message, notFound, render, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { vaultShell } from "./files.js";
import { peopleFullNote, peopleLimited, peopleOver, placesText, vaultUsages, type VaultUsage } from "./plans.js";
import { settingsCrumb, settingsHeader } from "./vaultadmin.js";

const ROLES = ["viewer", "editor", "owner"] as const;
const membersPath = (id: string, rest = "") => vaultPath(id, `/config/members${rest}`);

type Member = { user_id: string; email: string | null; role: string; added_at: Date };
type Invite = { id: string; email: string | null; role: string; created_at: Date; expires_at: Date; max_uses: number; uses_count: number };
// A link's label on the Members page and its confirm pages: an address, or
// how many uses are left on an open link (never "for anyone" alone — the
// count is what an owner needs to recognise which link is which).
const inviteWho = (i: Pick<Invite, "email" | "max_uses" | "uses_count">) =>
  i.email ?? `Anyone (${i.max_uses - i.uses_count} of ${i.max_uses} use${i.max_uses === 1 ? "" : "s"} left)`;
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

// A connection as its owner's co-member sees it: its type, the words of
// the Connections page (access.ts), and the client it reported. The CLI
// reports none (it is named Reliquary CLI, and grants made before
// 20260926150000 stored "this computer", true only for its own person), so
// its detail says what it reaches instead.
const CONN_TYPE: Record<string, string> = { pat: "Token", oauth: "App", cli: "Reliquary CLI" };
export function connectionDetail(c: Pick<Conn, "kind" | "name" | "client_name">): string {
  if (c.kind === "cli") return "Reliquary CLI · environment variables";
  const type = CONN_TYPE[c.kind] ?? "Token";
  const client = !c.client_name || c.client_name === c.name ? null : c.client_name;
  return client ? `${type} · from ${client}` : type;
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

// email: the address it was made for, or null for an open link (delivery
// is never applicable then: there's no address to email it to).
// maxUses: 1 for an address-bound invite, always.
type Fresh = { email: string | null; role: string; maxUses: number; link: string; delivery?: Delivery; expires: Date };

async function membersPage(ctx: Ctx, id: string, fresh?: Fresh): Promise<Reply> {
  return shell(ctx, id, "Members", async (c, v) => {
    const owner = v.role === "owner";
    const members = (await c.query(`select user_id, email, role, added_at from public.list_members($1)`, [id])).rows as Member[];
    const invites = owner
      ? ((await c.query(`select id, email, role, created_at, expires_at, max_uses, uses_count from public.list_invites($1)`, [id])).rows as Invite[])
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
        ? fresh.email && fresh.delivery
          ? html`<div class="callout ${fresh.delivery.sent || !fresh.delivery.failure ? "success" : "warning"} reveal" role="status" id="invite-link">
              <p class="callout-title"><strong>Invite for ${fresh.email} (${roleName(fresh.role)})</strong></p>
              ${fresh.delivery.sent
                ? html`<p>We emailed them the link. It works once, for that address, until ${time(fresh.expires, { absolute: true })}.</p>`
                : html`${fresh.delivery.failure
                    ? html`<p id="invite-email-failed"><strong>The invite is made, but we couldn’t email it.</strong> ${fresh.delivery.failure.what} failed: ${fresh.delivery.failure.why.replace(/\.$/, "")} (where: ${fresh.delivery.failure.where}; ref ${fresh.delivery.failure.ref}).</p>`
                    : html`<p id="invite-not-emailed">This link wasn’t emailed: ${fresh.delivery.off ?? "no email sender is set up on this server"}.</p>`}
                  <p>Copy this link and send it to them yourself. It works once, only for someone signed in as <strong>${fresh.email}</strong>, until ${time(fresh.expires, { absolute: true })}. It won’t be shown again.</p>
                  <p class="secret">${fresh.link}</p>`}
            </div>`
          : html`<div class="callout success reveal" role="status" id="invite-link">
              <p class="callout-title"><strong>Link for anyone (${roleName(fresh.role)})</strong></p>
              <p>Copy this link and send it to whoever you’re inviting. Anyone who opens it can join ${
                fresh.maxUses === 1 ? "once" : `up to ${fresh.maxUses} times, one join per person`
              }, until ${time(fresh.expires, { absolute: true })}. It won’t be shown again.</p>
              <p class="secret">${fresh.link}</p>
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
                <thead><tr><th>Who</th><th>Role</th><th>Sent</th><th>Expires</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${invites.map(
                  (i) => html`<tr><td>${inviteWho(i)}</td><td class="small" data-label="Role">${roleName(i.role)}</td>
                    <td class="small" data-label="Sent">${time(i.created_at)}</td>
                    <td class="small" data-label="Expires">${time(i.expires_at)}</td>
                    <td class="num row-actions"><a class="button danger" href="${membersPath(id, `/invites/${i.id}/revoke`)}">Revoke</a></td></tr>`,
                )}</tbody>
              </table></div>`
            : emptyState({
                title: "No invites waiting",
                body: "An invite shows here until it is used, revoked, or expires after 7 days.",
              })}
          <h2>Connections</h2>
          <p class="section-lede">Each member’s connections that reach this vault: tokens, apps and the Reliquary CLI. Revoking one here cuts it off from ${v.name} only; the member’s other vaults keep it.</p>
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
                title: "No connections",
                body: "When a member connects a token, an app or the Reliquary CLI with access to this vault, it shows here.",
              })}`
        : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Inviting: a page of its own, reached from the Members tab's header. A
// full vault gets the reason and the way to make room instead of the form.

const MAX_USES_CAP = 100;
type InviteDraft = { error?: string; email?: string; role?: string; maxUses?: string };

async function invitePage(ctx: Ctx, id: string, d: InviteDraft = {}): Promise<Reply> {
  return shell(
    ctx,
    id,
    "Invite someone",
    async (c, v) => {
      const head = html`${pageHeader({
        crumb: membersCrumb(id, v, "Invite someone"),
        title: "Invite someone",
        description: `A link to join ${v.name}, with the role you choose.`,
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
          <input id="ie" type="text" name="email" value="${d.email ?? ""}" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" aria-describedby="ie-hint">
          <p class="hint" id="ie-hint">One person, at this address (a new account is made if they have none). Leave it blank to make a link anyone can open instead.</p>
          <label for="iu">Uses (a link with no address only)</label>
          <input id="iu" type="number" name="max_uses" value="${d.maxUses ?? "1"}" min="1" max="${MAX_USES_CAP}" inputmode="numeric" aria-describedby="iu-hint">
          <p class="hint" id="iu-hint">How many different people may join with it. Ignored, and always 1, for an invite to one address.</p>
          <fieldset>
            <legend>Role</legend>
            ${ROLES.map(
              (r) => html`<label class="choice"><input type="radio" name="role" value="${r}"${r === role ? raw(" checked") : ""}> <span>${ROLE_TEXT[r]}</span></label>`,
            )}
          </fieldset>
          <p class="hint">${mailerOn() ? "We’ll email them a link, and show it to you if the email can’t be sent." : "You’ll get a link to send them."} With no address, you get the link to send yourself instead. It lasts 7 days.${
            u && peopleLimited(u) ? ` ${v.name} has ${placesText(u)}.` : ""
          }</p>
          <div class="actions"><button class="primary">Create invite link</button><a class="button quiet" href="${membersPath(id)}">Cancel</a></div>
        </form>`;
    },
    d.error ? 400 : undefined,
  );
}

async function createInvite(ctx: Ctx, id: string): Promise<Reply> {
  const emailInput = (ctx.form.get("email") ?? "").trim().toLowerCase();
  const email = emailInput === "" ? null : emailInput;
  const role = ctx.form.get("role") ?? "";
  const maxUsesInput = (ctx.form.get("max_uses") ?? "1").trim();
  const maxUses = Number.parseInt(maxUsesInput, 10);
  if (email === null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_CAP)) {
    return invitePage(ctx, id, { error: `A link's use count is 1 to ${MAX_USES_CAP}.`, email: emailInput, role, maxUses: maxUsesInput });
  }
  let made: { token: string; name: string; maxUses: number } | null;
  try {
    made = await asPerson(ctx.userId, async (c) => {
      const v = await vault(c, ctx, id);
      if (!v) return null;
      const row = (await c.query(`select public.create_invite($1, $2, $3, $4) as t`, [id, email, role, maxUses])).rows[0] as { t: string };
      return { token: row.t, name: v.name, maxUses: email === null ? maxUses : 1 };
    });
  } catch (err) {
    // Refused: the form again, with what was typed and the reason.
    const e = err as { code?: string; message?: string };
    const error = e.code === "54000" ? `${(e.message ?? "Too many invites").replace(/^./, (s) => s.toUpperCase())}.` : message(err);
    return invitePage(ctx, id, { error, email: emailInput, role, maxUses: maxUsesInput });
  }
  if (!made) return notFound(ctx);
  const link = inviteLink(ctx.url.origin, made.token);
  const expires = new Date(Date.now() + 7 * 86400_000);
  const delivery = email
    ? await deliverInvite({ to: email, link, token: made.token, vaultName: made.name, role, expiresAt: expires }, publicSiteOrigin(new URL(link).origin))
    : undefined;
  return membersPage(ctx, id, { email, role, maxUses: made.maxUses, link, delivery, expires });
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
        n ? `Their ${plural(n, "connection")} to this vault stop working on the next request.` : "They have no connections to this vault.",
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
    const i = (await c.query(`select id, email, role, created_at, expires_at, max_uses, uses_count from public.list_invites($1) where id = $2`, [id, iid]))
      .rows[0] as Invite | undefined;
    if (!i) return null;
    const who = inviteWho(i);
    return confirmPage({
      title: `Revoke the invite for ${who}`,
      crumb: membersCrumb(id, v, "Revoke invite"),
      lede: html`The link for <strong>${who}</strong> (${roleName(i.role)}) stops working at once, so it can’t be used to join ${v.name} again.`,
      consequences: [
        i.uses_count > 0
          ? `Already joined with it: nobody loses access. Only the ${
              i.max_uses - i.uses_count === 1 ? "one use" : `${i.max_uses - i.uses_count} uses`
            } left stop working.`
          : "Nobody has joined with it yet, so nobody loses access.",
        "Its place is free again for another invite.",
        "To invite again later, make a new invite: it has a new link.",
      ],
      action: membersPath(id, `/invites/${i.id}/revoke`),
      csrf: ctx.csrf,
      button: `Revoke invite for ${who}`,
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
      return html`${pageHeader({ crumb: membersCrumb(id, v, "Revoke connection"), title: "Revoke connection" })}${callout("info", "Only owners revoke the connections members have to this vault.")}`;
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
          ? "It keeps working in their other vaults. Only they can revoke it everywhere, on their Connections page."
          : "If it reaches other vaults of theirs, it keeps working there. Only they can revoke it everywhere, on their Connections page.",
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

// ---------------------------------------------------------------------------
// Invites answered from the Inbox (20260926140000_inbox_join.sql): Join or
// Decline by the invite's id, which my_invites gives its addressee only.
// The database decides: the caller in person (no agent, token or grant),
// with the invite's address confirmed on their account, the invite still
// waiting, and room in the vault. A refusal comes back to the Inbox with
// its reason and reference.
export async function inboxInviteRoutes(ctx: Ctx, action: "join" | "decline"): Promise<Reply> {
  const id = ctx.form.get("invite") ?? "";
  try {
    if (!UUID.test(id)) {
      throw new Refusal({
        status: 400,
        where: `web app (Inbox, ${action === "join" ? "Join" : "Decline"})`,
        why: "The form didn’t say which invite: reload your inbox and try again",
      });
    }
    if (action === "decline") {
      const name = await asPerson(ctx.userId, async (c) =>
        (await c.query(`select public.decline_my_invite($1) as name`, [id])).rows[0].name as string,
      );
      ctx.setFlash(`You declined the invite to ${name}. Its owners can see that in the vault’s activity; to join later, ask them for a new invite.`, "success");
      return { redirect: "/inbox" };
    }
    const joined = await asPerson(ctx.userId, async (c) => {
      const v = (await c.query(`select public.accept_my_invite($1) as v`, [id])).rows[0].v as string;
      return (await vault(c, ctx, v))!;
    });
    ctx.setFlash(`You’re a member of ${joined.name}, as ${joined.role === "owner" ? "an" : "a"} ${joined.role}.`, "success");
    return { redirect: vaultPath(joined.id) };
  } catch (err) {
    ctx.setFlash(message(err), "danger");
    return { redirect: "/inbox#invites" };
  }
}
