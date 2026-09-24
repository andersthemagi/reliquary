// Sign-in pages for AUTH_MODE=supabase (docs/research/hosting.md, section 3).
// Plain forms, no script:
//
//   GET  /signin            email form (?next=/local/path to come back to)
//   POST /signin            asks Supabase to email a code and a link, then
//                           shows the code form. The same page for every
//                           address: whether one has an account never shows.
//   POST /signin/code       6-digit code (with the email) -> session
//   GET  /auth/confirm      the emailed link lands here: a page with one
//                           Sign in button, so a mail scanner fetching the
//                           link doesn't burn it
//   POST /auth/confirm      token_hash -> session
//
// The server has already checked Origin on POSTs. These forms carry the
// double-submit token from auth.ts instead of a session CSRF token.
// Nothing here logs; the server logs method, path and status only.
//
// Invites (members.ts): a signed-out invitee is sent here with
// next=/invite?token=... . The pages then say what they were invited to and
// which address to use, and for exactly the invited address (checked with
// the database) sign-in may create the account; any other address signs in
// as usual, never creating one.

import type http from "node:http";
import {
  clearCookie,
  clearPreToken,
  cookieName,
  preToken,
  preTokenOk,
  readCookie,
  sendSigninEmail,
  setCookie,
  verifySignin,
  type Session,
} from "./auth.js";
import { html, notice, page, type Theme } from "./html.js";
import { inviteTokenOf, maskEmail, peekInvite, type Peek } from "./invites.js";
import type { Reply } from "./pages.js";

// The live invite a sign-in is for, if `next` is an invite page.
async function inviteFor(next: string): Promise<Peek | undefined> {
  const token = inviteTokenOf(next);
  if (!token) return undefined;
  try {
    const p = await peekInvite(token);
    return p?.state === "pending" ? p : undefined;
  } catch {
    return undefined;
  }
}

export const SIGNIN_PATHS = new Set(["/signin", "/signin/code", "/auth/confirm"]);

// Where to go after signing in: a local path only (never //host or /\host),
// so the sign-in page can't be used to bounce someone to another site.
export function safeNext(value: string | null | undefined): string {
  const v = value ?? "";
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.length > 3000) return "/";
  if (/[\x00-\x1f\x7f\\]/.test(v)) return "/";
  try {
    const u = new URL(v, "http://x");
    if (u.origin !== "http://x" || SIGNIN_PATHS.has(u.pathname)) return "/";
  } catch {
    return "/";
  }
  return v;
}

// The sign-in URL that comes back to `next` afterwards (for chunk C's
// /oauth/authorize, and for pages reached while signed out).
export const signinUrl = (next: string) => (safeNext(next) === "/" ? "/signin" : `/signin?next=${encodeURIComponent(safeNext(next))}`);

const NEXT = "rlq_next";
const EMAIL = /^[^\s@<>()",;:\\]{1,64}@[^\s@<>()",;:\\]{1,190}\.[^\s@<>()",;:\\]{1,63}$/;
const CODE = /^[0-9]{6,10}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

type In = {
  req: http.IncomingMessage;
  method: string;
  url: URL;
  form: URLSearchParams;
  theme: Theme;
  session: Session | null;
};
type Out = { reply: Reply; cookies: string[] };

const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

function emailForm(csrf: string, next: string, theme: Theme, error?: string, invite?: Peek): string {
  return page(
    "Sign in",
    html`<div class="signin">
      ${invite
        ? html`<h1>Join ${invite.vaultName}</h1>
          <p class="lede">You’ve been invited to <strong>${invite.vaultName}</strong> on Reliquary. Sign in with the address the invite was sent to, <strong>${maskEmail(invite.email)}</strong>: we’ll email it a sign-in link and a 6-digit code. New to Reliquary? The same step makes your account.</p>`
        : html`<h1>Sign in to Reliquary</h1>
          <p class="lede">We’ll email you a sign-in link and a 6-digit code.</p>`}
      ${error ? html`<p class="callout attention" role="alert">${error}</p>` : ""}
      <form method="post" action="/signin" class="panel">
        ${hidden("csrf", csrf)}${hidden("next", next)}
        <label for="email">Email</label>
        <input type="text" id="email" name="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required>
        <div class="actions"><button class="primary">Email me a code</button></div>
      </form>
      ${invite ? "" : html`<p class="hint">Reliquary is invite-only: ask the person who runs your vault to add you.</p>`}
    </div>`,
    { theme },
  );
}

function codeForm(csrf: string, email: string, next: string, theme: Theme, error?: string): string {
  return page(
    "Check your email",
    html`<div class="signin">
      <h1>Check your email</h1>
      <p class="lede">If <strong>${email}</strong> has a Reliquary account, we’ve sent it a sign-in link and a code. Open the link on this device, or enter the code here.</p>
      ${error ? html`<p class="callout attention" role="alert">${error}</p>` : ""}
      <form method="post" action="/signin/code" class="panel">
        ${hidden("csrf", csrf)}${hidden("next", next)}${hidden("email", email)}
        <label for="code">Code</label>
        <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required>
        <div class="actions"><button class="primary">Sign in</button></div>
      </form>
      <form method="post" action="/signin" class="actions">
        ${hidden("csrf", csrf)}${hidden("next", next)}${hidden("email", email)}
        <button class="quiet">Send a new code</button>
        <a href="${signinUrl(next)}">Use a different email</a>
      </form>
    </div>`,
    { theme },
  );
}

function confirmForm(csrf: string, tokenHash: string, theme: Theme): string {
  return page(
    "Sign in",
    html`<div class="signin">
      <h1>Finish signing in</h1>
      <p class="lede">You opened a sign-in link from your email. Continue to sign in on this device.</p>
      <form method="post" action="/auth/confirm" class="actions">
        ${hidden("csrf", csrf)}${hidden("token_hash", tokenHash)}
        <button class="primary">Sign in</button>
      </form>
    </div>`,
    { theme },
  );
}

const unavailable = (theme: Theme): Reply => ({
  status: 503,
  html: notice("Sign-in is unavailable", "Reliquary can’t reach its sign-in service right now. Try again in a minute.", theme),
});

export async function signinRoutes(i: In): Promise<Out | undefined> {
  const p = i.url.pathname;
  if (!SIGNIN_PATHS.has(p)) return undefined;
  const cookies: string[] = [];
  const pre = () => {
    const t = preToken(i.req);
    if (t.cookie) cookies.push(t.cookie);
    return t.token;
  };
  const out = (reply: Reply): Out => ({ reply, cookies });

  if (i.method === "GET" && p === "/signin") {
    const next = safeNext(i.url.searchParams.get("next"));
    if (i.session) return out({ redirect: next });
    return out({ html: emailForm(pre(), next, i.theme, undefined, await inviteFor(next)) });
  }

  if (i.method === "GET" && p === "/auth/confirm") {
    const tokenHash = i.url.searchParams.get("token_hash") ?? "";
    if (!TOKEN_HASH.test(tokenHash) || i.url.searchParams.get("type") !== "email") {
      return out({ status: 400, html: notice("Link incomplete", html`This sign-in link is missing a part. Copy the whole link from the email, or <a href="/signin">send a new one</a>.`, i.theme) });
    }
    return out({ html: confirmForm(pre(), tokenHash, i.theme) });
  }

  if (i.method !== "POST") return out({ status: 405, html: "" });

  const next = safeNext(i.form.get("next"));
  if (!preTokenOk(i.req, i.form)) {
    // Also the answer to a cross-site post that got past the Origin rule.
    return out({ status: 403, html: emailForm(pre(), next, i.theme, "That form expired. Enter your email again.") });
  }

  if (p === "/signin") {
    const email = (i.form.get("email") ?? "").trim();
    const invite = await inviteFor(next);
    if (!EMAIL.test(email) || email.length > 254) {
      return out({ status: 400, html: emailForm(pre(), next, i.theme, "Enter your email address, like name@example.com.", invite) });
    }
    const r = await sendSigninEmail(email, invite !== undefined && email.toLowerCase() === invite.email);
    if (r.unavailable) return out(unavailable(i.theme));
    if (r.signupsOff) {
      return out({
        status: 403,
        html: notice(
          "No account yet",
          html`There’s no Reliquary account for <strong>${email}</strong> yet, and this site isn’t making new accounts on its own right now. Ask the person who invited you to have an account made for that address, then open the invite link again.`,
          i.theme,
        ),
      });
    }
    // The emailed link can't carry `next`, so it waits in a cookie for the
    // link to be opened in this browser. A browser drops a cookie over 4 KB,
    // so a longer `next` is only kept by the code form.
    const kept = encodeURIComponent(next);
    cookies.push(next === "/" || kept.length > 3500 ? clearCookie(NEXT) : setCookie(NEXT, kept, 3600));
    return out({ html: codeForm(pre(), email, next, i.theme) });
  }

  if (p === "/signin/code") {
    const email = (i.form.get("email") ?? "").trim();
    const code = (i.form.get("code") ?? "").replace(/[\s-]/g, "");
    if (!EMAIL.test(email)) return out({ status: 400, html: emailForm(pre(), next, i.theme, "Enter your email address, like name@example.com.") });
    const bad = "That code didn’t work. It may have expired or been used already: check the latest email, or send a new code.";
    if (!CODE.test(code)) return out({ status: 400, html: codeForm(pre(), email, next, i.theme, bad) });
    const r = await verifySignin({ email, code });
    if (!r.ok) return out(r.unavailable ? unavailable(i.theme) : { status: 400, html: codeForm(pre(), email, next, i.theme, bad) });
    cookies.push(...r.cookies, clearPreToken(), clearCookie(NEXT));
    return out({ redirect: next });
  }

  // POST /auth/confirm
  const tokenHash = i.form.get("token_hash") ?? "";
  const r = TOKEN_HASH.test(tokenHash) ? await verifySignin({ tokenHash }) : ({ ok: false, unavailable: false } as const);
  if (!r.ok) {
    if (r.unavailable) return out(unavailable(i.theme));
    return out({
      status: 400,
      html: notice("Link expired", html`That sign-in link has expired or was already used. <a href="/signin">Send a new one</a>.`, i.theme),
    });
  }
  let back = "/";
  try {
    back = safeNext(decodeURIComponent(readCookie(i.req, cookieName(NEXT)) ?? ""));
  } catch {
    back = "/";
  }
  cookies.push(...r.cookies, clearPreToken(), clearCookie(NEXT));
  return out({ redirect: back });
}
