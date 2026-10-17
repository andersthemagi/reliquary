// Signup notices: the operator is emailed once when an account confirms its
// address, with where it stands and the command to let it in. Sent like
// feedback notices (feedback.ts: the same address, the same claim and
// retry, 20261012120000_signup_notices.sql), on the same tick: a signed-in
// page load, so the new account's own first page sends it, and every minute
// where the server is long-running (server.ts).

import { pool } from "./db.js";
import { fail } from "./failure.js";
import { esc } from "./html.js";
import { noticeTarget } from "./feedback.js";
import { idempotencyKey, mailerOffReason, sendEmail } from "./mailer.js";

type Signup = {
  user_id: string;
  email: string;
  confirmed_at: Date;
  via: string | null;
  place: string | null;
  waiting: string;
  open_per_day: number | null;
  invite_only: boolean;
};

const VIA: Record<string, string> = {
  invite: "accepted an invite",
  plan: "put on a plan",
  operator: "admitted by the operator",
  existing: "already had a vault",
  open: "let in from the line",
};

// Mirrors private.is_admitted and private.require_admission.
function standing(s: Signup): string {
  if (s.via) return `Let in (${VIA[s.via] ?? s.via}).`;
  if (s.invite_only) return "Waiting: Reliquary is invite-only, so it can't create vaults until it's admitted or accepts an invite.";
  if (s.open_per_day === null) return "Let in: sign-up is open with no line, so it can create vaults now.";
  return `Number ${s.place} in line of ${s.waiting} waiting; the line lets in ${s.open_per_day} a day.`;
}

function signupEmail(s: Signup): { subject: string; html: string } {
  const subject = `Reliquary: new account, ${s.email}`.replace(/[\r\n]+/g, " ");
  const row = (k: string, v: string) => `<tr><th style="text-align:left;padding:2px 12px 2px 0;vertical-align:top">${esc(k)}</th><td style="padding:2px 0">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p>Someone joined Reliquary.</p>
<table style="border-collapse:collapse">${row("Address", s.email)}${row("Confirmed", s.confirmed_at.toISOString().replace("T", " ").slice(0, 16) + " UTC")}${row("Status", standing(s))}</table>
${s.via ? "" : `<p style="color:#555">Let it in now with <code>scripts/plan.sh admit ${esc(s.email)}</code>.</p>\n`}</body></html>`;
  return { subject, html };
}

let running: Promise<number> | undefined;

// Never throws: a failure is logged with its ref and the notice is tried
// again once its claim lapses. Returns how many were sent.
export function flushSignupNotices(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  running ??= flush(env).finally(() => (running = undefined));
  return running;
}

async function flush(env: NodeJS.ProcessEnv): Promise<number> {
  const target = noticeTarget(env);
  if ("off" in target || mailerOffReason()) return 0;
  let sent = 0;
  try {
    const { rows } = await pool.query(
      "select user_id, email, confirmed_at, via, place, waiting, open_per_day, invite_only from private.claim_signup_notices(5)",
    );
    for (const s of rows as Signup[]) {
      const { subject, html } = signupEmail(s);
      const r = await sendEmail({
        to: target.to,
        subject,
        html,
        idempotencyKey: idempotencyKey("signup", s.user_id),
        tag: "signup",
        what: "Emailing the operator about a new account",
      });
      if (r.sent) {
        await pool.query("select private.signup_notified($1)", [s.user_id]);
        sent++;
      }
    }
  } catch (err) {
    fail(err, { what: "Emailing the operator about a new account", where: "web app (signup notices)", status: 500 });
  }
  return sent;
}
