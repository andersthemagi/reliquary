// MCP search picks its matching lines in the database (SEARCH_SQL in
// src/tools.ts) instead of fetching every result's whole text: the same
// lines as before (snippet(), the old way, on the same results), and a
// fraction of the transfer. docs/research/server-load.md, "Third pass".
// Against the test database as Gus (seed.sql); the vault is this file's own.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Session, tokenRef } from "../dist/db.js";
import { queryTerms, searchHits, snippet } from "../dist/tools.js";

const { GUS_RW, TEST_DATABASE_URL } = process.env;
const VAULT = `Search lines ${process.pid}`;
const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
let s;

const FILES = {
  "notes/many.md": "intro\nthe needle is here\nfiller\nanother Needle\nmore filler\nthird NEEDLE\nfourth needle\nend",
  "notes/long-line.md": `short\n${"x".repeat(250)} needle ${"y".repeat(300)}\nafter`,
  "notes/emoji.md": `${"😀".repeat(150)} needle\n${"a😀".repeat(120)} needle\n${"😀".repeat(99)}ab needle`,
  "notes/accents.md": "Ärger über NEEDLE\nÉCOLE des beaux-arts\nécole du soir\nΣΟΦΙΑ και σοφια\nПРИВЕТ мир",
  "notes/crlf.md": "alpha needle\r\nbeta\r\nneedle gamma\r\n",
  "notes/pathonly.md": "\n\n   \n  first real line\nmore",
  "notes/pathonly-spaces.md": "\u00a0\t\n\u3000\n\ufeff\nreal text after odd spaces",
  "notes/pathonly-empty.md": "",
  "notes/pathonly-blank.md": "\n \n\t\n",
  "notes/hay.md": "hay and needle\nneedle only",
};

before(async () => {
  s = new Session(tokenRef(GUS_RW, "http://127.0.0.1/mcp"), db);
  await s.open();
  await s.run(async (c) => {
    const v = (await c.query("select public.create_vault($1) as id", [VAULT])).rows[0].id;
    for (const [path, body] of Object.entries(FILES)) await c.query("select public.write_file($1, $2, $3)", [v, path, body]);
  });
});
after(async () => {
  await s?.close();
  await db.end();
});

// The old way: whole texts from public.search, lines picked in Node.
async function before_(c, query, limit = 10) {
  const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
  const { rows } = await c.query("select path, policy, body, author, agent, updated_at from public.search($1, $2, $3)", [v, query, limit]);
  const terms = queryTerms(query);
  return rows.map(({ body, ...r }) => ({ ...r, lines: body === null ? [] : snippet(body, terms) }));
}

const QUERIES = [
  "needle", "NEEDLE", "\"the needle\"", "needle -hay", "hay or gamma", "école", "ÉCOLE", "über", "σοφια", "привет",
  "pathonly", "pathonly-spaces", "pathonly-empty", "pathonly-blank", "long-line", "emoji", "zzz",
];

test("search lines: the same files, order and lines as picking them in Node, for words, phrases, exclusions, or, case, accents and other scripts, long lines, emoji, CRLF, and path-only matches", async () => {
  await s.run(async (c) => {
    const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
    for (const q of QUERIES) {
      const old = await before_(c, q);
      const now = await searchHits(c, v, q, 10);
      assert.deepEqual(now, old, q);
    }
  });
});

test("search lines: the comparison isn't empty against empty", async () => {
  await s.run(async (c) => {
    const hits = await searchHits(c, VAULT, "needle", 10);
    assert.ok(hits.length >= 5);
    const many = hits.find((h) => h.path === "notes/many.md");
    assert.deepEqual(many.lines, ["2: the needle is here", "4: another Needle", "6: third NEEDLE"]);
    const long = hits.find((h) => h.path === "notes/long-line.md");
    assert.equal(long.lines[0], `2: ${"x".repeat(200)}...`);
    const path = await searchHits(c, VAULT, "pathonly-spaces", 10);
    assert.deepEqual(path[0].lines, ["4: real text after odd spaces"]);
  });
});

test("search lines: the vault is named by name or id, and a limit still applies", async () => {
  await s.run(async (c) => {
    const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
    assert.deepEqual(await searchHits(c, VAULT, "needle", 2), await searchHits(c, v, "needle", 2));
    assert.equal((await searchHits(c, v, "needle", 2)).length, 2);
  });
});

test("search lines: a large file sends its three lines, not its text", async () => {
  // 8,000 lines, about 400 KB, with a match every 1,000 lines.
  const big = Array.from({ length: 8000 }, (_, i) =>
    (i + 1) % 1000 === 0 ? `Workshop line ${i + 1}` : `Line ${i + 1} of filler text for a long document, nothing to match.`,
  ).join("\n");
  await s.run(async (c) => {
    const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
    await c.query("select public.write_file($1, 'big/one.md', $2)", [v, big]);
    const old = await c.query("select body from public.search($1, 'workshop', 10)", [v]);
    const oldBytes = old.rows.reduce((n, r) => n + Buffer.byteLength(r.body ?? ""), 0);
    const hits = await searchHits(c, v, "workshop", 10);
    const newBytes = Buffer.byteLength(JSON.stringify(hits.map((h) => h.lines)));
    assert.deepEqual(hits.find((h) => h.path === "big/one.md").lines, ["1000: Workshop line 1000", "2000: Workshop line 2000", "3000: Workshop line 3000"]);
    console.log(`search-lines: text fetched before ${oldBytes} bytes, lines now ${newBytes} bytes`);
    assert.ok(oldBytes > 400_000 && newBytes < 200, `${oldBytes} -> ${newBytes}`);
  });
});
