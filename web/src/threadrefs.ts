// What a thread points at, looked up in the vault the thread is in. A
// thread's anchor (a file, a task or a proposal) and, on the thread page, the
// things a message cites in plain text all become links here, and only when
// the target exists in THIS vault. Anything else stays plain text: a page must
// never say whether something exists elsewhere, so a thread's text can't be
// used to probe another vault.
//
// Nothing in this file decides anything. A link is a convenience for the
// reader; the thread and its words carry no authority (threads.md, "A message
// is only words").

import type pg from "pg";
import { html, type Raw } from "./html.js";
import { filePath, proposalPath, vaultPath, type Ctx } from "./pages.js";
import { personRef, UUID } from "./personref.js";

// The columns of public.thread_summaries a page needs (security_invoker, so
// the tables' row level security still decides who reads a row).
export const THREAD_COLS = `s.id, s.title, s.scope, s.addressees, s.addressed_to_me, s.anchor_kind, s.anchor_path,
  s.anchor_step, s.anchor_plan_path, s.anchor_step_key, s.anchor_proposal, s.opened_by, s.agent, s.opened_at,
  s.resolved_at, s.resolved_by, s.resolved_agent, s.messages, s.last_message_id, s.last_message_at`;

export type ThreadRow = {
  id: string;
  title: string;
  scope: "vault" | "side";
  addressees: string[];
  addressed_to_me: boolean;
  anchor_kind: "path" | "task" | "proposal" | null;
  anchor_path: string | null;
  anchor_step: string | null;
  anchor_plan_path: string | null;
  anchor_step_key: string | null;
  anchor_proposal: string | null;
  opened_by: string;
  agent: string | null;
  opened_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_agent: string | null;
  messages: number;
  last_message_id: string;
  last_message_at: Date;
};

// The files of this vault, among `paths`, that are there now.
export async function liveFiles(c: pg.PoolClient, vaultId: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const { rows } = await c.query(`select path from public.files where vault_id = $1 and deleted_at is null and path = any($2::text[])`, [vaultId, paths]);
  return new Set(rows.map((r) => r.path as string));
}

// "About ..." for each thread that has an anchor: a file, a task (with its
// plan's file) or a proposal, linked when what it names is still there. A file
// anchor can name a file that doesn't exist yet, and then it is only text.
export async function anchorLines(c: pg.PoolClient, vaultId: string, rows: ThreadRow[]): Promise<Map<string, Raw>> {
  const out = new Map<string, Raw>();
  const steps = rows.map((r) => r.anchor_step).filter((s): s is string => s !== null);
  const proposals = rows.map((r) => r.anchor_proposal).filter((p): p is string => p !== null);
  const live = await liveFiles(c, vaultId, rows.flatMap((r) => [r.anchor_path, r.anchor_plan_path]).filter((p): p is string => p !== null));
  const titles = new Map<string, string>();
  if (steps.length) {
    const { rows: found } = await c.query(`select id::text, title from public.work_plan_steps where vault_id = $1 and id = any($2::bigint[])`, [vaultId, steps]);
    for (const s of found) titles.set(s.id, s.title);
  }
  const paths = new Map<string, string>();
  if (proposals.length) {
    const { rows: found } = await c.query(`select id, path from public.proposals where vault_id = $1 and id = any($2::uuid[])`, [vaultId, proposals]);
    for (const p of found) paths.set(p.id, p.path);
  }
  for (const r of rows) {
    if (r.anchor_kind === "path" && r.anchor_path) {
      const p = r.anchor_path;
      out.set(r.id, html`About the file ${live.has(p) ? html`<a href="${filePath(vaultId, p)}">${p}</a>` : html`<code>${p}</code>`}`);
    } else if (r.anchor_kind === "task" && r.anchor_step && r.anchor_plan_path) {
      // The Tasks page isn't linked yet: a task's link is its plan's file.
      const title = titles.get(r.anchor_step) ?? r.anchor_step_key ?? "a task";
      const where = live.has(r.anchor_plan_path) ? html`<a href="${filePath(vaultId, r.anchor_plan_path)}">${title}</a>` : html`${title}`;
      out.set(r.id, html`About the task ${where} in <code>${r.anchor_plan_path}</code>`);
    } else if (r.anchor_kind === "proposal" && r.anchor_proposal && UUID.test(r.anchor_proposal)) {
      const path = paths.get(r.anchor_proposal);
      out.set(r.id, path !== undefined ? html`About the proposal for <a href="${proposalPath(vaultId, r.anchor_proposal)}">${path}</a>` : html`About a proposal`);
    }
  }
  return out;
}

// Who, in a thread's own words: the person, and the agent that acted for them.
export const byline = (ctx: Ctx, id: string | null, agent: string | null): string => {
  if (!id) return agent ? `an agent (${agent})` : "the system";
  const mine = id === ctx.userId;
  if (agent) return `${mine ? "your" : `${personRef(id)}’s`} agent (${agent})`;
  return mine ? "you" : personRef(id);
};

export const threadsPath = (id: string, query = "") => vaultPath(id, `/threads${query}`);
export const threadPath = (id: string, tid: string, rest = "") => vaultPath(id, `/threads/${tid}${rest}`);
