// Search in the server (docs/design.md, "Encryption at rest: the content
// key", section 4; #463): the database can't match words or rank vectors
// it can't read, so public.search_files returns a vault's live files,
// newest first, up to SEARCH_CAP, and this file does what public.search
// did in SQL: the word match and its rank, the cosine scoring, the blend,
// and the lines each hit shows. The same file as mcp/src/search.ts.
//
// Words follow websearch_to_tsquery('simple'): plain words are all
// required, "a phrase" is adjacent words, `or` separates alternatives and
// -word leaves a word out. A word is a run of letters or digits, lowercased
// (the simple dictionary does no stemming). Words are matched over a file's
// first HEAD_CHARS, the slice meaning already covers; a longer file is
// found by its path and its head. The rank is ts_rank's for a single term
// or an `or` (0.1 per occurrence, falling off as 1/n², over the Zeta(2)
// normaliser), summed over terms; the same number public.search gave for
// most queries.
// ponytail: ts_rank's distance-based rank for `and` queries isn't copied;
// term sums order those too. Copy calc_rank_and if an ordering test needs it.
//
// Meaning: a stored vector is 384 float4s in network order (float4send,
// the layout SQL tests can build); cosine against the query's, the best
// chunk per file at the floor, blended with words by reciprocal rank
// (1 / (60 + position) in each list), as the SQL did.

const RANK_NORMALISER = 1.64493406685; // Zeta(2), as ts_rank divides by
const TERM_WEIGHT = 0.1; // ts_rank's default weight for position class D
const MAX_POSITIONS = 256; // to_tsvector keeps at most this many per word
const HEAD_CHARS = 10_000;
export const SEARCH_CAP = 2000;
export const DIMENSIONS = 384;
const SNIPPET_LINES = 3;
const SNIPPET_CHARS = 200;

export type Candidate = {
  path: string;
  policy: string;
  body: string;
  updated_at: Date;
  author: string;
  agent: string | null;
};
export type Vector = { path: string; line: number; embedding: Buffer };
export type Hit = Omit<Candidate, "body"> & { rank: number; line: number | null; lines: [number, string][] };

// One alternative of a query: every `must` term present, no `not` term.
// A term is one word or the words of a phrase, in order.
type Group = { must: string[][]; not: string[][] };

const WORD = /[\p{L}\p{N}]+/gu;
export const words = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

export function parseQuery(q: string): Group[] {
  const groups: Group[] = [];
  let g: Group = { must: [], not: [] };
  const push = (term: string[], negate: boolean) => {
    if (term.length) (negate ? g.not : g.must).push(term);
  };
  for (const m of q.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      push(words(m[2]), m[1] === "-");
      continue;
    }
    const tok = m[3];
    if (tok.toLowerCase() === "or") {
      if (g.must.length || g.not.length) groups.push(g);
      g = { must: [], not: [] };
      continue;
    }
    push(words(tok.startsWith("-") ? tok.slice(1) : tok), tok.startsWith("-"));
  }
  if (g.must.length || g.not.length) groups.push(g);
  return groups;
}

// How often a term occurs in the head's words, at most MAX_POSITIONS.
function occurrences(head: string[], term: string[]): number {
  let n = 0;
  for (let i = 0; i + term.length <= head.length && n < MAX_POSITIONS; i++) {
    let j = 0;
    while (j < term.length && head[i + j] === term[j]) j++;
    if (j === term.length) n++;
  }
  return n;
}

const termRank = (n: number) => {
  let s = 0;
  for (let j = 1; j <= n; j++) s += TERM_WEIGHT / (j * j);
  return s / RANK_NORMALISER;
};

// ts_rank-like score of a body's head for the query, or null when it
// doesn't match: some alternative has every required term and none left
// out. The score sums every term of the query that occurs, as ts_rank does
// for an `or`. A query with no terms matches nothing.
export function wordScore(body: string, groups: Group[]): number | null {
  if (groups.length === 0) return null;
  const head = words(body.slice(0, HEAD_CHARS));
  const count = new Map<string, number>();
  const n = (t: string[]) => {
    const k = t.join(" ");
    if (!count.has(k)) count.set(k, occurrences(head, t));
    return count.get(k)!;
  };
  const matched = groups.some((g) => g.must.every((t) => n(t) > 0) && g.not.every((t) => n(t) === 0));
  if (!matched) return null;
  return groups.flatMap((g) => g.must).reduce((s, t) => s + termRank(n(t)), 0);
}

// The words of a query, for picking lines: quotes, `or` and -exclusions
// dropped. Which files match is decided above; this only chooses lines.
export function queryTerms(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/"/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "or" && !w.startsWith("-"))
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

// Up to three lines of a file that hold a searched word, numbered; else
// the first three non-blank lines from `line` (a hit by meaning alone);
// else the first non-blank line (a path match). Each cut at 200 characters.
export function pickLines(body: string, terms: string[], line: number | null): [number, string][] {
  const lines = body.split("\n");
  const clip = (l: string) => (l.length > SNIPPET_CHARS ? l.slice(0, SNIPPET_CHARS) + "..." : l);
  const out: [number, string][] = [];
  for (let i = 0; i < lines.length && out.length < SNIPPET_LINES; i++) {
    const low = lines[i].toLowerCase();
    if (terms.some((t) => low.includes(t))) out.push([i + 1, clip(lines[i])]);
  }
  if (out.length) return out;
  const want = line === null ? 1 : SNIPPET_LINES;
  for (let i = Math.max(0, (line ?? 1) - 1); i < lines.length && out.length < want; i++) {
    if (lines[i].trim() !== "") out.push([i + 1, clip(lines[i])]);
  }
  return out;
}

export function vectorBytes(v: number[]): Buffer {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => b.writeFloatBE(x, i * 4));
  return b;
}

function cosineDistance(a: number[], b: Buffer): number {
  if (b.length !== a.length * 4) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const y = b.readFloatBE(i * 4);
    dot += a[i] * y;
    na += a[i] * a[i];
    nb += y * y;
  }
  const n = Math.sqrt(na) * Math.sqrt(nb);
  return n === 0 ? 1 : 1 - dot / n;
}

const RRF = 60;

// public.search's answer, in memory: `limit` hits (1 to 100), best first.
export function rankFiles(files: Candidate[], query: string, limit: number, vector: number[] | null, minSimilarity: number, vectors: Vector[] = []): Hit[] {
  const n = Math.min(Math.max(limit ?? 20, 1), 100);
  const groups = parseQuery(query);
  const path = query.trim().toLowerCase();
  const terms = queryTerms(query);
  const byPath = new Map(files.map((f) => [f.path, f]));

  const words = files
    .map((f) => ({ f, score: wordScore(f.body, groups) }))
    .filter((w) => w.score !== null || (path !== "" && w.f.path.toLowerCase().includes(path)))
    .map((w) => ({ f: w.f, score: w.score ?? 0 }))
    .sort((a, b) => b.score - a.score || b.f.updated_at.getTime() - a.f.updated_at.getTime())
    .slice(0, n);

  const meaning: { f: Candidate; line: number; d: number }[] = [];
  if (vector) {
    const near = vectors
      .filter((v) => byPath.has(v.path))
      .map((v) => ({ f: byPath.get(v.path)!, line: v.line, d: cosineDistance(vector, v.embedding) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n * 4);
    const seen = new Set<string>();
    for (const m of near) {
      if (1 - m.d < minSimilarity || seen.has(m.f.path)) continue;
      seen.add(m.f.path);
      meaning.push(m);
    }
  }

  type Row = { f: Candidate; rank: number; line: number | null; wordPos: number };
  const rows = new Map<string, Row>();
  words.forEach((w, i) => rows.set(w.f.path, { f: w.f, rank: vector ? 1 / (RRF + i + 1) : w.score, line: null, wordPos: i + 1 }));
  meaning.forEach((m, i) => {
    const r = rows.get(m.f.path);
    if (r) {
      r.rank += 1 / (RRF + i + 1);
      r.line = m.line;
    } else rows.set(m.f.path, { f: m.f, rank: 1 / (RRF + i + 1), line: m.line, wordPos: Infinity });
  });
  return [...rows.values()]
    .sort((a, b) => b.rank - a.rank || b.f.updated_at.getTime() - a.f.updated_at.getTime() || a.wordPos - b.wordPos)
    .slice(0, n)
    .map(({ f, rank, line }) => ({
      path: f.path,
      policy: f.policy,
      updated_at: f.updated_at,
      author: f.author,
      agent: f.agent,
      rank,
      line,
      lines: pickLines(f.body, terms, line),
    }));
}

// The note a search opens with when a vault has more files than it read.
export const capNote = (total: number, read: number): string =>
  total > read ? `This vault has ${total.toLocaleString("en")} files; the newest ${read.toLocaleString("en")} were searched.` : "";
