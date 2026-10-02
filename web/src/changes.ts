// Changes: what people and their agents did to a vault's content, in plain
// words, newest first and grouped by day. It is the page a person opens to
// see what happened while they were away; the full log (members, rules,
// variables, claims) is the Log tab under Settings, Diagnostics.
//
// It reads the same log as Activity (queryActivity), narrowed to the content
// events (CONTENT_EVENTS, activity.ts), as the signed-in person: the log's
// RLS policy and the membership join decide what they may see, and nothing
// here reads `detail`. Opening it changes nothing: it never touches a flag
// watermark (flags.md), only Flags does.
//
// A run of writes by one actor to one file is one line ("wrote notes/plan.md
// 4 times"), so an agent saving a file in a loop doesn't bury everything
// else. A page holds PAGE_LINES lines, not events, so a run is never cut at
// a page's edge unless it is longer than CAP events.
//
// Three views, chosen with ?show=: everyone's changes, the reader's own (made
// by them or their agents: the log's actor is the person either way), or the
// changes on paths the reader watches (watchrule.ts; public.subscriptions
// under its own RLS, so only their own watches count). Each is the same read
// with one more condition, and none of them touches a flag watermark.

import type pg from "pg";
import { asPerson } from "./db.js";
import { CONTENT_EVENTS, queryActivity, type Row } from "./activity.js";
import { emptyState, html, pageHeader, raw, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { filePath, notFound, proposalPath, render, vault, vaultPath, type Ctx, type Reply } from "./pages.js";
import { personRef } from "./personref.js";

export type Show = "everyone" | "mine" | "watching";
const SHOWS: [Show, string][] = [
  ["everyone", "Everyone"],
  ["mine", "Mine"],
  ["watching", "Watching"],
];
// Anything but the two named views is Everyone, not an error.
const showOf = (v: string | null): Show => (v === "mine" || v === "watching" ? v : "everyone");

export const changesPath = (id: string, show: Show = "everyone", before?: string) => {
  const p = new URLSearchParams();
  if (show !== "everyone") p.set("show", show);
  if (before) p.set("before", before);
  const s = p.toString();
  return vaultPath(id, `/changes${s ? `?${s}` : ""}`);
};

export const PAGE_LINES = 30;
const BATCH = 100;
const CAP = 1000;

// One line of the feed: an event, or a run of repeat writes (n of them).
export type Line = Pick<Row, "actor" | "agent" | "event" | "path" | "proposal_id" | "at"> & {
  seq: string; // the newest event in the line
  last: string; // the oldest: where the next page starts
  n: number;
  day: string; // YYYY-MM-DD, UTC
};

const day = (d: Date) => d.toISOString().slice(0, 10);

// Runs of repeat writes folded into one line each. `rows` are newest first,
// as queryActivity gives them; only neighbours fold, so another person's
// change between two writes keeps them apart, and a run never crosses a day.
// A write that applied a proposal stands alone: it is a decision's result.
export function collapse(rows: Row[]): Line[] {
  const lines: Line[] = [];
  for (const r of rows) {
    const d = day(r.at);
    const prev = lines[lines.length - 1];
    const folds =
      prev !== undefined &&
      r.event === "file.write" &&
      prev.event === "file.write" &&
      !r.proposal_id &&
      !prev.proposal_id &&
      prev.actor === r.actor &&
      prev.agent === r.agent &&
      prev.path === r.path &&
      prev.day === d;
    if (folds) {
      prev.n += 1;
      prev.last = r.seq;
    } else {
      lines.push({ actor: r.actor, agent: r.agent, event: r.event, path: r.path, proposal_id: r.proposal_id, at: r.at, seq: r.seq, last: r.seq, n: 1, day: d });
    }
  }
  return lines;
}

// One page of lines, starting just below `before` (a log seq), and where the
// one after starts. Reads events in batches until it has a line more than
// the page needs (so the last line is whole) or the log runs out.
export async function readPage(c: pg.PoolClient, me: string, vaultId: string, before?: string, show: Show = "everyone"): Promise<{ lines: Line[]; next?: string }> {
  const rows: Row[] = [];
  let cursor = before;
  let lines: Line[] = [];
  let more = false;
  for (;;) {
    const page = await queryActivity(
      c,
      me,
      { vaultId, events: CONTENT_EVENTS, watching: show === "watching" },
      { ...(cursor ? { before: cursor } : {}), ...(show === "mine" ? { who: me } : {}) },
      BATCH,
    );
    rows.push(...page.rows);
    lines = collapse(rows);
    more = page.next !== undefined;
    if (lines.length > PAGE_LINES || !more || rows.length >= CAP) break;
    cursor = page.next;
  }
  if (lines.length > PAGE_LINES) {
    lines = lines.slice(0, PAGE_LINES);
    more = true;
  }
  return { lines, next: more && lines.length ? lines[lines.length - 1].last : undefined };
}

// Day headings: Today, Yesterday, then "Monday 28 September" (and the year
// when it isn't this one). UTC, like the times on every other page.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dayLabel(d: string, now = new Date()): string {
  const today = day(now);
  if (d === today) return "Today";
  if (d === day(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  const x = new Date(`${d}T00:00:00Z`);
  const year = x.getUTCFullYear() === now.getUTCFullYear() ? "" : ` ${x.getUTCFullYear()}`;
  return `${WEEKDAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${year}`;
}

// Who did it: a person, or "<person>'s agent" with the agent's own name (the
// connection's label) beside it. "You" and "Your agent" for the reader.
function actor(me: string, l: Pick<Line, "actor" | "agent">): Raw {
  const mine = l.actor === me;
  if (l.agent) {
    const owner = mine ? "Your" : l.actor ? `${personRef(l.actor)}’s` : "An";
    return html`${owner} agent <span class="change-agent">${l.agent}</span>`;
  }
  return html`${mine ? "You" : l.actor ? personRef(l.actor) : "Someone"}`;
}

// What happened, in plain words, linked to the file or the proposal. A file
// that is gone isn't linked: its page would be a 404.
function what(id: string, l: Line, live: ReadonlySet<string>): Raw {
  const path = l.path ?? "a file";
  const file = l.path && live.has(l.path) ? html`<a href="${filePath(id, l.path)}">${path}</a>` : html`${path}`;
  const proposal = (pre: string) =>
    l.proposal_id ? html`<a href="${proposalPath(id, l.proposal_id)}">${pre} on ${path}</a>` : html`${pre} on ${path}`;
  switch (l.event) {
    case "file.write":
      return html`wrote ${file}${l.n > 1 ? ` ${l.n} times` : ""}${
        l.proposal_id ? html`, from <a href="${proposalPath(id, l.proposal_id)}">an approved proposal</a>` : ""
      }`;
    case "file.delete":
      return html`deleted ${path}`;
    case "file.erase":
      return html`erased the content of ${path}`;
    case "proposal.open":
      return html`opened ${proposal("a proposal")}`;
    case "proposal.approve":
      return html`approved ${proposal("the proposal")}`;
    case "proposal.request_changes":
      return html`asked for changes to ${proposal("the proposal")}`;
    case "proposal.reject":
      return html`rejected ${proposal("the proposal")}`;
    case "proposal.revise":
      return html`revised ${proposal("the proposal")}`;
    case "proposal.edit":
      return html`edited ${proposal("the proposal")}`;
    case "proposal.comment":
      return html`commented on ${proposal("the proposal")}`;
  }
  // A content event nobody wrote words for yet: say so rather than show a code.
  return html`changed ${path}`;
}

function feed(ctx: Ctx, id: string, lines: Line[], live: ReadonlySet<string>): Raw {
  const days: { day: string; lines: Line[] }[] = [];
  for (const l of lines) {
    if (days[days.length - 1]?.day === l.day) days[days.length - 1].lines.push(l);
    else days.push({ day: l.day, lines: [l] });
  }
  return html`${days.map(
    (g) => html`<section class="feed-day" aria-labelledby="d-${g.day}"><h2 id="d-${g.day}">${dayLabel(g.day)}</h2>
      <ul class="rows feed">${g.lines.map(
        (l) => html`<li class="change"><span class="change-what">${actor(ctx.userId, l)} ${what(id, l, live)}</span><span class="change-when">${time(l.at)}</span></li>`,
      )}</ul></section>`,
  )}`;
}

// Everyone, Mine, Watching: links to this page with one view chosen (no
// script), the current one marked.
function chips(id: string, show: Show): Raw {
  return html`<ul class="chips" aria-label="Show changes by">${SHOWS.map(
    ([k, label]) => html`<li><a class="chip" href="${changesPath(id, k)}"${k === show ? raw(' aria-current="true"') : ""}>${label}</a></li>`,
  )}</ul>`;
}

// What an empty first page says, by view: nothing yet, nothing of yours, or
// nothing on what you watch (or nothing watched at all, which is a different
// next step).
async function emptyFirst(c: pg.PoolClient, ctx: Ctx, id: string, show: Show): Promise<Raw> {
  if (show === "mine") {
    return emptyState({
      title: "You haven’t changed anything here yet",
      body: "Files you write or delete, and proposals you open or decide, show here, with what your agents do for you.",
    });
  }
  if (show === "watching") {
    const n = (await c.query(`select count(*)::int as n from public.subscriptions where vault_id = $1 and user_id = $2 and kind = 'path'`, [id, ctx.userId])).rows[0].n as number;
    return n
      ? emptyState({ title: "Nothing has changed on what you watch", body: "Changes to the folders and files you watch show here as they happen." })
      : emptyState({
          title: "You don’t watch anything here",
          body: "Watch a folder or file from its page, and changes there show here.",
          action: html`<a class="button" href="${vaultPath(id, "/config/watching")}">Watch a path</a>`,
        });
  }
  return emptyState({
    title: "Nothing has changed yet",
    body: "Files written or deleted, and proposals and what people decide about them, show here as they happen.",
  });
}

export async function changes(ctx: Ctx, id: string): Promise<Reply> {
  const before = /^\d{1,18}$/.test(ctx.url.searchParams.get("before") ?? "") ? ctx.url.searchParams.get("before")! : undefined;
  const show = showOf(ctx.url.searchParams.get("show"));
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const { lines, next } = await readPage(c, ctx.userId, id, before, show);
    const paths = [...new Set(lines.filter((l) => l.event === "file.write" && l.path).map((l) => l.path!))];
    const live = new Set<string>(
      paths.length
        ? (
            await c.query(`select path from public.files where vault_id = $1 and deleted_at is null and path = any($2::text[])`, [id, paths])
          ).rows.map((r) => r.path as string)
        : [],
    );
    const body = html`
      ${pageHeader({ title: "Changes", description: "What people and their agents changed in this vault, newest first." })}
      ${chips(id, show)}
      ${show === "watching" && lines.length
        ? html`<p class="hint">Changes on the folders and files you watch. <a href="${vaultPath(id, "/config/watching")}">What you watch</a></p>`
        : ""}
      ${lines.length
        ? feed(ctx, id, lines, live)
        : before
          ? emptyState({
              title: "No older changes",
              body: "This is where the list begins.",
              action: html`<a class="button" href="${changesPath(id, show)}">Back to the newest</a>`,
            })
          : await emptyFirst(c, ctx, id, show)}
      ${next || (before && lines.length)
        ? html`<nav class="pager" aria-label="Pages">${before ? html`<a href="${changesPath(id, show)}">Newest</a>` : ""}${
            next ? html`<a class="older" href="${changesPath(id, show, next)}">Older</a>` : ""
          }</nav>`
        : ""}
      <p class="hint">Members, rules, variables, claims and the rest of what the vault records are in the <a href="${vaultPath(id, "/activity")}">Log</a>, under Settings, Diagnostics.</p>`;
    return vaultShell(c, ctx, v, { section: "changes" }, body);
  });
  if (!out) return notFound(ctx);
  return render(ctx, "Changes", out, "vaults");
}
