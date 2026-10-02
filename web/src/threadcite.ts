// Citations in a thread message: plain-text tokens a reader can follow.
//
//   task:<plan file path>#<step key>    file:<path>    proposal:<proposal id>
//
// Lowercase kind, a colon, then a target with no spaces; punctuation after the
// target ("see file:notes/a.md.") is not part of it. The message is stored
// exactly as typed. Here, and only for display, a citation becomes a link when
// its target exists in THIS vault. A file that isn't there, a proposal id from
// another vault and a plan nobody registered all stay plain text, so a message
// can't be used to learn whether something exists elsewhere. A task links to
// its plan's file for now: the Tasks page isn't linked from here yet.
//
// Nothing parsed here is authority. A citation never approves, reveals,
// breaks or cancels anything, and no server-side code reads one.

import type pg from "pg";
import { html, type Raw } from "./html.js";
import { filePath, proposalPath } from "./pages.js";
import { UUID } from "./personref.js";

type Kind = "task" | "file" | "proposal";
export type Cite = { kind: Kind; target: string; key: string; start: number; end: number };

const TOKEN = /(?<![A-Za-z0-9_/:.#-])(task|file|proposal):(\S+)/g;
const TRAILING = /[.,;:!?)\]}>'"’”]+$/;
const STEP_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A page that cites more distinct things than this links the first of them.
const MAX_TARGETS = 300;

export function citesIn(body: string): Cite[] {
  const out: Cite[] = [];
  for (const m of body.matchAll(TOKEN)) {
    const target = m[2].replace(TRAILING, "");
    if (!target) continue;
    out.push({ kind: m[1] as Kind, target, key: `${m[1]}:${target}`, start: m.index, end: m.index + m[1].length + 1 + target.length });
  }
  return out;
}

// For each citation in `bodies` that names something in the vault, where it
// links to, keyed by the citation as typed ("file:notes/a.md").
export async function resolveCites(c: pg.PoolClient, vaultId: string, bodies: string[]): Promise<Map<string, string>> {
  const found = new Map<string, Cite>();
  for (const b of bodies) for (const cite of citesIn(b)) if (found.size < MAX_TARGETS) found.set(cite.key, cite);
  const links = new Map<string, string>();
  const of = (kind: Kind) => [...found.values()].filter((x) => x.kind === kind);

  const files = of("file");
  if (files.length) {
    const { rows } = await c.query(`select path from public.files where vault_id = $1 and deleted_at is null and path = any($2::text[])`, [vaultId, files.map((x) => x.target)]);
    for (const r of rows) links.set(`file:${r.path}`, filePath(vaultId, r.path));
  }
  const proposals = of("proposal").filter((x) => UUID.test(x.target));
  if (proposals.length) {
    const { rows } = await c.query(`select id from public.proposals where vault_id = $1 and id = any($2::uuid[])`, [vaultId, proposals.map((x) => x.target)]);
    for (const r of rows) links.set(`proposal:${r.id}`, proposalPath(vaultId, r.id));
  }
  const tasks = of("task").flatMap((x) => {
    const at = x.target.lastIndexOf("#");
    return at > 0 && STEP_KEY.test(x.target.slice(at + 1)) ? [{ path: x.target.slice(0, at), step: x.target.slice(at + 1) }] : [];
  });
  if (tasks.length) {
    // A task links to its plan's file, so it has to be there to link to.
    const { rows } = await c.query(
      `select t.path, t.step from unnest($2::text[], $3::text[]) as t(path, step)
        where exists (select 1 from public.work_plans wp
                        join public.work_plan_steps st on st.plan_id = wp.id and st.key = t.step
                        join public.files f on f.vault_id = wp.vault_id and f.path = wp.path and f.deleted_at is null
                       where wp.vault_id = $1 and wp.path = t.path)`,
      [vaultId, tasks.map((x) => x.path), tasks.map((x) => x.step)],
    );
    for (const r of rows) links.set(`task:${r.path}#${r.step}`, filePath(vaultId, r.path));
  }
  return links;
}

// The message as text, with each citation that resolved as a link. Everything
// else, and every citation that didn't resolve, is escaped text.
export function citedText(body: string, links: Map<string, string>): Raw {
  const parts: (string | Raw)[] = [];
  let at = 0;
  for (const cite of citesIn(body)) {
    parts.push(body.slice(at, cite.start));
    const href = links.get(cite.key);
    parts.push(href ? html`<a href="${href}">${cite.key}</a>` : cite.key);
    at = cite.end;
  }
  parts.push(body.slice(at));
  return html`${parts}`;
}
