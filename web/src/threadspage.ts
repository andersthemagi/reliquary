// A vault's Threads page (docs/public/concepts/threads.md): the conversations
// between its members and their agents, newest activity first. Every member
// reads every thread, side threads included: a side thread is addressed to some
// members, which decides only who is told about it, so the list says so in
// words and never hides one. Threads addressed to the signed-in person come
// first, under their own heading. There is no read or unread tracking for
// people here, on purpose: nothing marks a thread as seen.
//
//   GET  /v/:id/threads              the list; ?path=<file> only its threads, ?before=<n> older ones
//
// Each handler runs as the signed-in person; the tables' row level security
// decides what they read (supabase/migrations/20261004100000_threads.sql).

import type pg from "pg";
import { asPerson } from "./db.js";
import { emptyState, html, pageHeader, plural, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { notFound, render, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { anchorLines, byline, THREAD_COLS, threadPath, threadsPath, type ThreadRow } from "./threadrefs.js";

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

function row(ctx: Ctx, id: string, t: ThreadRow, about?: Raw): Raw {
  const to = t.scope === "side" ? (t.addressed_to_me ? "Addressed to you" : `Addressed to ${plural(t.addressees.length, "person", "people")}`) : "";
  return html`<li${t.resolved_at ? html` class="is-resolved"` : ""}>
    <span class="thread-main"><a class="name" href="${threadPath(id, t.id)}">${t.title}</a>
      <span class="muted small thread-meta">${sideBadge(t)}${to ? html` ${to} · ` : ""}Opened by ${byline(ctx, t.opened_by, t.agent)} · ${time(t.opened_at)}${about ? html` · ${about}` : ""}</span></span>
    <span class="row-end small"><span class="muted">${plural(t.messages, "message")} · last ${time(t.last_message_at)}</span> ${stateBadge(t)}</span>
  </li>`;
}

async function load(c: pg.PoolClient, id: string, path: string | null, before: string | null): Promise<{ rows: ThreadRow[]; more: boolean }> {
  const { rows } = await c.query(
    `select ${THREAD_COLS} from public.thread_summaries s
      where s.vault_id = $1 and ($2::text is null or s.anchor_path = $2) and ($3::bigint is null or s.last_message_id < $3)
      order by s.last_message_id desc nulls last limit ${PAGE + 1}`,
    [id, path, before],
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
      meta: o.path ? html`<p class="meta">Showing threads about <code>${shown(o.path)}</code>. <a href="${threadsPath(id)}">Show every thread</a></p>` : undefined,
    })}
    ${o.rows.length === 0
      ? empty
      : html`${mine.length ? html`<h2>Addressed to you</h2>${list(mine, "Threads addressed to you")}` : ""}
        ${rest.length ? html`${mine.length ? html`<h2>Other threads</h2>` : ""}${list(rest, mine.length ? "Other threads" : "Threads")}` : ""}
        ${o.more ? html`<p class="small"><a href="${threadsPath(id, `?${o.path ? `path=${encodeURIComponent(o.path)}&` : ""}before=${o.rows[o.rows.length - 1].last_message_id}`)}">Older threads</a></p>` : ""}`}`;
}

async function list(ctx: Ctx, id: string): Promise<Reply> {
  const given = ctx.url.searchParams.get("path") ?? "";
  const path = given && given.length <= 1024 ? given : null;
  const b = ctx.url.searchParams.get("before") ?? "";
  const before = /^\d{1,18}$/.test(b) ? b : null;
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const loaded = await load(c, id, path, before);
    const about = await anchorLines(c, id, loaded.rows);
    return vaultShell(c, ctx, v, { section: "threads" }, body(ctx, id, v, { ...loaded, about, path }));
  });
  if (!out) return notFound(ctx);
  return render(ctx, "Threads", out, "vaults");
}

export async function threadsRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  if (ctx.method === "GET" && rest === "/threads") return list(ctx, id);
  return notFound(ctx);
}
