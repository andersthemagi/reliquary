// An agent's search that finds nothing is noted for the vault's owners
// (private.note_missed_search, 20261017140000_missed_searches.sql): the
// words and that an agent searched, never which. Who may read the list is
// proved in supabase/tests/missed_searches_test.sql; this is the wiring.
// Runs as Gus (seed.sql) in his vault Limits, with words no other file
// searches for.

import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { call } from "./mcp-client.mjs";

const { GUS_RW, MCP_URL, TEST_SUPER_URL } = process.env;
const VAULT = "Limits";
const MISS = `what do we charge ${process.pid}`;
const search = (query) => call(MCP_URL, GUS_RW, "search", { vault: VAULT, query });

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: TEST_SUPER_URL });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}
const missed = (words) =>
  sql(`select m.words, m.by_agent from public.missed_searches m join public.vaults v on v.id = m.vault_id
        where v.name = $1 and v.created_by = '00000000-0000-0000-0000-000000000011' and m.words = $2`, [VAULT, words]);

test("missed over MCP: a search that finds nothing answers as before and is noted as an agent's, words only", async () => {
  assert.equal((await search(MISS)).text, "No matches.");
  assert.deepEqual(await missed(MISS), [{ words: MISS, by_agent: true }]);
});

test("missed over MCP: a search that finds something is not noted", async () => {
  assert.match((await search("needle")).text, /^1 file\./);
  assert.deepEqual(await missed("needle"), []);
});
