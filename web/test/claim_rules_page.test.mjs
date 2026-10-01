// Claim rules on the web app's Rules page (src/claimrulespage.ts): the
// section an owner sees and uses to override the fixed defaults by path,
// and that an editor can't. The database's own predicates (resolution,
// specificity, caps, the hold limit) are hostile-tested in
// supabase/tests/claim_rules_test.sql; this file is about what the page
// offers and how a refusal is shown, not the rule itself.
//
// This file starts its own servers from dist/, one signed in as Noa (an
// owner, reused from claims_page.test.mjs's cast but a vault of its own
// here) and one as Edda (an editor). Noa owns "Claim rules main".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const NOA = "00000000-0000-0000-0000-0000000009e1";
const EDDA = "00000000-0000-0000-0000-0000000009e2";

const V = {};
let noa;
let edda;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

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

async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/claim-rules-page-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.child.stdout.on("data", (d) => (s.log += d));
  s.child.stderr.on("data", (d) => (s.log += d));
  s.log = "";
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const post = (s, path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const landed = async (s, r) => {
  assert.equal(r.status, 303);
  return page(s, r.headers.get("location"));
};
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);
const rulesUrl = (v) => `/v/${v}/rules`;
const claimRule = async (v, path) => (await sql("select * from public.claim_rules where vault_id = $1 and path = $2", [v, path]))[0];

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'noa2@example.test'), ($2, 'edda2@example.test') on conflict (id) do nothing`, [NOA, EDDA]);
  noa = await start(NOA, "noa");
  edda = await start(EDDA, "edda");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Claim rules main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, NOA]);
});

after(async () => {
  noa?.child?.kill();
  edda?.child?.kill();
});

test("claim rules: an editor sees the list but no Add form and no Remove", async () => {
  await as(NOA, "select public.set_claim_rule($1, 'seen/', 60, 300)", [V.main]);
  const h = await page(edda, rulesUrl(V.main));
  assert.match(h, /Claim rules/);
  assert.match(h, /seen\//);
  assert.doesNotMatch(h, /id="add-claim-rule"/);
  assert.doesNotMatch(h, /Remove the claim rule/);
  await sql("delete from public.claim_rules where vault_id = $1 and path = 'seen/'", [V.main]);
});

test("claim rules: a preset submits its own numbers, with the typed path", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "a/", preset: "hackathon" }));
  assert.deepEqual(flashOf(h), ["success", "status", "Saved the claim rule on a/: 30 min lease, 2 h hold limit."]);
  const row = await claimRule(V.main, "a/");
  assert.equal(row.lease_minutes, 30);
  assert.equal(row.hold_limit_minutes, 120);
});

test("claim rules: manual fields are honoured over a preset's defaults when no preset is sent", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(
    noa,
    await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "b/", lease: "120", hold: "600", conn: "3", person: "7" }),
  );
  assert.deepEqual(flashOf(h), ["success", "status", "Saved the claim rule on b/: 2 h lease, 10 h hold limit."]);
  const row = await claimRule(V.main, "b/");
  assert.equal(row.lease_minutes, 120);
  assert.equal(row.hold_limit_minutes, 600);
  assert.equal(row.connection_cap, 3);
  assert.equal(row.person_cap, 7);
});

test("claim rules: a hold limit shorter than the lease is refused in the form, with a reference, and nothing saved", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "c/", lease: "120", hold: "60" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^The hold limit is a whole number of minutes, at least the lease\. Nothing was saved\. \(ref [0-9a-f]{8}\)$/);
  assert.match(noa.log, new RegExp(`failure ref=${/ref ([0-9a-f]{8})/.exec(text)[1]} `), "the ref is in the server log");
  assert.equal(await claimRule(V.main, "c/"), undefined);
});

test("claim rules: an empty path is refused in the form, and a bad path is refused by the database, same as a policy rule", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const empty = flashOf(await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "", lease: "60", hold: "60" })));
  assert.match(empty[2], /^A claim rule needs a path/);
  const bad = flashOf(await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "../x", lease: "60", hold: "60" })));
  assert.match(bad[2], /has a \.\. segment/);
  assert.equal(await claimRule(V.main, "../x"), undefined);
});

test("claim rules: an editor can't: the database refuses a crafted form, and nothing changes", async () => {
  const token = csrfOf(await page(edda, rulesUrl(V.main)));
  const h = await landed(edda, await post(edda, `/v/${V.main}/rules/claims`, { csrf: token, path: "d/", lease: "60", hold: "60" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^Only owners set claim rules/);
  assert.equal(await claimRule(V.main, "d/"), undefined);
});

test("claim rules: removing one succeeds, says so, and it's gone from the table", async () => {
  const h = await page(noa, rulesUrl(V.main));
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes('value="a/"') && f.includes('value="remove"'));
  assert.ok(form, "a/' s remove form");
  const token = /name="csrf" value="([0-9a-f]+)"/.exec(form)[1];
  const landed_ = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "a/", action: "remove" }));
  assert.deepEqual(flashOf(landed_), [
    "success",
    "status",
    "Removed the claim rule on a/. It now follows the next rule that applies, or the fixed defaults.",
  ]);
  assert.equal(await claimRule(V.main, "a/"), undefined);
  assert.doesNotMatch(landed_, /rule-path">a\//);
});

test("claim rules: removing a path that never had a rule changes nothing, and still says removed (the same no-op set_policy's own removal allows)", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "never-set/", action: "remove" }));
  assert.deepEqual(flashOf(h), [
    "success",
    "status",
    "Removed the claim rule on never-set/. It now follows the next rule that applies, or the fixed defaults.",
  ]);
  assert.equal(await claimRule(V.main, "never-set/"), undefined);
});
