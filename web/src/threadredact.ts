// Redacting a thread message, in person. Messages are append-only, and a
// person can still paste something into one that must not stay: a password,
// a key. An owner of the vault blanks the text from here, behind a confirm
// page (a GET changes nothing). The database decides (redact_message is
// require_human and owners only), so an editor's forced post is refused there
// and shown with its reference; this only decides who is offered the link.
//
//   GET  /v/:id/threads/:tid?redact=<message id>    the confirm page
//   POST /v/:id/threads/:tid/redact                 message, confirm=1
//
// What the redaction does and doesn't undo is said on the confirm page:
// the text goes for everyone, agents included, and what anyone already read
// is not taken back.

import type pg from "pg";
import { asPerson } from "./db.js";
import { confirmPage, html, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { message, notFound, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";
import { threadPath, threadsPath } from "./threadrefs.js";
import { threadIn } from "./threadview.js";

type Found = { id: string; author: string; agent: string | null; at: Date; body: string | null };

// The message, only when it is in this thread: a message of another thread
// or vault is "not in this thread", the answer for one that doesn't exist.
async function messageIn(c: pg.PoolClient, id: string, tid: string, mid: string): Promise<Found | undefined> {
  if (!/^\d{1,18}$/.test(mid)) return undefined;
  const { rows } = await c.query(`select id, author, agent, at, body from public.thread_messages where vault_id = $1 and thread_id = $2 and id = $3`, [id, tid, mid]);
  return rows[0];
}

type Out = { shell: Raw } | { back: string; note: string };

const snippet = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

export async function redactConfirm(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c): Promise<Out | null> => {
    const v = await vault(c, ctx, id);
    const t = v ? await threadIn(c, id, tid) : undefined;
    if (!v || !t) return null;
    const back = threadPath(id, tid);
    if (v.role !== "owner") return { back, note: "Only owners redact messages." };
    const m = await messageIn(c, id, tid, ctx.url.searchParams.get("redact") ?? "");
    if (!m) return { back, note: "That message isn’t in this thread." };
    if (m.body === null) return { back, note: "That message is already redacted." };
    const body = confirmPage({
      title: "Redact this message?",
      crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Threads", href: threadsPath(id) }, { label: t.title, href: back }, { label: "Redact" }],
      lede: html`This blanks the message from ${who(ctx, m.author, m.agent)}: <q>${snippet(m.body)}</q>`,
      consequences: [
        "Its text is removed for everyone in this vault, agents included, and it can’t be restored.",
        "The message keeps its place in the thread, who wrote it and when, and says that you redacted it, and when.",
        "Activity records that you redacted a message, never its text.",
        "It doesn’t take back what anyone, or any agent, has already read or copied. If it held a secret, change the secret too: secrets belong in variables, never in a thread.",
      ],
      action: threadPath(id, tid, "/redact"),
      csrf: ctx.csrf,
      fields: { message: m.id, confirm: "1" },
      button: "Redact message",
      cancel: `${back}#message-${m.id}`,
    });
    return { shell: await vaultShell(c, ctx, v, { section: "threads" }, body) };
  });
  if (!out) return notFound(ctx);
  if ("note" in out) {
    ctx.setFlash(out.note, "warning");
    return { redirect: out.back };
  }
  return render(ctx, "Redact a message", out.shell, "vaults");
}

export async function redactAction(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  const mid = ctx.form.get("message") ?? "";
  // Only the confirm page's form carries this: anything else is sent there.
  if (ctx.form.get("confirm") !== "1") return { redirect: `${threadPath(id, tid)}?redact=${encodeURIComponent(mid)}` };
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id)) || !(await threadIn(c, id, tid))) return null;
      const m = await messageIn(c, id, tid, mid);
      if (!m) return false;
      await c.query(`select public.redact_message($1)`, [m.id]);
      return true;
    });
    if (done === null) return notFound(ctx);
    if (done) ctx.setFlash("Message redacted. Its text is gone for everyone.", "success");
    else ctx.setFlash("That message isn’t in this thread.", "warning");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: threadPath(id, tid) };
}
