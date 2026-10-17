// Request access (#312): the landing page's button, for a visitor with no
// account. Reliquary isn't open to anyone who signs up, so a visitor asks
// here and the operator lets them in by hand, by inviting them to a vault
// (invite-only makes no account for an address nothing invited).
//
//   GET  /request-access   the form: email, name, where they're based, a note
//   POST /request-access   emails the operator (feedback.ts's noticeTarget),
//                          with Reply-To set to the visitor
//
// Signed out, so the form carries sign-in's double-submit token and its
// trap field (signin.ts), and the server has already checked Origin. Sent
// at once rather than queued: nothing is stored, and a failure keeps what
// was typed on the page, with the ref and the address to write to instead.

import type http from "node:http";
import { preToken, preTokenOk } from "./auth.js";
import { noticeTarget } from "./feedback.js";
import { failure, type Failure } from "./failure.js";
import { esc, html, page, textareaText, type Theme } from "./html.js";
import { idempotencyKey, sendEmail } from "./mailer.js";
import type { Reply } from "./pages.js";
import { limit, tooManyPage } from "./ratelimit.js";
import { EMAIL, formError, hidden, invalid, TRAP } from "./signin.js";
import { contactEmail } from "./site.js";

export const REQUEST_ACCESS = "/request-access";
const NAME_MAX = 100;
const NOTE_MAX = 2000;

type Draft = { email: string; name: string; place: string; note: string };

function form(csrf: string, theme: Theme, d: Draft, error?: { field: "email" | "place" | "note" | "send"; text: string }): string {
  const on = (f: string) => (error?.field === f ? error.text : undefined);
  return page(
    "Request access",
    html`<div class="signin">
      <h1>Request access to Reliquary</h1>
      <p class="lede">Reliquary is in a closed alpha. Tell us about your team and the AI tools you use, and we’ll email you back to set up your first vault with you.</p>
      ${formError("request-error", error?.text)}
      <form method="post" action="${REQUEST_ACCESS}" class="panel">
        ${hidden("csrf", csrf)}
        <div class="trap" aria-hidden="true"><label for="${TRAP}">Leave this empty</label><input type="text" id="${TRAP}" name="${TRAP}" tabindex="-1" autocomplete="off"></div>
        <label for="email">Email</label>
        <input type="text" id="email" name="email" value="${d.email}" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required${invalid("request-error", on("email"))}>
        <label for="name">Name <span class="hint">(optional)</span></label>
        <input type="text" id="name" name="name" value="${d.name}" autocomplete="name" maxlength="${NAME_MAX}">
        <label for="place">Where you’re based <span class="hint">(country)</span></label>
        <input type="text" id="place" name="place" value="${d.place}" autocomplete="country-name" maxlength="${NAME_MAX}" required${invalid("request-error", on("place"))}>
        <label for="note">Your team, and the AI tools you use</label>
        <textarea id="note" name="note" class="short" maxlength="${NOTE_MAX}" required${invalid("request-error", on("note"))}>${textareaText(d.note)}</textarea>
        <div class="actions"><button class="primary">Send request</button></div>
      </form>
      <p class="hint">Already have an account, or an invite? <a href="/signin">Sign in</a>.</p>
    </div>`,
    { theme },
  );
}

const sent = (theme: Theme, email: string) =>
  page(
    "Request sent",
    html`<div class="signin">
      <h1>Request sent</h1>
      <p class="lede">Thanks. We read every request and will reply to <strong>${email}</strong>.</p>
      <p class="hint">Already have an account? <a href="/signin">Sign in</a>.</p>
    </div>`,
    { theme },
  );

function accessEmail(d: Draft): { subject: string; html: string } {
  const subject = `Reliquary: access request, ${d.email}`.replace(/[\r\n]+/g, " ");
  const row = (k: string, v: string) => `<tr><th style="text-align:left;padding:2px 12px 2px 0;vertical-align:top">${esc(k)}</th><td style="padding:2px 0;white-space:pre-wrap">${esc(v)}</td></tr>`;
  return {
    subject,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p>Someone asked for access to Reliquary. Reply to this email to answer them.</p>
<table style="border-collapse:collapse">${row("Address", d.email)}${d.name ? row("Name", d.name) : ""}${row("Based in", d.place)}${row("About", d.note)}</table>
<p style="color:#555">To let them in, invite ${esc(d.email)} to a vault (one you make for them, as its owner): accepting the invite makes their account and admits it. While invite-only is on, signing in alone makes no account.</p>
</body></html>`,
  };
}

export async function requestAccess(req: http.IncomingMessage, method: string, posted: URLSearchParams, theme: Theme, ip: string): Promise<{ reply: Reply; cookies: string[] }> {
  const cookies: string[] = [];
  const pre = () => {
    const t = preToken(req);
    if (t.cookie) cookies.push(t.cookie);
    return t.token;
  };
  const out = (reply: Reply) => ({ reply, cookies });
  const blank = { email: "", name: "", place: "", note: "" };
  if (method === "GET" || method === "HEAD") return out({ html: form(pre(), theme, blank) });
  if (method !== "POST") return out({ status: 405, html: "" });

  const d: Draft = {
    email: (posted.get("email") ?? "").trim(),
    name: (posted.get("name") ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, NAME_MAX),
    place: (posted.get("place") ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, NAME_MAX),
    note: (posted.get("note") ?? "").trim().slice(0, NOTE_MAX),
  };
  if (!preTokenOk(req, posted)) {
    const f = failure({ status: 403, where: "request access form check", why: "That form expired: its security cookie was missing or didn’t match, which happens when this browser blocks cookies or the page was opened in another session. What you typed is below: send it again" });
    return out({ status: 403, html: form(pre(), theme, d, { field: "send", text: `${f.why} (ref ${f.ref})` }) });
  }
  if (!EMAIL.test(d.email) || d.email.length > 254) {
    return out({ status: 400, html: form(pre(), theme, d, { field: "email", text: "Enter your email address, like name@example.com, so we can reply." }) });
  }
  if (!d.place) {
    return out({ status: 400, html: form(pre(), theme, d, { field: "place", text: "Say which country you’re based in: the alpha is starting with people outside the EU." }) });
  }
  if (!d.note) {
    return out({ status: 400, html: form(pre(), theme, d, { field: "note", text: "Say a little about your team and the AI tools you use, so we know how to set you up." }) });
  }
  // A bot learns nothing: the same page as a real request, and nothing sent.
  if (posted.get(TRAP)) {
    console.error("request access trap field filled: nothing sent");
    return out({ html: sent(theme, d.email) });
  }
  const wait = await limit([{ name: "request_access_ip", kind: "ip", value: ip }]);
  if (wait) return out({ status: 429, retryAfter: wait, html: tooManyPage(wait, theme, "That was too many access requests from this network in a short time") });

  const target = noticeTarget();
  const notSent = (f: Failure) =>
    out({ status: f.status, html: form(pre(), theme, d, { field: "send", text: `Your request wasn’t sent: ${f.why.replace(/\.$/, "")} (ref ${f.ref}). Email ${"to" in target ? target.to : contactEmail()} instead, with what you typed below.` }) });
  if ("off" in target) return notSent(failure({ status: 503, where: "request access (operator address)", why: `This server has nowhere to send requests: ${target.off}` }));
  const { subject, html: body } = accessEmail(d);
  const r = await sendEmail({
    to: target.to,
    replyTo: d.email,
    subject,
    html: body,
    idempotencyKey: idempotencyKey("access-request", `${d.email}\n${d.note}`),
    tag: "access_request",
    what: "Sending an access request",
  });
  if (!r.sent) return notSent(r.failure ?? failure({ status: 503, where: "request access (email sender)", why: `Email is off on this server: ${r.off}` }));
  return out({ html: sent(theme, d.email) });
}
