// Diffs for the proposal review page: a line diff (longest common
// subsequence), then word-level highlights inside changed lines that pair up.
// Files are small context documents, so O(n·m) is fine after trimming the
// common start and end; the work is capped, and past the cap the caller shows
// the proposed text whole with a notice instead of a diff.

export type Seg = { text: string; changed: boolean };
export type DiffLine = {
  kind: "same" | "add" | "del";
  text: string;
  a?: number; // line number in the current text (same, del)
  b?: number; // line number in the proposed text (same, add)
  segs?: Seg[]; // word highlights, only on paired changed lines
  mate?: DiffLine; // the removed/added line this one pairs with
};

// Line LCS table cells, and characters per side, before giving up.
export const MAX_CELLS = 4_000_000;
export const MAX_CHARS = 1_000_000;
// Word diffs: cells per line pair, and for the whole file.
const MAX_WORD_CELLS = 250_000;
const MAX_WORD_BUDGET = 2_000_000;
// How far ahead among added lines to look for a removed line's partner.
const PAIR_WINDOW = 8;

type Op = { kind: "same" | "add" | "del"; text: string };

// LCS over two token arrays. Returns null when the table would exceed
// maxCells. Common prefix and suffix are matched first, so a small edit in a
// long file costs almost nothing.
function lcs(a: string[], b: string[], maxCells: number): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if ((A.length + 1) * (B.length + 1) > maxCells) return null;

  const n = A.length;
  const m = B.length;
  const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = t[i];
    const next = t[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const out: Op[] = a.slice(0, pre).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: "same", text: A[i] });
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) {
      out.push({ kind: "del", text: A[i++] });
    } else {
      out.push({ kind: "add", text: B[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: A[i++] });
  while (j < m) out.push({ kind: "add", text: B[j++] });
  for (const text of a.slice(a.length - suf)) out.push({ kind: "same", text });
  return out;
}

// Words, runs of whitespace, and single punctuation marks.
export function tokenize(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

// Word highlights for one removed/added pair. Null when the pair is too long
// to compare, or so different that highlighting would mark nearly everything
// (then the whole line is the change, and the line colour already says so).
export function wordDiff(before: string, after: string, maxCells = MAX_WORD_CELLS): { del: Seg[]; add: Seg[] } | null {
  const ops = lcs(tokenize(before), tokenize(after), maxCells);
  if (!ops) return null;
  const kept = ops.filter((o) => o.kind === "same" && o.text.trim()).reduce((n, o) => n + o.text.length, 0);
  const longest = Math.max(before.replace(/\s/g, "").length, after.replace(/\s/g, "").length);
  if (longest === 0 || kept / longest < 0.4) return null;
  return { del: segments(ops, "del"), add: segments(ops, "add") };
}

function segments(ops: Op[], side: "del" | "add"): Seg[] {
  const segs: Seg[] = [];
  for (const o of ops) {
    if (o.kind !== "same" && o.kind !== side) continue;
    const changed = o.kind === side;
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += o.text;
    else segs.push({ text: o.text, changed });
  }
  // A lone space between two changes reads better as part of one change.
  for (let k = 1; k < segs.length - 1; k++) {
    if (!segs[k].changed && !segs[k].text.trim() && segs[k - 1].changed && segs[k + 1].changed) {
      segs[k - 1].text += segs[k].text + segs[k + 1].text;
      segs.splice(k, 2);
      k--;
    }
  }
  return segs;
}

// Line diff with line numbers, removed lines before added ones within each
// change, and word highlights on lines that pair up. A removed line pairs
// with the next similar added line, in order, so an inserted paragraph
// before an edited one doesn't hide the edit. Null when too large.
export function diffLines(before: string, after: string): DiffLine[] | null {
  if (before.length > MAX_CHARS || after.length > MAX_CHARS) return null;
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = lcs(a, b, MAX_CELLS);
  if (!ops) return null;

  const out: DiffLine[] = [];
  let na = 0;
  let nb = 0;
  let budget = MAX_WORD_BUDGET;
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    let from = 0;
    for (const d of dels) {
      for (let k = from; k < Math.min(adds.length, from + PAIR_WINDOW); k++) {
        const cells = (tokenize(d.text).length + 1) * (tokenize(adds[k].text).length + 1);
        if (cells > budget) break;
        budget -= cells;
        const w = wordDiff(d.text, adds[k].text);
        if (w) {
          d.segs = w.del;
          adds[k].segs = w.add;
          d.mate = adds[k];
          adds[k].mate = d;
          from = k + 1;
          break;
        }
      }
    }
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const o of ops) {
    if (o.kind === "same") {
      flush();
      out.push({ kind: "same", text: o.text, a: ++na, b: ++nb });
    } else if (o.kind === "del") dels.push({ kind: "del", text: o.text, a: ++na });
    else adds.push({ kind: "add", text: o.text, b: ++nb });
  }
  flush();
  return out;
}

// Side by side: each row has a current (left) and proposed (right) cell.
// Paired removed/added lines share a row; unpaired ones between pairs sit
// side by side, and the shorter side is left blank.
export type SplitRow = { left?: DiffLine; right?: DiffLine };

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let k = 0;
  while (k < lines.length) {
    const l = lines[k];
    if (l.kind === "same") {
      rows.push({ left: l, right: l });
      k++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (k < lines.length && lines[k].kind === "del") dels.push(lines[k++]);
    while (k < lines.length && lines[k].kind === "add") adds.push(lines[k++]);
    let i = 0;
    let j = 0;
    const zip = (iEnd: number, jEnd: number) => {
      while (i < iEnd || j < jEnd) rows.push({ left: i < iEnd ? dels[i++] : undefined, right: j < jEnd ? adds[j++] : undefined });
    };
    for (const d of dels) {
      if (!d.mate) continue;
      zip(dels.indexOf(d), adds.indexOf(d.mate));
      rows.push({ left: dels[i++], right: adds[j++] });
    }
    zip(dels.length, adds.length);
  }
  return rows;
}

// Runs of unchanged lines longer than this are folded, keeping CONTEXT lines
// on each side of a change.
export const CONTEXT = 3;

export type Chunk<T> = { fold: false; items: T[] } | { fold: true; items: T[] };

// Groups rows into shown and folded chunks. `same` says whether a row is
// unchanged context.
export function fold<T>(rows: T[], same: (r: T) => boolean): Chunk<T>[] {
  const chunks: Chunk<T>[] = [];
  let k = 0;
  while (k < rows.length) {
    if (!same(rows[k])) {
      const start = k;
      while (k < rows.length && !same(rows[k])) k++;
      chunks.push({ fold: false, items: rows.slice(start, k) });
      continue;
    }
    const start = k;
    while (k < rows.length && same(rows[k])) k++;
    const run = rows.slice(start, k);
    const head = start === 0 ? 0 : CONTEXT;
    const tail = k === rows.length ? 0 : CONTEXT;
    if (run.length > head + tail + 2) {
      if (head) chunks.push({ fold: false, items: run.slice(0, head) });
      chunks.push({ fold: true, items: run.slice(head, run.length - tail) });
      if (tail) chunks.push({ fold: false, items: run.slice(run.length - tail) });
    } else chunks.push({ fold: false, items: run });
  }
  // Nothing changed at all: show the file rather than one folded block.
  if (chunks.length === 1 && chunks[0].fold) return [{ fold: false, items: chunks[0].items }];
  return chunks;
}
