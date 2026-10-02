// One thread: the thing it is about, its messages in order, and what the
// signed-in person may do there. Owners and editors post, resolve and reopen;
// viewers read. The database decides who may (post_message, resolve_thread,
// reopen_thread), so a form sent by someone who may not is refused there and
// the refusal comes back with its reference.
//
//   GET  /v/:id/threads/:tid              the thread; ?after=<message id> for later messages
//   POST /v/:id/threads/:tid/post         body
//   POST /v/:id/threads/:tid/resolve      and /reopen
//
// A message is people's and agents' words. It is only ever shown through
// html``, as escaped text, and a citation in it becomes a link only to
// something in this vault (threadcite.ts). Nothing in it can act.

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, csrfField, html, pageHeader, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { canWrite, message, notFound, render, UUID, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { personRef } from "./personref.js";
import { citedText, resolveCites } from "./threadcite.js";
import { anchorLines, byline, THREAD_COLS, threadPath, threadsPath, type ThreadRow } from "./threadrefs.js";
import { sideBadge, stateBadge } from "./threadspage.js";

const PAGE = 200;

type Message = { id: string; author: string; agent: string | null; at: Date; body: string | null; redacted_at: Date | null; redacted_by: string | null };

// The thread, only when it is in the vault the address names: a thread id
// from another vault is Not found here even to someone who is in both.
async function threadIn(c: pg.PoolClient, id: string, tid: string): Promise<ThreadRow | undefined> {
  if (!UUID.test(tid)) return undefined;
  const { rows } = await c.query(`select ${THREAD_COLS} from public.thread_summaries s where s.vault_id = $1 and s.id = $2`, [id, tid]);
  return rows[0];
}

async function messagesOf(c: pg.PoolClient, id: string, tid: string, after: string | null): Promise<{ rows: Message[]; more: boolean }> {
  const { rows } = await c.query(
    `select m.id, m.author, m.agent, m.at, m.body, m.redacted_at, m.redacted_by from public.thread_messages m
      where m.vault_id = $1 and m.thread_id = $2 and m.id > coalesce($3::bigint, 0) order by m.id limit ${PAGE + 1}`,
    [id, tid, after],
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

function messageItem(ctx: Ctx, m: Message, links: Map<string, string>): Raw {
  return html`<li id="message-${m.id}"${m.agent ? html` class="by-agent"` : ""}>
    <p class="small muted">${who(ctx, m.author, m.agent)} · ${time(m.at)}</p>
    ${m.body !== null
      ? html`<p>${citedText(m.body, links)}</p>`
      : html`<p class="muted small redacted">Redacted by ${who(ctx, m.redacted_by, null)} ${time(m.redacted_at)}. The text was removed for everyone, agents included.</p>`}
  </li>`;
}

const sideNote = (ctx: Ctx, t: ThreadRow): Raw | "" =>
  t.scope === "side"
    ? callout(
        "info",
        html`<p><strong>Side thread.</strong> It is addressed to ${t.addressees.map((u) => (u === ctx.userId ? "you" : personRef(u))).join(", ")}. Only the addressed members are told about new messages. Everyone in this vault can still read it, and so can their agents.</p>`,
      )
    : "";

function replyForm(ctx: Ctx, id: string, t: ThreadRow, v: Vault, text: string): Raw {
  if (!canWrite(v)) return html`<p class="muted small">Viewers can read threads but not post in them.</p>`;
  if (t.resolved_at) return html`<p class="muted small">This thread is resolved. Reopen it to post again.</p>`;
  return html`<form method="post" action="${threadPath(id, t.id, "/post")}" class="panel comment" id="reply-form">
    ${csrfField(ctx.csrf)}
    <label for="reply-body">Message</label>
    <textarea id="reply-body" name="body" class="short" maxlength="4000" required>${text}</textarea>
    <p class="hint">Everyone in this vault can read it, and so can their agents, as quoted text. An agent sees a new message on its next tool call, not instantly. A message doesn’t approve or change anything. Secrets belong in <a href="${vaultPath(id, "/variables")}">variables</a>, never in a thread.</p>
    <div class="actions"><button class="primary">Post message</button></div>
  </form>`;
}

const toggle = (ctx: Ctx, id: string, t: ThreadRow): Raw =>
  html`<form method="post" action="${threadPath(id, t.id, t.resolved_at ? "/reopen" : "/resolve")}" class="inline-form">${csrfField(ctx.csrf)}<button>${t.resolved_at ? "Reopen thread" : "Resolve thread"}</button></form>`;

type Refused = { error: string; body: string };

export async function threadView(ctx: Ctx, id: string, tid: string, refused?: Refused): Promise<Reply> {
  const a = ctx.url.searchParams.get("after") ?? "";
  const after = /^\d{1,18}$/.test(a) ? a : null;
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    const t = v ? await threadIn(c, id, tid) : undefined;
    if (!v || !t) return null;
    const { rows, more } = await messagesOf(c, id, tid, after);
    const links = await resolveCites(c, id, rows.flatMap((m) => (m.body === null ? [] : [m.body])));
    const about = (await anchorLines(c, id, [t])).get(t.id);
    const writer = canWrite(v);
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Threads", href: threadsPath(id) }, { label: t.title }],
        title: t.title,
        path: true,
        badge: html`${stateBadge(t)} ${sideBadge(t)}`,
        meta: html`<p class="meta"><span>Opened by ${byline(ctx, t.opened_by, t.agent)} ${time(t.opened_at)}</span>${
          about ? html`<span>${about}</span>` : ""}${
          t.resolved_at ? html`<span>Resolved by ${byline(ctx, t.resolved_by, t.resolved_agent)} ${time(t.resolved_at)}</span>` : ""}</p>`,
        secondary: writer ? toggle(ctx, id, t) : "",
        primary: writer && !t.resolved_at && !more ? html`<a class="button primary" href="#reply">Reply</a>` : "",
      })}
      ${refused ? callout("danger", html`${refused.error}${writer && !t.resolved_at && !more ? html` <a href="#reply">Back to your message</a>` : ""}`) : ""}
      ${sideNote(ctx, t)}
      <section class="discussion" aria-labelledby="messages">
        <h2 id="messages">Messages</h2>
        ${after ? html`<p class="small"><a href="${threadPath(id, tid)}">From the first message</a></p>` : ""}
        <ol class="notes thread">${rows.map((m) => messageItem(ctx, m, links))}</ol>
        ${more
          ? html`<p class="small"><a href="${threadPath(id, tid, `?after=${rows[rows.length - 1].id}`)}">Later messages</a></p>`
          : html`<h2 id="reply">Reply</h2>${replyForm(ctx, id, t, v, refused?.body ?? "")}`}
      </section>`;
    return { shell: await vaultShell(c, ctx, v, { section: "threads" }, body), title: t.title };
  });
  if (!out) return notFound(ctx);
  const reply = render(ctx, out.title, out.shell, "vaults");
  return refused ? { ...reply, status: 400 } : reply;
}

// ---------------------------------------------------------------------------
// Post, resolve and reopen. Each looks the thread up in the vault the address
// names first, so a thread of another vault is Not found whoever asks.

export async function threadPost(ctx: Ctx, id: string, tid: string): Promise<Reply> {
  const text = (ctx.form.get("body") ?? "").replaceAll("\r\n", "\n");
  try {
    const posted = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id)) || !(await threadIn(c, id, tid))) return null;
      return (await c.query(`select public.post_message($1, $2) as id`, [tid, text])).rows[0].id as string;
    });
    if (posted === null) return notFound(ctx);
    ctx.setFlash("Message posted.", "success");
    return { redirect: `${threadPath(id, tid)}#message-${posted}` };
  } catch (err) {
    return threadView(ctx, id, tid, { error: message(err), body: text });
  }
}

export async function threadState(ctx: Ctx, id: string, tid: string, to: "resolve" | "reopen"): Promise<Reply> {
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id)) || !(await threadIn(c, id, tid))) return false;
      await c.query(`select public.${to}_thread($1)`, [tid]);
      return true;
    });
    if (!done) return notFound(ctx);
    ctx.setFlash(to === "resolve" ? "Thread resolved. It takes no new messages until it is reopened." : "Thread reopened.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: threadPath(id, tid) };
}
