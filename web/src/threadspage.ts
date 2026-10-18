// A vault's Threads page (docs/public/concepts/threads.md): the conversations
// between its members and their agents, newest activity first. Every member
// reads every thread, side threads included: a side thread is addressed to some
// members, which decides only who is told about it, so the list says so in
// words and never hides one. Threads addressed to the signed-in person come
// first, under their own heading. A thread with a message from someone else,
// or from an agent, newer than the last one the person was shown when they
// opened it (public.thread_reads, written by threadview.ts) says Unread, in
// words; what a person has read is theirs alone, and no agent sees it.
//
//   GET  /v/:id/threads              the list; ?path=<file> only its threads, ?before=<n> older ones
//                                    (opening a thread and reading one: threadnew.ts, threadview.ts)
//
// Each handler runs as the signed-in person; the tables' row level security
// decides what they read (supabase/migrations/20261004100000_threads.sql).

import type pg from "pg";
import { asPerson } from "./db.js";
import { emptyState, html, pageHeader, plural, reviewItem, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { canWrite, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { anchorLines, THREAD_COLS, threadPath, threadsPath, type ThreadRow } from "./threadrefs.js";

const PAGE = 100;

export const stateBadge = (t: Pick<ThreadRow, "resolved_at">): Raw =>
  t.resolved_at ? html`<span class="badge success">Resolved</span>` : html`<span class="badge info">Open</span>`;

// A side thread is marked in words, never only by colour or position.
export const sideBadge = (t: Pick<ThreadRow, "scope">): Raw | "" =>
  t.scope === "side"
    ? html`<span class="badge side-thread" title="Addressed to some members. Everyone in this vault can still read it.">Side thread</span>`
    : "";

// A path typed into a URL, said back only when it's plain.
const shown = (path: string) => (/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that file");

// The row proposals use (reviewItem). A file the thread is about is its path
// chip; a task or proposal, which a chip can't name, stays a line of words.
function row(ctx: Ctx, id: string, t: ThreadRow, about?: Raw): Raw {
  const to = t.scope === "side" ? (t.addressed_to_me ? "Addressed to you" : `Addressed to ${plural(t.addressees.length, "person", "people")}`) : "";
  const onFile = t.anchor_kind === "path";
  const words = onFile ? undefined : about;
  return reviewItem({
    href: threadPath(id, t.id),
    title: t.title,
    path: onFile ? t.anchor_path : null,
    who: who(ctx, t.opened_by, t.agent),
    meta: to && words ? html`${to} · ${words}` : (words ?? to),
    end: html`${t.unread ? html`<span class="badge warning">Unread</span> ` : ""}${sideBadge(t)}${t.scope === "side" ? " " : ""}${stateBadge(t)} <span class="muted">${plural(t.messages, "message")}</span>`,
    at: t.last_message_at,
    className: t.resolved_at ? "is-resolved" : undefined,
  });
}

// Unread: a message newer than the person's read mark (none: 0) that isn't
// their own in person. Their agent's words are news to them too.
async function load(c: pg.PoolClient, me: string, id: string, path: string | null, before: string | null): Promise<{ rows: ThreadRow[]; more: boolean }> {
  const { rows } = await c.query(
    `select ${THREAD_COLS},
            exists (select 1 from public.thread_messages m
                     where m.vault_id = s.vault_id and m.thread_id = s.id and (m.author <> $4 or m.agent is not null)
                       and m.id > coalesce((select r.last_message_id from public.thread_reads r
                                             where r.user_id = $4 and r.vault_id = s.vault_id and r.thread_id = s.id), 0)) as unread
       from public.thread_summaries s
      where s.vault_id = $1 and ($2::text is null or s.anchor_path = $2) and ($3::bigint is null or s.last_message_id < $3)
      order by s.last_message_id desc nulls last limit ${PAGE + 1}`,
    [id, path, before, me],
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

function body(ctx: Ctx, id: string, v: Vault, o: { rows: ThreadRow[]; more: boolean; about: Map<string, Raw>; path: string | null }): Raw {
  const mine = o.rows.filter((t) => t.addressed_to_me);
  const rest = o.rows.filter((t) => !t.addressed_to_me);
  const list = (rows: ThreadRow[], label: string) => html`<ul class="rows thread-rows" aria-label="${label}">${rows.map((t) => row(ctx, id, t, o.about.get(t.id)))}</ul>`;
  const empty = o.path
    ? emptyState({ title: "No threads about this file.", body: "Threads that name it as what they are about show up here.", action: html`<a href="${threadsPath(id)}">Show every thread in this vault</a>` })
    : emptyState({ title: "No threads yet.", body: "A thread is a conversation about the work, between the people in this vault and their agents." });
  return html`
    ${pageHeader({
      crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Threads" }],
      title: "Threads",
      description: "Conversations between the people in this vault and their agents. Everyone in the vault can read every thread, side threads included.",
      primary: canWrite(v) ? html`<a class="button primary" href="${threadsPath(id, `/new${o.path ? `?path=${q(o.path)}` : ""}`)}">New thread</a>` : "",
      meta: o.path ? html`<p class="meta">Showing threads about <code>${shown(o.path)}</code>. <a href="${threadsPath(id)}">Show every thread</a></p>` : undefined,
    })}
    ${o.rows.length === 0
      ? empty
      : html`${mine.length ? html`<h2>Addressed to you</h2>${list(mine, "Threads addressed to you")}` : ""}
        ${rest.length ? html`${mine.length ? html`<h2>Other threads</h2>` : ""}${list(rest, mine.length ? "Other threads" : "Threads")}` : ""}
        ${o.more ? html`<p class="small"><a href="${threadsPath(id, `?${o.path ? `path=${encodeURIComponent(o.path)}&` : ""}before=${o.rows[o.rows.length - 1].last_message_id}`)}">Older threads</a></p>` : ""}`}`;
}

export async function threadList(ctx: Ctx, id: string): Promise<Reply> {
  const given = ctx.url.searchParams.get("path") ?? "";
  const path = given && given.length <= 1024 ? given : null;
  const b = ctx.url.searchParams.get("before") ?? "";
  const before = /^\d{1,18}$/.test(b) ? b : null;
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const loaded = await load(c, ctx.userId, id, path, before);
    const about = await anchorLines(c, id, loaded.rows);
    return vaultShell(c, ctx, v, { section: "threads" }, body(ctx, id, v, { ...loaded, about, path }));
  });
  if (!out) return notFound(ctx);
  return render(ctx, "Threads", out, "vaults");
}
