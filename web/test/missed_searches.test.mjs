// Searches that found nothing in the web app (20261017130000_missed_searches.sql):
// a vault's own search and the search across every vault note the words for
// the vault's owners. Who may read the list is proved in
// supabase/tests/missed_searches_test.sql; these check the wiring.
//
// Its own people and vaults: Mira owns "Missed Main" (Nell edits) and
// "Missed Side". Each gets a server of their own (start-as.mjs).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const MIRA = "97500000-0000-0000-0000-000000000975";
const NELL = "97600000-0000-0000-0000-000000000976";

const S = {};
const V = {};

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

async function as(user, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const page = async (who, path) => (await fetch(S[who].url + path, { headers: { cookie: S[who].cookie }, redirect: "manual" })).text();
const missed = async (vault) =>
  (await sql("select words, by_agent from public.missed_searches where vault_id = $1 order by id", [vault])).map((r) => `${r.words}:${r.by_agent}`);

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'mira@example.test'), ($2, 'nell@example.test') on conflict (id) do nothing`, [MIRA, NELL]);
  [{ id: V.main }] = await as(MIRA, "select public.create_vault('Missed Main') as id");
  [{ id: V.side }] = await as(MIRA, "select public.create_vault('Missed Side') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, NELL, MIRA]);
  await as(MIRA, "select public.write_file($1, 'notes/kiln.md', 'Kiln firing schedule.')", [V.side]);
  S.mira = await startAs(MIRA);
  S.nell = await startAs(NELL);
});

after(() => {
  for (const s of Object.values(S)) s.stop();
});

test("missed in the web app: a vault's own search that finds nothing is noted as a person's, words only", async () => {
  assert.match(await page("nell", `/v/${V.main}/search?q=${encodeURIComponent("glaze recipes")}`), /Nothing matches/);
  assert.deepEqual(await missed(V.main), ["glaze recipes:false"]);
});

test("missed in the web app: searching every vault notes the words in each vault that found nothing, and not in one that found something", async () => {
  assert.match(await page("mira", "/search?q=kiln"), /notes\/kiln\.md/);
  assert.deepEqual(await missed(V.main), ["glaze recipes:false", "kiln:false"]);
  assert.deepEqual(await missed(V.side), []);
});
