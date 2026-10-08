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
// A link's `type` is `email` (sign-in, sign-up, an Auth invite, and the
// "reset password" email, which signs in: there are no passwords) or
// `email_change` (confirming a new address; with Supabase's secure email
// change both addresses confirm, and the first only says so). The emails
// are web/emails/*.html.
//
// The server has already checked Origin on POSTs. These forms carry the
// double-submit token from auth.ts instead of a session CSRF token.
// Nothing here logs; the server logs method, path and status only.
//
// Invites (members.ts): a signed-out invitee is sent here with
// next=/invite?token=... . The pages then say what they were invited to.
// For an address-bound invite, sign-in may create the account only for
// the address it was sent to (checked with the database); any other
// address signs in as usual, never creating one. For an open link (no
// address, members.ts's "Generate a link"), sign-in may create the
// account for whichever address is entered: the link itself is what's
// scarce, not the address.

import type http from "node:http";
import {
  clearCookie,
  clearPreToken,
  cookieName,
  flashCookie,
  preToken,
  preTokenOk,
  readCookie,
  sendSigninEmail,
  setCookie,
  verifySignin,
  type Session,
} from "./auth.js";
import { html, notice, page, type Theme } from "./html.js";
import { siteHref } from "./hosts.js";
import { emailKey, inviteTokenOf, maskEmail, peekInvite, roleName, type Peek } from "./invites.js";
import { limit, limitStrict, tooManyPage, type Check } from "./ratelimit.js";
import type { Reply } from "./pages.js";
import { errorPage } from "./errorpage.js";
import { failure, noteUpstream, upstreamNote } from "./failure.js";
import { requestAccessHref } from "./site.js";

// The live invite a sign-in is for, if `next` is an invite page. Looking
// one up counts against the address's invite limit (ratelimit.ts), like
// opening the invite page; over it, the page is plain sign-in.
async function inviteFor(next: string, ip: string): Promise<Peek | undefined> {
  const token = inviteTokenOf(next);
  if (!token) return undefined;
  if (await limit([{ name: "invite_ip", kind: "ip", value: ip }])) return undefined;
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
// Set for half an hour by the sign-in of a brand-new account (auth.ts
// newAccount), so the first landing on Home or on a
// vault (where accepting an invite ends) can send a
// person who has not seen the Welcome tour to it, once (welcome.ts).
export const FRESH_SIGNIN = "rlq_fresh";
const freshCookie = () => setCookie(FRESH_SIGNIN, "1", 1800);
export const EMAIL = /^[^\s@<>()",;:\\]{1,64}@[^\s@<>()",;:\\]{1,190}\.[^\s@<>()",;:\\]{1,63}$/;
const CODE = /^[0-9]{6,10}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

type In = {
  req: http.IncomingMessage;
  method: string;
  url: URL;
  form: URLSearchParams;
  theme: Theme;
  session: Session | null;
  ip: string; // the client's address, for rate limits only
};
type Out = { reply: Reply; cookies: string[] };

const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

// A refused form: the reason in the danger tone, announced, and tied to the
// field it is about (aria-describedby on the field, aria-invalid).
const formError = (id: string, error?: string) => (error ? html`<p class="callout danger" role="alert" id="${id}">${error}</p>` : "");
const invalid = (id: string, error?: string) => (error ? html` aria-invalid="true" aria-describedby="${id}"` : "");

function emailForm(csrf: string, next: string, theme: Theme, error?: string, invite?: Peek): string {
  const openInvite = invite !== undefined && invite.email === null;
  return page(
    "Sign in",
    html`<div class="signin">
      ${invite
        ? openInvite
          ? html`<h1>Join ${invite.vaultName}</h1>
              <p class="lede">You’ve been invited to collaborate on <strong>${invite.vaultName}</strong> on Reliquary, as ${invite.role === "owner" ? "an" : "a"} ${roleName(invite.role)}.</p>
              <p>One shared vault of context and credentials for a team and every AI tool they use. Claude, ChatGPT, Cursor and Claude Code read the same approved context. Secrets stay out of the chat.</p>
              <p>Reliquary is pre-alpha: open to feedback and direction as we harden and improve it.</p>
              <p class="hint">Enter your email: we’ll send a sign-in link and a 6-digit code, and the same step makes your account.</p>`
            : html`<h1>Join ${invite.vaultName}</h1>
              <p class="lede">You’ve been invited to <strong>${invite.vaultName}</strong> on Reliquary. Sign in with the address the invite was sent to, <strong>${maskEmail(invite.email as string)}</strong>: we’ll email it a sign-in link and a 6-digit code. New to Reliquary? The same step makes your account.</p>`
        : html`<h1>Sign in to Reliquary</h1>
          <p class="lede">We’ll email you a sign-in link and a 6-digit code.</p>`}
      ${formError("email-error", error)}
      <form method="post" action="/signin" class="panel">
        ${hidden("csrf", csrf)}${hidden("next", next)}
        <label for="email">Email</label>
        <input type="text" id="email" name="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required${invalid("email-error", error)}>
        <div class="actions"><button class="primary">Email me a code</button></div>
      </form>
      ${invite
        ? ""
        : html`<p class="hint">Reliquary is invite-only. Anyone can sign in, but an account creates vaults only after it joins one by invite. Have an invite? Open its link. Otherwise, <a href="${requestAccessHref()}">request access</a>.</p>`}
      <p class="hint"><a href="${siteHref("/docs")}">About Reliquary</a></p>
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
      ${formError("code-error", error)}
      <form method="post" action="/signin/code" class="panel">
        ${hidden("csrf", csrf)}${hidden("next", next)}${hidden("email", email)}
        <label for="code">Code</label>
        <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required${invalid("code-error", error)}>
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

type LinkType = "email" | "email_change";
const linkType = (v: string | null | undefined): LinkType | undefined => (v === "email" || v === "email_change" ? v : undefined);

function confirmForm(csrf: string, tokenHash: string, type: LinkType, theme: Theme): string {
  if (type === "email_change") {
    return page(
      "Confirm the new address",
      html`<div class="signin">
        <h1>Confirm the change of email address</h1>
        <p class="lede">You opened a link to confirm a new email address for your account. Continue to confirm it on this device.</p>
        <form method="post" action="/auth/confirm" class="actions">
          ${hidden("csrf", csrf)}${hidden("token_hash", tokenHash)}${hidden("type", type)}
          <button class="primary">Confirm the change</button>
        </form>
      </div>`,
      { theme },
    );
  }
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

// Sign-in can't go on: the error page, with the reason noted where the call
// failed (auth.ts, or the rate limit below) and a reference.
export function signinUnavailablePage(theme: Theme): string {
  const up = upstreamNote();
  const f = failure({
    status: 503,
    where: up?.where ?? "sign-in (Supabase Auth)",
    why: up?.why ?? "Reliquary couldn’t reach its sign-in service",
  });
  return errorPage(f, { theme, title: "Sign-in is unavailable", lede: "Reliquary can’t reach its sign-in service right now. Try again in a minute." });
}
const unavailable = (theme: Theme): Reply => ({ status: 503, html: signinUnavailablePage(theme) });

// Sign-in's limits (ratelimit.ts) fail closed: with the counter out of
// reach, sign-in is unavailable rather than open to guessing. The same
// answer for every address, with an account or not.
async function signinLimit(checks: Check[], theme: Theme): Promise<Reply | undefined> {
  const wait = await limitStrict(checks);
  if (wait === "unavailable") {
    noteUpstream("rate limit (database)", "The sign-in attempt counter in the database couldn’t be reached, and sign-in stays closed without it");
    return unavailable(theme);
  }
  if (wait) return { status: 429, retryAfter: wait, html: tooManyPage(wait, theme, "That was too many sign-in attempts in a short time") };
  return undefined;
}

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
    return out({ html: emailForm(pre(), next, i.theme, undefined, await inviteFor(next, i.ip)) });
  }

  if (i.method === "GET" && p === "/auth/confirm") {
    const tokenHash = i.url.searchParams.get("token_hash") ?? "";
    const type = linkType(i.url.searchParams.get("type"));
    if (!TOKEN_HASH.test(tokenHash) || !type) {
      const f = failure({ status: 400, where: "sign-in link", why: "The link is missing its token or its type: it was cut short when it was copied" });
      return out({
        status: 400,
        html: errorPage(f, {
          theme: i.theme,
          title: "Link incomplete",
          lede: html`This sign-in link is missing a part. Copy the whole link from the email, or <a href="/signin">send a new one</a>.`,
          back: "/signin",
        }),
      });
    }
    return out({ html: confirmForm(pre(), tokenHash, type, i.theme) });
  }

  if (i.method !== "POST") return out({ status: 405, html: "" });

  const next = safeNext(i.form.get("next"));
  if (!preTokenOk(i.req, i.form)) {
    // Also the answer to a cross-site post that got past the Origin rule.
    return out({ status: 403, html: emailForm(pre(), next, i.theme, "That form expired. Enter your email again.") });
  }

  if (p === "/signin") {
    const email = (i.form.get("email") ?? "").trim();
    const invite = await inviteFor(next, i.ip);
    if (!EMAIL.test(email) || email.length > 254) {
      return out({ status: 400, html: emailForm(pre(), next, i.theme, "Enter your email address, like name@example.com.", invite) });
    }
    const limited = await signinLimit([
      { name: "signin_email_address", kind: "email", value: emailKey(email) },
      { name: "signin_email_ip", kind: "ip", value: i.ip },
    ], i.theme);
    if (limited) return out(limited);
    const r = await sendSigninEmail(email, invite !== undefined && (invite.email === null || emailKey(email) === invite.email));
    if (r.unavailable) return out(unavailable(i.theme));
    if (r.signupsOff) {
      // The reason is logged, so it names no address; the page does.
      const f = failure({ status: 403, where: "sign-in (Supabase Auth)", why: "This site isn’t making new accounts on its own right now, and the address has no account yet" });
      return out({
        status: 403,
        html: errorPage(f, {
          theme: i.theme,
          title: "No account yet",
          lede: html`There’s no Reliquary account for <strong>${email}</strong> yet, and this site isn’t making new accounts on its own right now. Ask the person who invited you to have an account made for that address, then open the invite link again.`,
          back: signinUrl(next),
        }),
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
    // Guessing protection: a few codes per address, then that address's
    // codes are locked until the window ends (its emailed link still works).
    const limited = await signinLimit([
      { name: "signin_code_address", kind: "email", value: emailKey(email) },
      { name: "signin_code_ip", kind: "ip", value: i.ip },
    ], i.theme);
    if (limited) return out(limited);
    const r = await verifySignin({ email, code });
    if (!r.ok) return out(r.unavailable ? unavailable(i.theme) : { status: 400, html: codeForm(pre(), email, next, i.theme, bad) });
    cookies.push(...r.cookies, clearPreToken(), clearCookie(NEXT), ...(r.newAccount ? [freshCookie()] : []));
    return out({ redirect: next });
  }

  // POST /auth/confirm
  const tokenHash = i.form.get("token_hash") ?? "";
  const type = linkType(i.form.get("type") ?? "email") ?? "email";
  const limited = await signinLimit([{ name: "signin_code_ip", kind: "ip", value: i.ip }], i.theme);
  if (limited) return out(limited);
  const r = TOKEN_HASH.test(tokenHash) ? await verifySignin({ tokenHash, type }) : ({ ok: false, unavailable: false } as const);
  if (!r.ok) {
    if (r.unavailable) return out(unavailable(i.theme));
    if ("otherAddress" in r && r.otherAddress) {
      return out({
        html: notice(
          "One address confirmed",
          html`This address is confirmed. Now open the link in the email sent to the other address: the change happens once both are confirmed.`,
          i.theme,
        ),
      });
    }
    const f = failure({ status: 400, where: "sign-in (Supabase Auth)", why: "The sign-in link has expired or was already used" });
    return out({
      status: 400,
      html: errorPage(f, {
        theme: i.theme,
        title: "Link expired",
        lede: html`That sign-in link has expired or was already used. <a href="/signin">Send a new one</a>.`,
        back: "/signin",
      }),
    });
  }
  // A change of address, done: back to Account settings, which shows the
  // address now in use, with a notice saying so.
  if (type === "email_change") {
    cookies.push(...r.cookies, clearPreToken(), clearCookie(NEXT), flashCookie({ text: "Your email address is changed: you sign in with the new one from now on, and people who share a vault with you see it.", tone: "success" }));
    return out({ redirect: "/settings" });
  }
  let back = "/";
  try {
    back = safeNext(decodeURIComponent(readCookie(i.req, cookieName(NEXT)) ?? ""));
  } catch {
    back = "/";
  }
  cookies.push(...r.cookies, clearPreToken(), clearCookie(NEXT), ...(r.newAccount ? [freshCookie()] : []));
  return out({ redirect: back });
}
