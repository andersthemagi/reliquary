// Emails about threads (20261019140000_thread_emails.sql, issue #260): the
// members a thread reaches are told by email that it needs reading, so a
// person with no agent connected still hears. Sent like signup notices
// (signups.ts): the web app claims batches the database cut (one per
// member and thread, once the thread has been quiet), emails each, and
// marks it sent, on the same tick: a signed-in page load, and every minute
// where the server is long-running (server.ts).
//
// The email carries the vault's and the thread's names, who wrote, how
// many messages and a link to the thread: never a message's text, which
// the person reads on the page.

import { pool } from "./db.js";
import { fail } from "./failure.js";
import { esc } from "./html.js";
import { idempotencyKey, mailerOffReason, sendEmail } from "./mailer.js";

type Batch = {
  user_id: string;
  email: string;
  vault_id: string;
  vault: string;
  thread_id: string;
  title: string;
  opened: boolean;
  messages: number;
  writers: string | null;
  through: string;
};

// The site's own origin for the link: PUBLIC_URL when hosted, else the one
// the tick came from (dev and tests).
function siteOrigin(fallback: string): string {
  try {
    return process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : fallback;
  } catch {
    return fallback;
  }
}

export function threadEmail(b: Batch, origin: string): { subject: string; html: string } {
  const title = b.title.replace(/[\r\n]+/g, " ");
  const n = b.messages;
  const what = b.opened ? (n === 1 ? "opened a thread" : `opened a thread, with ${n} messages so far`) : n === 1 ? "posted in a thread" : `posted ${n} messages in a thread`;
  const subject = b.opened ? `New thread in ${b.vault}: ${title}` : `${n} new ${n === 1 ? "message" : "messages"} in ${b.vault}: ${title}`;
  const link = `${origin}/v/${b.vault_id}/threads/${b.thread_id}`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p>${esc(b.writers || "Someone")} ${what} in <strong>${esc(b.vault)}</strong> on Reliquary:</p>
<blockquote style="margin:0 0 1em;padding:0 0 0 12px;border-left:3px solid #ccc">“${esc(title)}”</blockquote>
<p><a href="${esc(link)}">Read the thread</a></p>
<p style="color:#555">You get this because the thread is for you, or for the whole vault. Turn these emails off under <strong>Email me about threads</strong> in Account settings.</p>
</body></html>`;
  return { subject, html };
}

let running: Promise<number> | undefined;

// Never throws: a failure is logged with its ref and the batch is tried
// again once its claim lapses. Returns how many were sent.
export function flushThreadEmails(origin: string): Promise<number> {
  running ??= flush(siteOrigin(origin)).finally(() => (running = undefined));
  return running;
}

async function flush(origin: string): Promise<number> {
  if (mailerOffReason()) return 0;
  let sent = 0;
  try {
    const { rows } = await pool.query(
      "select user_id, email, vault_id, vault, thread_id, title, opened, messages, writers, through from private.claim_thread_emails(10)",
    );
    for (const b of rows as Batch[]) {
      const { subject, html } = threadEmail(b, origin);
      const r = await sendEmail({
        to: b.email,
        subject,
        html,
        idempotencyKey: idempotencyKey("thread", `${b.user_id}:${b.thread_id}:${b.through}`),
        tag: "thread",
        what: "Emailing a member about a thread",
      });
      if (r.sent) {
        await pool.query("select private.thread_emails_sent($1, $2, $3)", [b.user_id, b.thread_id, b.through]);
        sent++;
      }
    }
  } catch (err) {
    fail(err, { what: "Emailing a member about a thread", where: "web app (thread emails)", status: 500 });
  }
  return sent;
}
