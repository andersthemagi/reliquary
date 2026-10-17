// Search by meaning over MCP (src/embeddings.ts): the server that has an
// EMBED_URL (MCP_SEM_URL, test.sh) calls the function's stand-in
// (test/embed-double.mjs), embeds what the vault has queued in the same
// call as the query, and blends meaning with words. Who may read which
// vectors is proved in supabase/tests/semantic_search_test.sql; this is
// what an agent sees. Runs as Gus (seed.sql), in this file's own vault.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { before, test } from "node:test";
import { call } from "./mcp-client.mjs";
import { chunks } from "../dist/embeddings.js";

const { GUS_RW, MCP_SEM_URL, MCP_URL, EMBED_DOUBLE_URL, SEM_REFS_FILE } = process.env;
const VAULT = `Meaning ${process.pid}`;
const search = (url, query) => call(url, GUS_RW, "search", { vault: VAULT, query });
const write = (path, content) => call(MCP_SEM_URL, GUS_RW, "write_file", { vault: VAULT, path, content });
const functionAnswers = (status) =>
  fetch(`${EMBED_DOUBLE_URL}/_status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) => assert.equal(r.status, 200));

before(async () => {
  assert.equal((await call(MCP_SEM_URL, GUS_RW, "create_vault", { name: VAULT })).isError, false);
  await write("decisions/pricing.md", "# Pricing\n\nSeats and plans: priced per seat.");
  await write("notes/garden.md", "Tomatoes need sun.");
});

test("meaning: a question with no words in common finds the file that answers it, with its lines", async () => {
  const r = await search(MCP_SEM_URL, "what are you charging");
  assert.equal(r.isError, false);
  assert.match(r.text, /^1 file\./);
  assert.match(r.text, /decisions\/pricing\.md {2}open/);
  assert.match(r.text, /\n1: # Pricing\n3: Seats and plans: priced per seat\.\n/);
  assert.doesNotMatch(r.text, /garden/);
});

test("meaning: a server without the function searches by words alone, and says nothing about meaning", async () => {
  const r = await search(MCP_URL, "what are you charging");
  assert.equal(r.text, "No matches.");
});

test("meaning: when the function is down, words still answer, a file not yet embedded included, and the first line says so with a reference", async () => {
  await write("notes/rates.md", "Rates: billing, price per seat.");
  await functionAnswers(503);
  let r;
  try {
    r = await search(MCP_SEM_URL, "rates");
  } finally {
    await functionAnswers(200);
  }
  assert.equal(r.isError, false);
  const [first, second] = r.text.split("\n");
  const m = /^Search by meaning is unavailable right now \(The embedding function answered 503; ref ([0-9a-f]{8})\)\. These results match words only\.$/.exec(first);
  assert.ok(m, first);
  appendFileSync(SEM_REFS_FILE, `${m[1]}\n`);
  assert.match(second, /^1 file\./);
  assert.match(r.text, /notes\/rates\.md/);
});

test("meaning: once the function is back, the next search embeds what waited and finds it by meaning", async () => {
  const r = await search(MCP_SEM_URL, "what will it cost");
  assert.equal(r.isError, false);
  assert.doesNotMatch(r.text, /unavailable/);
  assert.match(r.text, /decisions\/pricing\.md/);
  assert.match(r.text, /^2 files\./);
  assert.match(r.text, /notes\/rates\.md/);
});

test("meaning: chunks are whole lines up to 1,200 characters, a longer line cut, at most 8, each with its first line, blank ones skipped", () => {
  assert.deepEqual(chunks("a\nb\n\n\nc"), [{ line: 1, text: "a\nb\n\n\nc" }]);
  assert.deepEqual(chunks(""), []);
  assert.deepEqual(chunks("\n  \n"), []);
  const long = "x".repeat(1000);
  assert.deepEqual(chunks(`${long}\n${long}\nend`).map((c) => c.line), [1, 2]);
  assert.deepEqual(chunks(`${"y".repeat(2500)}\nz`).map((c) => [c.line, c.text.length]), [[1, 1200], [1, 1200], [1, 102]]);
  assert.equal(chunks(Array.from({ length: 20 }, () => long).join("\n")).length, 8);
});
