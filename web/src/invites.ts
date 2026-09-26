// Invite links (supabase/migrations/20260925140000_invites.sql).
//
// An invite is a single-use token (`rli_` + 64 hex) that the database makes,
// stores as its SHA-256 and returns once. The link is
// <site>/invite?token=<token>: the token rides in the query string, which
// the server never logs (it logs the path only), and the Referrer-Policy
// keeps it on this site.
//
// Delivery: there is no email sender yet, so deliverInvite() says it sent
// nothing and the Members page shows the link for the owner to copy and send
// themself. To send email later, replace the body of deliverInvite() (one
// function; nothing else changes): send vaultInviteEmail(mail, origin)
// (emails.ts, web/emails/vault-invite.html) to `to`, and return
// { sent: true }. It must never log the link or the address.

import { pool } from "./db.js";

export const INVITE_TOKEN = /^rli_[0-9a-f]{64}$/;

export type InviteMail = {
  to: string; // the invited address
  link: string; // the invite link; a bearer secret
  vaultName: string;
  role: string;
  expiresAt: Date;
};

// The one place an email sender plugs in.
export async function deliverInvite(_mail: InviteMail): Promise<{ sent: boolean }> {
  return { sent: false };
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
  state: "pending" | "accepted" | "revoked" | "expired";
  vaultId: string;
  vaultName: string;
  role: string;
  email: string;
  expiresAt: Date;
};

// What a link is for, as the web app's own role (no person): the invite
// page before and after sign-in, and the sign-in page for an invitee.
// Undefined for anything that isn't a live row's token.
export async function peekInvite(token: string): Promise<Peek | undefined> {
  if (!INVITE_TOKEN.test(token)) return undefined;
  const { rows } = await pool.query(
    "select state, vault_id, vault_name, role, email, expires_at from private.invite_peek($1)",
    [token],
  );
  const r = rows[0];
  if (!r) return undefined;
  return { state: r.state, vaultId: r.vault_id, vaultName: r.vault_name, role: r.role, email: r.email, expiresAt: r.expires_at };
}

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
