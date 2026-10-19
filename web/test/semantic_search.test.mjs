// Search by meaning in the web app (src/embeddings.ts): a server with an
// EMBED_URL calls the function's stand-in (mcp/test/embed-double.mjs, the
// same contract as supabase/functions/embed) and both search pages find a
// file by meaning. Who may read which vectors is proved in
// supabase/tests/semantic_search_test.sql, and the queue and the blend over
// MCP in mcp/test/semantic_search.test.mjs; this is what a person sees.
//
// Its own person and vaults (start-as.mjs): Odile owns "Meaning Main" and
// "Meaning Side"; her server searches by meaning, and a second one of hers
// has no EMBED_URL.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import pg from "pg";
import { freePort, startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const ODILE = "97700000-0000-0000-0000-000000000977";
// Checked against the server log below: the log may never hold it.
const SECRET = `EMBEDSECRET-web-${process.pid}`;

const S = {};
const V = {};
let embedUrl = "";
let double;

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

const page = async (who, path) => (await fetch(S[who].url + path, { headers: { cookie: S[who].cookie } })).text();
const functionAnswers = (status) =>
  fetch(`${embedUrl}/_status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) => assert.equal(r.status, 200));
const results = (h) => [...h.matchAll(/<a class="name" href="[^"]*">([^<]*)<\/a>/g)].map((m) => m[1]);
const note = (h) => /<div class="callout warning"><p>([^<]*)<\/p><\/div>/.exec(h)?.[1] ?? "";

before(async () => {
  const port = await freePort();
  embedUrl = `http://127.0.0.1:${port}`;
  double = spawn(process.execPath, [`${process.env.REPO_DIR}/mcp/test/embed-double.mjs`], { env: { PORT: String(port), EMBED_SECRET: SECRET }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${embedUrl}/_calls`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  await db.query(`insert into auth.users (id, email) values ($1, 'odile@example.test') on conflict (id) do nothing`, [ODILE]);
  await db.end();
  [{ id: V.main }] = await as(ODILE, "select public.create_vault('Meaning Main') as id");
  [{ id: V.side }] = await as(ODILE, "select public.create_vault('Meaning Side') as id");
  await as(ODILE, "select public.write_file($1, 'decisions/pricing.md', E'# Pricing\\n\\nSeats and plans: priced per seat.')", [V.main]);
  await as(ODILE, "select public.write_file($1, 'notes/garden.md', 'Tomatoes need sun.')", [V.main]);
  await as(ODILE, "select public.write_file($1, 'notes/rates.md', 'Rates: billing, price per seat.')", [V.side]);
  // The stand-in's vectors are bags of words, which score lower than
  // gte-small's, hence the lower floor (as mcp/test.sh sets it).
  S.meaning = await startAs(ODILE, { EMBED_URL: `${embedUrl}/`, EMBED_SECRET: SECRET, EMBED_MIN_SIMILARITY: "0.5" });
  S.words = await startAs(ODILE);
});

after(() => {
  for (const s of Object.values(S)) s.stop();
  double?.kill();
});

test("web meaning: the search across every vault finds a file by meaning with no shared words, in each vault, and nothing unrelated", async () => {
  const h = await page("meaning", `/search?q=${encodeURIComponent("what are we charging")}`);
  assert.deepEqual(results(h).sort(), ["decisions/pricing.md", "notes/rates.md"]);
  assert.doesNotMatch(h, /garden/);
  assert.equal(note(h), "");
});

test("web meaning: a vault's own search finds a file by meaning, showing the lines of the part that matched", async () => {
  const h = await page("meaning", `/v/${V.main}/search?q=${encodeURIComponent("what will it cost")}`);
  assert.deepEqual(results(h), ["decisions/pricing.md"]);
  assert.match(h, /<span class="line-no">1<\/span> # Pricing<\/span>/);
  assert.match(h, /<span class="line-no">3<\/span> Seats and plans: priced per seat\.<\/span>/);
});

test("web meaning: when the function is down, both pages still answer by words and say search by meaning is unavailable, with a reference that is in the server log", async () => {
  await functionAnswers(503);
  let all, one;
  try {
    all = await page("meaning", "/search?q=rates");
    one = await page("meaning", `/v/${V.side}/search?q=rates`);
  } finally {
    await functionAnswers(200);
  }
  for (const h of [all, one]) {
    assert.deepEqual(results(h), ["notes/rates.md"]);
    const m = /^Search by meaning is unavailable right now \(The embedding function answered 503; ref ([0-9a-f]{8})\)\. These results match words only\.$/.exec(note(h));
    assert.ok(m, note(h));
    assert.match(S.meaning.log(), new RegExp(`ref=${m[1]}`));
  }
  assert.doesNotMatch(S.meaning.log(), new RegExp(SECRET));
});

test("web meaning: without EMBED_URL the pages search by words and say nothing about meaning", async () => {
  const miss = await page("words", `/search?q=${encodeURIComponent("what are we charging")}`);
  assert.match(miss, /Nothing in your vaults matches/);
  const hit = await page("words", `/v/${V.main}/search?q=tomatoes`);
  assert.deepEqual(results(hit), ["notes/garden.md"]);
  for (const h of [miss, hit]) assert.doesNotMatch(h, /Search by meaning is unavailable/);
});
