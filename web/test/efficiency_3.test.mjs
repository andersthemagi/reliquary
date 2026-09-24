// Server load, third pass (docs/research/server-load.md): the env API's GET
// routes resolve the CLI token inside their transaction (src/db.ts,
// asCliToken, called directly with a pool that counts); the Review and Home
// lists take quorums from one rules_for_pairs() call; file forms take up to
// about 3 MB so 1 MiB of non-Latin text can be saved. Over HTTP as Ana, on
// this file's own vaults and paths. Seed: test/seed.sql.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { asCliToken, asPerson, usePool } from "../dist/db.js";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, LOGIN_FILE, TEST_DATABASE_URL } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
const V = `/v/${TEAM_VAULT}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const s256 = (s) => createHash("sha256").update(s).digest("base64url");

const pools = [];
function countingPool() {
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  const n = { checkouts: 0, roundTrips: 0 };
  const wrapped = new WeakSet();
  db.on("acquire", (client) => {
    n.checkouts++;
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = (...args) => {
      n.roundTrips++;
      return query(...args);
    };
  });
  pools.push(db);
  usePool(db);
  return { db, n };
}
after(() => Promise.all(pools.map((p) => p.end())));

let cookie = "";
before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
const page = async (path) => (await fetch(BASE + path, { headers: { cookie }, redirect: "manual" })).text();
const csrf = async (path) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];
const post = (path, fields) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });

// ---------------------------------------------------------------------------
// The env API's token, inside the route's transaction

const RESOURCE = "https://efficiency3.example/api/env";
const ACCESS = `rle_${"e3".repeat(32)}`;
before(async () => {
  // A CLI grant for Ana, as the authorization server makes one.
  const { db } = countingPool();
  const verifier = "v".repeat(43) + "-efficiency-3";
  const client = "https://efficiency3.example/cli/oauth-client.json";
  const redirect = "http://127.0.0.1:53682/callback";
  const code = await asPerson(ANA, async (c) =>
    (await c.query("select public.create_cli_grant($1, $2, $3, $4, null, false) as c", [client, redirect, RESOURCE, s256(verifier)])).rows[0].c,
  );
  await db.query("select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7)", [
    sha(code), client, redirect, RESOURCE, verifier, sha(ACCESS), sha(`${ACCESS}-refresh`),
  ]);
});

const whoAmI = async (c) =>
  (await c.query("select private.uid()::text as u, private.token_kind() as k, current_user as r")).rows[0];

test("cli token: a GET route's resolve and work share one checkout and one transaction", async () => {
  const { db, n } = countingPool();
  const out = await asCliToken(sha(ACCESS), RESOURCE, whoAmI);
  assert.equal(out.grant.userId, ANA);
  assert.deepEqual(out.result, { u: ANA, k: "cli", r: "authenticated" });
  // begin + resolve (one simple query), the work, commit. Before: a
  // resolve on its own checkout, then begin, claims, work, commit: two
  // checkouts, five round trips.
  assert.deepEqual(n, { checkouts: 1, roundTrips: 3 });
  assert.equal(db.idleCount, 1, "the connection is back in the pool");
});

test("cli token: an unknown token or another resource resolves to nobody and leaves nothing on the connection", async () => {
  const { db, n } = countingPool();
  assert.equal(await asCliToken(sha(`rle_${"0".repeat(64)}`), RESOURCE, whoAmI), null);
  assert.equal(await asCliToken(sha(ACCESS), "https://other.example/api/env", whoAmI), null);
  assert.equal(await asCliToken("not-a-hash", RESOURCE, whoAmI), null);
  assert.deepEqual(n, { checkouts: 2, roundTrips: 4 }, "begin + resolve, rollback, twice; a malformed hash never reaches the database");
  const r = (await db.query("select current_user as r, coalesce(current_setting('request.jwt.claims', true), '') as claims")).rows[0];
  assert.deepEqual(r, { r: "reliquary_web", claims: "" });
});

test("cli token: failed work rolls back and gives a clean connection back", async () => {
  const { db } = countingPool();
  await assert.rejects(asCliToken(sha(ACCESS), RESOURCE, (c) => c.query("select 1/0")), { code: "22012" });
  assert.equal(db.idleCount, 1);
  const r = (await db.query("select current_user as r")).rows[0];
  assert.equal(r.r, "reliquary_web");
});

// ---------------------------------------------------------------------------
// Review and Home: quorums from one call for the whole list. The vaults
// made here are deleted at the end of each test, so nothing is left
// waiting on Ana for other files' Review counts.

const dropVaults = (names) =>
  asPerson(ANA, async (c) => {
    for (const name of names) {
      const { rows } = await c.query("select id from public.vaults where name = $1", [name]);
      for (const r of rows) await c.query("select public.delete_vault($1, $2)", [r.id, name]);
    }
  });

test("waiting lists: Review and Home show each proposal's quorum from its own vault's rules, across vaults", async () => {
  countingPool();
  const ids = await asPerson(ANA, async (c) => {
    const mk = async (name) => (await c.query("select public.create_vault($1) as id", [name])).rows[0].id;
    const a = await mk("Quorum A");
    const b = await mk("Quorum B");
    await c.query("select public.set_policy($1, 'q/', 'canon', 2)", [a]);
    await c.query("select public.set_policy($1, 'q/special.md', 'canon', 3)", [a]);
    await c.query("select public.set_policy($1, 'q/', 'canon', 4)", [b]);
    for (const [v, path] of [[a, "q/one.md"], [a, "q/special.md"], [b, "q/one.md"], [b, "open.md"]]) {
      await c.query("select public.propose($1, $2, 'text', 'why')", [v, path]);
    }
    return { a, b };
  });
  const review = await page("/review");
  const row = (vault, path) => {
    const m = new RegExp(`href="/v/${vault}/proposals/[^"]+">Create ${path.replace(".", "\\.")}</a>[\\s\\S]*?(\\d+) of (\\d+)`).exec(review);
    assert.ok(m, `${path} is listed`);
    return `${m[1]} of ${m[2]}`;
  };
  assert.equal(row(ids.a, "q/one.md"), "0 of 2");
  assert.equal(row(ids.a, "q/special.md"), "0 of 3");
  assert.equal(row(ids.b, "q/one.md"), "0 of 4");
  assert.equal(row(ids.b, "open.md"), "0 of 1");
  const home = await page("/");
  assert.match(home, /0 of [1-4]/, "Home lists waiting proposals with quorums too");
  await dropVaults(["Quorum A", "Quorum B"]);
});

test("waiting lists: a proposal you sent back shows its quorum under changes requested", async () => {
  countingPool();
  const pid = await asPerson(ANA, async (c) => {
    const v = (await c.query("select public.create_vault('Quorum C') as id")).rows[0].id;
    await c.query("select public.set_policy($1, 'docs/', 'canon', 5)", [v]);
    const p = (await c.query("select public.propose($1, 'docs/r.md', 'text', 'why') as id", [v])).rows[0].id;
    await c.query("select public.decide($1, 'request_changes', 'fix it')", [p]);
    return p;
  });
  const review = await page("/review");
  const m = new RegExp(`/proposals/${pid}"[\\s\\S]*?(\\d+) of (\\d+)`).exec(review);
  assert.ok(m, "listed");
  assert.equal(`${m[1]} of ${m[2]}`, "0 of 5");
  await dropVaults(["Quorum C"]);
});

// ---------------------------------------------------------------------------
// File forms: 1 MiB of non-Latin text fits

test("file forms: 1 MiB of non-Latin text (about 3 MB as a form) is saved, not refused as too large", async () => {
  countingPool();
  const token = await csrf(`${V}/new`);
  const content = "あ".repeat(349_525); // 1,048,575 bytes of UTF-8; 3,145,725 characters percent-encoded
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/efficiency3-kana.md", content });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /\/file\?path=notes%2Fefficiency3-kana\.md$/);
  const stored = await asPerson(ANA, async (c) =>
    (await c.query(
      `select octet_length(fv.body) as n from public.files f join public.file_versions fv on fv.id = f.current_version_id
        where f.vault_id = $1 and f.path = 'notes/efficiency3-kana.md'`,
      [TEAM_VAULT],
    )).rows[0].n,
  );
  assert.equal(stored, 1_048_575);
});

test("file forms: text over 1 MiB in a file form is refused with the ceiling, not a 413", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/efficiency3-over.md", content: "é".repeat(524_289) });
  assert.equal(r.status, 303);
  assert.match(await page(r.headers.get("location")), /That’s too long \(text up to 1 MB/);
});

test("file forms: revise and edit-and-approve take the file-form ceiling too; anything over it is 413", async () => {
  const token = await csrf(`${V}/new`);
  const pid = "00000000-0000-0000-0000-000000000000";
  for (const action of ["revise", "edit"]) {
    const r = await post(`${V}/proposals/${pid}/${action}`, { csrf: token, content: "é".repeat(400_000) }); // 2.4 MB as a form
    assert.notEqual(r.status, 413, action);
  }
  const big = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/x.md", content: "x".repeat(3 * 1024 * 1024 + 64 * 1024 + 1) });
  assert.equal(big.status, 413);
  assert.match(await big.text(), /over 3 MB, so nothing was saved/);
});
