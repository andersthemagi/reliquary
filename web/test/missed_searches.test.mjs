// Searches that found nothing in the web app (20261017140000_missed_searches.sql):
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
const post = async (who, path, fields = {}) => {
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
  return fetch(S[who].url + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].url },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  });
};
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  return /<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "";
};
const days = async (vault) => (await sql("select missed_search_days as d from public.vaults where id = $1", [vault]))[0].d;
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

test("missed settings: an owner's General settings list the searches, newest first, saying person or agent, never who", async () => {
  await sql("insert into public.missed_searches (vault_id, words, by_agent, searched_at) values ($1, 'clay suppliers', true, now() + interval '1 minute')", [V.main]);
  const h = await page("mira", `/v/${V.main}/config`);
  const section = /<section class="panel" id="missed"[\s\S]*?<\/section>/.exec(h)?.[0] ?? "";
  assert.match(section, /<h2 id="missed-title">Searches that found nothing<\/h2>/);
  const rows = [...section.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(rows, ["clay suppliers:An agent", "kiln:A person", "glaze recipes:A person"]);
  assert.doesNotMatch(section, /mira|nell|example\.test/i);
  assert.match(section, /<input id="missed-days" type="number" name="days" min="1" max="365" value="30" required>/);
  assert.match(section, /<button class="danger">Clear list<\/button>/);
});

test("missed settings: an editor's General settings have no such section", async () => {
  const h = await page("nell", `/v/${V.main}/config`);
  assert.match(h, /Danger zone/);
  assert.doesNotMatch(h, /Searches that found nothing|glaze recipes/);
});

test("missed settings: an owner sets how many days are kept; a number outside 1 to 365 is refused in words and nothing changes", async () => {
  assert.equal(await flashAfter("mira", await post("mira", `/v/${V.main}/config/missed`, { days: "7" })), "Searches that found nothing are kept 7 days now.");
  assert.equal(await days(V.main), 7);
  const refused = await flashAfter("mira", await post("mira", `/v/${V.main}/config/missed`, { days: "400" }));
  assert.match(refused, /kept 1 to 365 days.*ref [0-9a-f]{8}/);
  assert.equal(await days(V.main), 7);
});

test("missed settings: an editor's Clear list is refused in words and clears nothing; an owner's clears the list", async () => {
  const refused = await flashAfter("nell", await post("nell", `/v/${V.main}/config/missed/clear`));
  assert.match(refused, /Only the vault(?:’|&#39;)s owners clear this list\. Nothing was cleared.*ref [0-9a-f]{8}/);
  assert.equal((await missed(V.main)).length, 3);
  assert.equal(await flashAfter("mira", await post("mira", `/v/${V.main}/config/missed/clear`)), "Cleared 3 searches.");
  assert.deepEqual(await missed(V.main), []);
  assert.match(await page("mira", `/v/${V.main}/config`), /No searches that found nothing in the last 7 days\./);
});
