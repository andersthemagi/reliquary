// MCP search over the test database as Gus (seed.sql), in this file's own
// vault: the files, order and lines an agent gets for words, phrases,
// exclusions, or, case, accents and other scripts, long lines, emoji, CRLF
// and path-only matches, now that the ranking and the lines are picked in
// this server (src/search.ts; web/test/search_unit.test.mjs has the rules).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { Session, tokenRef } from "../dist/db.js";
import { searchHits } from "../dist/vaultfiles-tools.js";

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
  "notes/pathonly-spaces.md": " \t\n　\n﻿\nreal text after odd spaces",
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

const paths = (hits) => hits.map((h) => h.path).sort();

test("search lines: words, phrases, exclusions, or, case, accents and other scripts, emoji, CRLF and path-only matches find the files they should", async () => {
  await s.run(async (c) => {
    const find = async (q) => paths((await searchHits(c, VAULT, q, 10)).hits);
    const needle = ["notes/accents.md", "notes/crlf.md", "notes/emoji.md", "notes/hay.md", "notes/long-line.md", "notes/many.md"];
    assert.deepEqual(await find("needle"), needle);
    assert.deepEqual(await find("NEEDLE"), needle);
    assert.deepEqual(await find('"the needle"'), ["notes/many.md"]);
    assert.deepEqual(await find("needle -hay"), needle.filter((p) => p !== "notes/hay.md"));
    assert.deepEqual(await find("hay or gamma"), ["notes/crlf.md", "notes/hay.md"]);
    for (const q of ["école", "ÉCOLE", "über", "σοφια", "привет", "beaux"]) assert.deepEqual(await find(q), ["notes/accents.md"], q);
    assert.deepEqual(await find("pathonly"), ["notes/pathonly-blank.md", "notes/pathonly-empty.md", "notes/pathonly-spaces.md", "notes/pathonly.md"]);
    assert.deepEqual(await find("zzz"), []);
  });
});

test("search lines: up to three numbered lines that hold a word, cut at 200 characters; a path-only match shows its first non-blank line, an empty file none", async () => {
  await s.run(async (c) => {
    const { hits, note } = await searchHits(c, VAULT, "needle", 10);
    assert.equal(note, "");
    assert.ok(hits.length >= 5);
    assert.deepEqual(hits.find((h) => h.path === "notes/many.md").lines, ["2: the needle is here", "4: another Needle", "6: third NEEDLE"]);
    assert.equal(hits.find((h) => h.path === "notes/long-line.md").lines[0], `2: ${"x".repeat(200)}...`);
    assert.deepEqual(hits.find((h) => h.path === "notes/crlf.md").lines, ["1: alpha needle\r", "3: needle gamma\r"]);
    const path = (await searchHits(c, VAULT, "pathonly", 10)).hits;
    assert.deepEqual(path.find((h) => h.path === "notes/pathonly-spaces.md").lines, ["4: real text after odd spaces"]);
    assert.deepEqual(path.find((h) => h.path === "notes/pathonly.md").lines, ["4:   first real line"]);
    assert.deepEqual(path.find((h) => h.path === "notes/pathonly-empty.md").lines, []);
  });
});

test("search lines: the vault is named by name or id, and a limit still applies", async () => {
  await s.run(async (c) => {
    const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
    assert.deepEqual(await searchHits(c, VAULT, "needle", 2), await searchHits(c, v, "needle", 2));
    assert.equal((await searchHits(c, v, "needle", 2)).hits.length, 2);
  });
});

test("search lines: a large file is found by its head and its path, and its lines come from its whole text", async () => {
  // 8,000 lines, about 400 KB, with a match every 1,000 lines: past the
  // 10 KB head words are matched over, so "workshop" finds it by its first
  // match at line 1000 only if that is in the head; it isn't, so the path
  // finds it, and a word in its head does.
  const big = Array.from({ length: 8000 }, (_, i) =>
    (i + 1) % 1000 === 0 ? `Workshop line ${i + 1}` : `Line ${i + 1} of filler text for a long document, nothing to match.`,
  ).join("\n");
  await s.run(async (c) => {
    const v = (await c.query("select id from public.vaults where name = $1", [VAULT])).rows[0].id;
    await c.query("select public.write_file($1, 'big/one.md', $2)", [v, `Big workshop notes\n${big}`]);
    const hits = (await searchHits(c, v, "workshop", 10)).hits;
    assert.deepEqual(hits.find((h) => h.path === "big/one.md").lines, ["1: Big workshop notes", "1001: Workshop line 1000", "2001: Workshop line 2000"]);
    assert.deepEqual((await searchHits(c, v, "document", 10)).hits.map((h) => h.path), ["big/one.md"], "a word in the head");
    assert.deepEqual((await searchHits(c, v, "big/one", 10)).hits.map((h) => h.path), ["big/one.md"], "its path");
  });
});
