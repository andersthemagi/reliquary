// Invite links (supabase/migrations/20260925140000_invites.sql).
//
// An invite is a single-use token (`rli_` + 64 hex) that the database makes,
// stores as its SHA-256 and returns once. The link is
// <site>/invite?token=<token>: the token rides in the query string, which
// the server never logs (it logs the path only), and the Referrer-Policy
// keeps it on this site.
//
// Delivery: deliverInvite() emails the link (vaultInviteEmail() in
// emails.ts, web/emails/vault-invite.html) through Resend (mailer.ts) when
// the server has RESEND_API_KEY and EMAIL_FROM. Without them, or when Resend
// refuses or doesn't answer, the invite stays made and the Members page
// shows the link for the owner to copy and send themself, with why it wasn't
// emailed (and a reference, for a failure). Neither the link nor the address
// is ever logged.

import { authMode } from "./auth.js";
import { pool } from "./db.js";
import { vaultInviteEmail } from "./emails.js";
import { errorBody } from "./errorpage.js";
import { fail, failure, type Failure } from "./failure.js";
import { csrfField, html, pageHeader, when, type Raw } from "./html.js";
import { idempotencyKey, mailerOffReason, sendEmail } from "./mailer.js";
import type { Ctx } from "./pages.js";

export const INVITE_TOKEN = /^rli_[0-9a-f]{64}$/;

export type InviteMail = {
  to: string; // the invited address
  link: string; // the invite link; a bearer secret
  token: string; // the link's token (for the idempotency key only)
  vaultName: string;
  role: string;
  expiresAt: Date;
};

export type Delivery = { sent: true } | { sent: false; off?: string; failure?: Failure };

// Emails one invite. The idempotency key is derived from the token (never
// equal to it, nor to the hash the database keeps), so mailer.ts's retry
// never sends a second copy. `siteUrl` is what the email's footer links to.
export async function deliverInvite(mail: InviteMail, siteUrl: string): Promise<Delivery> {
  const off = mailerOffReason();
  if (off) return { sent: false, off };
  let subject: string;
  let body: string;
  try {
    ({ subject, html: body } = vaultInviteEmail(mail, siteUrl));
  } catch (err) {
    // A deploy without web/emails/ (netlify.toml's included_files): the link
    // is still shown, with this reason and its ref.
    return { sent: false, failure: fail(err, { where: "email template (web/emails/vault-invite.html)", what: "Emailing the invite", status: 500 }) };
  }
  const r = await sendEmail({
    to: mail.to,
    subject,
    html: body,
    idempotencyKey: idempotencyKey("vault-invite", mail.token),
    tag: "vault-invite",
    what: "Emailing the invite",
  });
  return r.sent ? { sent: true } : { sent: false, off: r.off, failure: r.failure };
}

// The site's own origin for links: PUBLIC_URL when hosted, else the
// origin the request came to (dev and tests).
export function inviteLink(requestOrigin: string, token: string): string {
  let origin = requestOrigin;
  if (process.env.PUBLIC_URL) {
    try {
      origin = new URL(process.env.PUBLIC_URL).origin;
    } catch {
      // server.ts refuses to start with a bad PUBLIC_URL; keep the request's
    }
  }
  return `${origin}/invite?token=${token}`;
}

export type Peek = {
  state: "pending" | "accepted" | "revoked" | "expired" | "declined";
  vaultId: string;
  vaultName: string;
  role: string;
  email: string | null; // null: an open link, good for anyone who holds it
  maxUses: number;
  usesCount: number;
  expiresAt: Date;
};

// What a link is for, as the web app's own role (no person): the invite
// page before and after sign-in, and the sign-in page for an invitee.
// Undefined for anything that isn't a live row's token.
export async function peekInvite(token: string): Promise<Peek | undefined> {
  if (!INVITE_TOKEN.test(token)) return undefined;
  const { rows } = await pool.query(
    "select state, vault_id, vault_name, role, email, expires_at, max_uses, uses_count from private.invite_peek($1)",
    [token],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    state: r.state, vaultId: r.vault_id, vaultName: r.vault_name, role: r.role, email: r.email,
    maxUses: r.max_uses, usesCount: r.uses_count, expiresAt: r.expires_at,
  };
}

// Uses left on a link: 1, always, for an address-bound invite.
export const usesLeft = (p: Peek): number => p.maxUses - p.usesCount;

// The token of an invite page URL (`/invite?token=...`), for the sign-in
// page's `next`.
export function inviteTokenOf(next: string): string | undefined {
  try {
    const u = new URL(next, "http://x");
    const t = u.searchParams.get("token") ?? "";
    return u.pathname === "/invite" && INVITE_TOKEN.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

// An address as Reliquary compares it: private.email_key in the database
// (trimmed, Unicode NFC, lower-cased). Auth stores an accented address in a
// different form than people type it, so anything here that compares or
// counts an address must use this and not toLowerCase(), or the same
// address is two in JavaScript and one in the database.
export const emailKey = (email: string): string => email.trim().normalize("NFC").toLowerCase();

// "fay@example.com" -> "f•••@example.com": enough to recognise your own
// address on a page anyone holding the link could open.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export const ROLE_TEXT: Record<string, string> = {
  owner: "Owner: everything an editor can do, plus rules, members, export and deletion",
  editor: "Editor: read, write open files, propose and approve changes to canon",
  viewer: "Viewer: read only",
};

export const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

// ---------------------------------------------------------------------------
// The invite page (signed in: server.ts sends a signed-out visitor to sign
// in and back here, and the sign-in page explains the invite). members.ts
// inviteRoutes() serves it.

export function invitePageBody(ctx: Ctx, token: string, p: Peek | undefined, me: string | null, error?: string): Raw {
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
      declined: "You declined this invite.",
    }[p.state];
    return html`${head(`Invite to ${p.vaultName}`)}<p class="lede">${why} Ask the person who invited you for a new one.</p>
      <p><a href="/">Your vaults</a></p>`;
  }
  // An open link (no address) is anyone's to take, whoever they're signed
  // in as; an address-bound invite is only its address's.
  const mine = p.email === null || (me !== null && me === p.email);
  const left = usesLeft(p);
  return html`${head(`Join ${p.vaultName}`)}
    ${error ? html`<p class="callout danger" role="alert">${error}</p>` : ""}
    <p class="lede">You’ve been invited to <strong>${p.vaultName}</strong> as ${p.role === "owner" ? "an" : "a"} <strong>${roleName(p.role)}</strong>.</p>
    <p>${ROLE_TEXT[p.role]}. The invite is valid until ${when(p.expiresAt)}${
      p.maxUses > 1 ? html` and can still be used ${left} more time${left === 1 ? "" : "s"}` : ""
    }.</p>
    ${mine
      ? html`<form method="post" action="/invite" class="actions">
          ${csrfField(ctx.csrf)}<input type="hidden" name="token" value="${token}">
          <button class="primary">Join ${p.vaultName}</button><a class="button quiet" href="/">Not now</a>
        </form>`
      : html`<div class="callout attention" role="alert">
          <p>This invite is for <strong>${maskEmail(p.email as string)}</strong>, and you’re signed in as <strong>${me ?? "an account with no email"}</strong>.</p>
          ${authMode() === "supabase"
            ? html`<p>Sign out, then open the invite link again and sign in with the address it was sent to.</p>
              <form method="post" action="/signout">${csrfField(ctx.csrf)}<button class="quiet">Sign out</button></form>`
            : html`<p>Open the invite link while signed in with the address it was sent to.</p>`}
        </div>`}`;
}
