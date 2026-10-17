// Run by quality.sh, inside a node container with mcp/ built at /mcp: loads
// /vault into a throwaway vault, embeds every file, and asks each question
// of /questions.tsv through the MCP server's own search (searchHits,
// queryVector), by words alone and by words and meaning. Nothing judges
// relevance but the path the questions file names.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const { pool } = await import("/mcp/dist/db.js");
const { configureEmbeddings, minSimilarity, queryVector } = await import("/mcp/dist/embeddings.js");
const { searchHits } = await import("/mcp/dist/vaultfiles-tools.js");

const OWNER = "00000000-0000-0000-0000-0000000000b1";
const TOP = 10;
const meaningLabel = process.env.QUALITY_MEANING_LABEL ?? "";
configureEmbeddings(process.env);

async function as(fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: OWNER, role: "authenticated" }),
    ]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// Every file under /vault but dot-files and dot-folders (.git, .obsidian).
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );

const vault = await as(async (c) => (await c.query("select public.create_vault('Search quality') as id")).rows[0].id);
const paths = new Set();
const skipped = [];
for (const file of walk("/vault")) {
  const path = relative("/vault", file);
  const body = readFileSync(file, "utf8");
  if (body.includes("\0") || body.includes("�")) {
    skipped.push(`${path}: not text`);
    continue;
  }
  try {
    await as((c) => c.query("select public.write_file($1, $2, $3)", [vault, path, body]));
    paths.add(path);
  } catch (err) {
    skipped.push(`${path}: ${err.message}`);
  }
}

const questions = readFileSync("/questions.tsv", "utf8")
  .split("\n")
  .map((l, i) => ({ line: i + 1, raw: l }))
  .filter(({ raw }) => raw.trim() !== "" && !raw.startsWith("#"))
  .map(({ line, raw }) => {
    const [q, want, ...rest] = raw.split("\t");
    return { line, q: q?.trim(), want: want?.trim(), bad: rest.length > 0 || !q?.trim() || !want?.trim() };
  });
const malformed = questions.filter((x) => x.bad);
const unknown = questions.filter((x) => !x.bad && !paths.has(x.want));
if (malformed.length || unknown.length || questions.length === 0) {
  console.error("quality: the questions file can't be measured as it is:");
  if (questions.length === 0) console.error("  it has no questions (one per line: the question, a tab, the path)");
  for (const x of malformed) console.error(`  line ${x.line}: needs exactly a question, one tab, and a path`);
  for (const x of unknown) console.error(`  line ${x.line}: ${x.want} isn't a file in the vault that was loaded`);
  process.exit(1);
}

// Embeds every file the way searches do, a batch a call, until none wait.
let meaningNote = meaningLabel ? "" : "not measured: no embedding function was started (QUALITY_EMBED=none)";
if (meaningLabel) {
  for (let left = Infinity; ; ) {
    const n = await as(async (c) => Number((await c.query("select count(*) as n from private.embedding_pending($1, 50)", [vault])).rows[0].n));
    if (n === 0) break;
    if (n >= left) {
      meaningNote = `not measured: ${n} files stayed unembedded`;
      break;
    }
    left = n;
    const { note } = await as((c) => queryVector(c, vault, "warm up"));
    if (note) {
      meaningNote = `not measured: ${note}`;
      break;
    }
  }
}

const position = (hits, want) => hits.findIndex((h) => h.path === want) + 1 || null;
const results = [];
for (const x of questions) {
  const r = { ...x };
  r.words = await as(async (c) => position(await searchHits(c, vault, x.q, TOP, null), x.want));
  if (!meaningNote) {
    await as(async (c) => {
      const { vector, note } = await queryVector(c, vault, x.q);
      if (note) meaningNote = `not measured: ${note}`;
      else r.meaning = position(await searchHits(c, vault, x.q, TOP, vector), x.want);
    });
  }
  results.push(r);
}
await pool.end();

const n = results.length;
const pct = (k) => `${k} of ${n} (${Math.round((100 * k) / n)}%)`;
const where = (p) => (p === null ? `not in the top ${TOP}` : `at ${p}`);
const methods = [["words", "words"]];
if (!meaningNote) methods.push(["meaning", "words and meaning"]);

console.log(`${n} questions over ${paths.size} files.`);
for (const s of skipped) console.log(`Not loaded: ${s}`);
console.log(`Meaning: ${meaningNote || `${meaningLabel}, similarity floor ${minSimilarity()}`}`);
console.log();
console.log(`${"search".padEnd(20)}${"right file first".padEnd(20)}in the top 5`);
for (const [key, label] of methods) {
  const first = results.filter((r) => r[key] === 1).length;
  const top5 = results.filter((r) => r[key] !== null && r[key] <= 5).length;
  console.log(`${label.padEnd(20)}${pct(first).padEnd(20)}${pct(top5)}`);
}
for (const [key, label] of methods) {
  const missed = results.filter((r) => r[key] !== 1);
  console.log();
  console.log(`Not first by ${label} (${missed.length}):`);
  for (const r of missed) console.log(`  line ${r.line}: "${r.q}" wants ${r.want}, ${where(r[key])}`);
}
