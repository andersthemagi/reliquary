// Risk: facts about a proposed change that deserve a closer look before
// approving it. Computed from the change itself (the line diff the reviewer
// sees, diff.ts), never from what the agent says about it.
//
// Each risk has a short label, for a badge in a list row, and a long one, a
// sentence for the proposal page (and the row badge's title).

import { diffLines } from "./diff.js";

export type Risk = { short: string; long: string };

// A proposal as far as risk goes: what it does, the text it proposes, the
// file's current text (null when the file doesn't exist), its revision.
export type RiskInput = { kind: string; body: string | null; current_body: string | null; revision: number };

// A file shorter than this (in non-blank lines) is too small for "half of
// it" to mean anything.
const MIN_LINES = 4;

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

// How the current text's non-blank lines fare in the proposed text, change
// by change (a run of removed and added lines in the diff): as many removed
// lines as the change adds back are rewritten, the rest are removed (gone,
// with nothing in their place). So editing two lines rewrites two and
// removes none. Past the diff's size cap, an estimate from line counts:
// only a net loss counts as removed.
export function lineChanges(before: string, after: string): { total: number; removed: number; rewritten: number } {
  const text = (s: string) => s.split("\n").filter((l) => l.trim()).length;
  const total = text(before);
  const d = diffLines(before, after);
  if (!d) return { total, removed: Math.max(0, total - text(after)), rewritten: 0 };
  let removed = 0;
  let rewritten = 0;
  let dels = 0;
  let adds = 0;
  const close = () => {
    rewritten += Math.min(dels, adds);
    removed += Math.max(0, dels - adds);
    dels = adds = 0;
  };
  for (const l of d) {
    if (l.kind === "same") close();
    else if (l.text.trim()) l.kind === "del" ? dels++ : adds++;
  }
  close();
  return { total, removed, rewritten };
}

export function risks(p: RiskInput, extra: Risk[] = []): Risk[] {
  const out: Risk[] = [];
  if (p.kind === "delete") {
    out.push({ short: "Deletes the file", long: "Approving deletes the file. Its history stays in the log." });
  } else if (p.current_body !== null && p.body !== null) {
    const c = lineChanges(p.current_body, p.body);
    if (c.total >= MIN_LINES && c.removed / c.total >= 0.5) {
      out.push({
        short: `Removes ${c.removed} of ${c.total} lines`,
        long: `Removes ${c.removed} of the file’s ${lines(c.total)}, with nothing in their place.`,
      });
    } else if (c.total >= MIN_LINES && (c.removed + c.rewritten) / c.total >= 0.5) {
      const n = c.removed + c.rewritten;
      out.push({
        short: `Rewrites ${n} of ${c.total} lines`,
        long: `Rewrites ${n} of the file’s ${lines(c.total)}${c.removed ? ` (${c.removed} removed)` : ""}: read each change.`,
      });
    }
  }
  if (p.revision > 1) {
    out.push({
      short: `Revised ${times(p.revision - 1)}`,
      long: `Revised ${times(p.revision - 1)} since it was proposed; approvals of earlier revisions don’t count.`,
    });
  }
  return [...out, ...extra];
}
