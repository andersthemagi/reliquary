// Claim rules in the web app (src/claimrulespage.ts, /v/:id/rules/claims):
// the page an owner uses to set how long claims last for the whole vault or
// by path, and that an editor can't use; plus the Rules page's summary of it. The database's own predicates (resolution,
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
const rulesUrl = (v) => `/v/${v}/rules/claims`;
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

test("claim rules: an editor sees the list but no form, no Set, no Change and no Remove", async () => {
  await as(NOA, "select public.set_claim_rule($1, 'seen/', 60, 300)", [V.main]);
  const h = await page(edda, rulesUrl(V.main));
  assert.match(h, /Claim rules/);
  assert.match(h, /seen\//);
  assert.match(h, /Whole vault/);
  assert.doesNotMatch(h, /id="set-claim-rule"/);
  assert.doesNotMatch(h, /Remove the claim rule|Change the claim rule|Set a claim rule for the whole vault/);
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

// A refused save is the page again (400), the refusal and its reference in the
// form, what was typed kept, the refused field marked, and nothing stored.
const refused = async (s, fields) => {
  const token = csrfOf(await page(s, rulesUrl(V.main)));
  const r = await post(s, `/v/${V.main}/rules/claims`, { csrf: token, ...fields });
  assert.equal(r.status, 400);
  const h = await r.text();
  const text = /<p class="callout danger" role="alert" id="claim-error">([\s\S]*?)<\/p>/.exec(h)?.[1];
  assert.ok(text, "the refusal is shown in the form");
  assert.match(text, / \(ref [0-9a-f]{8}\)$/);
  assert.match(s.log, new RegExp(`failure ref=${/ref ([0-9a-f]{8})/.exec(text)[1]} `), "the ref is in the server log");
  return { h, text };
};

test("claim rules: a hold limit shorter than the lease is refused in the form, with a reference, what was typed kept, and nothing saved", async () => {
  const { h, text } = await refused(noa, { path: "c/", lease: "120", hold: "60" });
  assert.match(text, /^The hold limit has to be at least as long as the lease \(2 h\) and at most 365 days\. Nothing was saved\./);
  assert.match(h, /name="path"[^>]*value="c\/"/);
  assert.match(h, /name="lease"[^>]*value="120"/);
  assert.match(h, /name="hold"[^>]*value="60"[^>]*aria-invalid="true"/);
  assert.equal(await claimRule(V.main, "c/"), undefined);
});

test("claim rules: a lease or hold limit over a year, or under a minute, is refused in the form", async () => {
  const long = await refused(noa, { path: "c/", lease: "400", lease_unit: "days", hold: "400", hold_unit: "days" });
  assert.match(long.text, /^The lease is a whole number of minutes, hours or days: at least 1 minute and at most 365 days\./);
  const none = await refused(noa, { path: "c/", lease: "0", hold: "5" });
  assert.match(none.text, /^The lease is a whole number/);
  assert.equal(await claimRule(V.main, "c/"), undefined);
});

test("claim rules: the numbers can be typed in minutes, hours or days", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(
    noa,
    await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "u/", lease: "2", lease_unit: "hours", hold: "3", hold_unit: "days" }),
  );
  assert.deepEqual(flashOf(h), ["success", "status", "Saved the claim rule on u/: 2 h lease, 3 days hold limit."]);
  const row = await claimRule(V.main, "u/");
  assert.equal(row.lease_minutes, 120);
  assert.equal(row.hold_limit_minutes, 4320);
});

test("claim rules: a time that isn't a whole number of hours or days is shown exactly, not rounded", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "odd/", lease: "150", hold: "200" }));
  assert.deepEqual(flashOf(h), ["success", "status", "Saved the claim rule on odd/: 150 min lease, 200 min hold limit."]);
  assert.match(h, /rule-path">odd\/<[\s\S]*?<td data-label="Lease">150 min<\/td>\s*<td data-label="Hold limit">200 min<\/td>/);
});

test("claim rules: the whole vault is the first row, with the fixed defaults and Set until a rule is saved", async () => {
  const [{ id }] = await as(NOA, "select public.create_vault('Claim rules whole', 'open') as id");
  const h = await page(noa, rulesUrl(id));
  assert.match(h, /<strong>Whole vault<\/strong>[\s\S]*?fixed default[\s\S]*?<td data-label="Lease">2 days<\/td>\s*<td data-label="Hold limit">7 days<\/td>\s*<td data-label="Claims at once" class="small">1 per connection, 5 per person<\/td>/);
  assert.match(h, /aria-label="Set a claim rule for the whole vault"/);
  assert.doesNotMatch(h, /Remove the claim rule on the whole vault/);
});

test("claim rules: a preset with The whole vault chosen sets the whole vault in one step, and the table's first row shows it", async () => {
  const token = csrfOf(await page(noa, rulesUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, scope: "vault", path: "", preset: "hackathon" }));
  assert.deepEqual(flashOf(h), ["success", "status", "Saved the claim rule on the whole vault: 30 min lease, 2 h hold limit."]);
  const row = await claimRule(V.main, "");
  assert.equal(row.lease_minutes, 30);
  assert.equal(row.hold_limit_minutes, 120);
  assert.match(h, /<strong>Whole vault<\/strong>[\s\S]*?set by[\s\S]*?<td data-label="Lease">30 min<\/td>\s*<td data-label="Hold limit">2 h<\/td>/);
  assert.match(h, /aria-label="Remove the claim rule on the whole vault"/);
});

test("claim rules: The whole vault with a path typed is refused, rather than guessing which was meant", async () => {
  const { h, text } = await refused(noa, { scope: "vault", path: "clients/", lease: "30", hold: "120" });
  assert.match(text, /^You chose The whole vault but also typed clients\/\./);
  assert.match(h, /name="path"[^>]*value="clients\/"[^>]*aria-invalid="true"/);
  assert.equal(await claimRule(V.main, "clients/"), undefined);
});

test("claim rules: Change opens the form filled with the rule, in the largest whole unit; the whole vault's own link has an empty claim", async () => {
  const h = await page(noa, `${rulesUrl(V.main)}?claim=u%2F`);
  assert.match(h, /Change the claim rule on u\//);
  assert.match(h, /name="scope" value="path" checked/);
  assert.match(h, /name="path"[^>]*value="u\/"/);
  assert.match(h, /name="lease"[^>]*value="2"/);
  assert.match(h, /<option value="hours" selected>hours<\/option>/);
  assert.match(h, /name="hold"[^>]*value="3"/);
  assert.match(h, /<option value="days" selected>days<\/option>/);
  assert.ok(h.indexOf('id="set-claim-rule"') < h.indexOf("<table"), "the form comes first");
  assert.match(h, /href="\/v\/[0-9a-f-]+\/rules\/claims\?claim=#set-claim-rule" aria-label="Change the claim rule on the whole vault"/);
  const whole = await page(noa, `${rulesUrl(V.main)}?claim=`);
  assert.match(whole, /Change the claim rule on the whole vault/);
  assert.match(whole, /name="scope" value="vault" checked/);
  assert.match(whole, /name="lease"[^>]*value="30"/);
});

test("claim rules: Set on the fixed-default row fills the form with the numbers that apply now", async () => {
  const [{ id }] = await as(NOA, "select public.create_vault('Claim rules fixed', 'open') as id");
  const h = await page(noa, `${rulesUrl(id)}?claim=`);
  assert.match(h, /Set a claim rule for the whole vault/);
  assert.match(h, /name="lease"[^>]*value="2"/);
  assert.match(h, /<option value="days" selected>days<\/option>/);
});

test("claim rules: the Rules page says what the whole vault gets and links to the page; Claims links to it too", async () => {
  const rules = await page(noa, `/v/${V.main}/rules`);
  assert.match(rules, /Every path leases for 30 min, with a 2 h hold limit/);
  assert.match(rules, new RegExp(`href="/v/${V.main}/rules/claims">Claim rules</a>`));
  assert.doesNotMatch(rules, /id="add-claim-rule"|id="set-claim-rule"/);
  const claims = await page(noa, `/v/${V.main}/claims`);
  assert.match(claims, new RegExp(`href="/v/${V.main}/rules/claims">Claim rules</a>`));
});

test("claim rules: a folder or file with no path is refused in the form, and a bad path is refused by the database, same as a policy rule", async () => {
  const empty = await refused(noa, { path: "", lease: "60", hold: "60" });
  assert.match(empty.text, /^A rule for a folder or file needs its path/);
  const bad = await refused(noa, { path: "../x", lease: "60", hold: "60" });
  assert.match(bad.text, /has a \.\. segment/);
  assert.match(bad.h, /name="path"[^>]*value="\.\.\/x"/);
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

test("claim rules: removing the whole-vault rule says so and puts the fixed default row back", async () => {
  const h = await page(noa, rulesUrl(V.main));
  const form = h
    .split("<form ")
    .slice(1)
    .map((f) => f.slice(0, f.indexOf("</form>")))
    .find((f) => f.includes('value="remove"') && f.includes('name="path" value=""'));
  assert.ok(form, "the whole vault's remove form");
  const token = /name="csrf" value="([0-9a-f]+)"/.exec(form)[1];
  const after = await landed(noa, await post(noa, `/v/${V.main}/rules/claims`, { csrf: token, path: "", action: "remove" }));
  assert.deepEqual(flashOf(after), ["success", "status", "Removed the whole-vault claim rule. Paths with no rule of their own go back to the fixed defaults."]);
  assert.equal(await claimRule(V.main, ""), undefined);
  assert.match(after, /fixed default[\s\S]*?<td data-label="Lease">2 days<\/td>/);
});
