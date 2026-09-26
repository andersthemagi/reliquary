// Plans and limits in the web UI (src/plans.ts; the rules are in
// supabase/tests/plans_test.sql), driven over HTTP.
//
// This file starts its own servers from dist/ (local sign-in), signed in as
// Pia and as Quinn, people no other test file uses. Pia is on a plan of this
// file's own, "Web small" (2 vaults, 2 people and 400 bytes a vault), so the
// suite's roomy Free (test_support.roomy_free) never matters here. Pia owns
// "Plans One", where Quinn edits: its 2 places are full.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const PIA = "00000000-0000-0000-0000-0000000009a1";
const QUINN = "00000000-0000-0000-0000-0000000009a2";
const KEY = randomBytes(32).toString("base64url");

const servers = [];
const S = {}; // person -> { origin, cookie }
const V = {};
let log = "";

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

async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) {
      await db.query(`set local role ${who.role}`);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function startAs(user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/plans-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1",
      PORT: String(port), PUBLIC_URL: "", VARIABLES_KEY: KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  return { origin, cookie: r.headers.get("set-cookie").split(";")[0] };
}

const get = (who, path) => fetch(S[who].origin + path, { headers: { cookie: S[who].cookie }, redirect: "manual" });
const page = async (who, path) => (await get(who, path)).text();
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/"))[1];
const post = async (who, path, fields) => {
  const body = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  body.append("csrf", await csrfOf(who));
  return fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: body.toString(),
  });
};
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  return unescape(/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "");
};
const alertOf = (h) => unescape(/<p class="callout danger" role="alert">([^<]*)<\/p>/.exec(h)?.[1] ?? "");
const bytes = async (vault) => Number((await sql("select bytes from private.vault_storage where vault_id = $1", [vault]))[0].bytes);

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'pia@example.test'), ($2, 'quinn@example.test') on conflict (id) do nothing`,
    [PIA, QUINN],
  );
  await sql(`insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes)
             values ('web_small', 'Web small', 2, 2, 400) on conflict (id) do nothing`);
  await sql("select private.set_account_plan($1, 'web_small')", [PIA]);
  [{ id: V.one }] = await as({ user: PIA }, "select public.create_vault('Plans One') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.one, QUINN, PIA]);
  S.pia = await startAs(PIA);
  S.quinn = await startAs(QUINN);
});

after(() => {
  for (const child of servers) child.kill();
});

// ---------------------------------------------------------------------------
// Usage where people look for it

test("plans: Home shows the plan and the vaults owned, linking to Plan and usage", async () => {
  assert.match(await page("pia", "/"), /<p class="small muted plan-line"><a href="\/account">Web small plan · 1 of 2 vaults<\/a><\/p>/);
});

test("plans: the Account menu links Plan and usage", async () => {
  assert.match(await page("quinn", "/"), /<li><a href="\/account">Plan and usage<\/a><\/li>/);
});

test("plans: Plan and usage shows the plan and each vault the person created, with its people and storage", async () => {
  const r = await get("pia", "/account");
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Plan and usage<\/h1>/);
  assert.match(h, /Web small plan · 1 of 2 vaults/);
  assert.match(h, new RegExp(`<a class="name" href="/v/${V.one}">Plans One</a>\\s*<span class="muted small"> · Standard \\(Web small\\) · 2 of 2 people · 0 bytes of 400 bytes</span> <span class="badge attention">At a limit</span>`));
  // Quinn created nothing: a vault he only belongs to isn't his.
  const q = await page("quinn", "/account");
  // The page itself: the top bar's vault switcher lists the vaults he is in.
  assert.doesNotMatch(/<main id="main">[\s\S]*<\/main>/.exec(q)[0], /Plans One/);
  assert.match(q, /You haven’t created a vault yet\./);
});

test("plans: Settings shows every member the vault's tier, people and storage; owners also see invites waiting", async () => {
  const h = await page("pia", `/v/${V.one}/config`);
  assert.match(h, /<h2>Plan and usage<\/h2>\s*<p class="usage-line">Standard \(Web small\) · 2 of 2 people · 0 bytes of 400 bytes<\/p>/);
  assert.match(h, /This vault is at a limit\.[\s\S]*to invite someone, revoke an invite or remove a member first/);
  assert.match(h, /Standard vaults take their limits from the Web small plan of the account that created them\./);
  const q = await page("quinn", `/v/${V.one}/config`);
  assert.match(q, /<p class="usage-line">Standard \(Web small\) · 2 of 2 people · 0 bytes of 400 bytes<\/p>/);
});

// ---------------------------------------------------------------------------
// Limits, refused where they happen

test("limits: an invite past the vault's people limit is refused with the database's reason, and nothing is stored", async () => {
  const r = await post("pia", `/v/${V.one}/config/members/invite`, { email: "someone@example.test", role: "viewer" });
  assert.match(await flashAfter("pia", r),
    /^Plans One is at its 2-person limit on the Web small plan \(2 members and 0 invites waiting\): revoke an invite or remove someone first\. \(ref [0-9a-f]{8}\)$/);
  const [{ n }] = await sql("select count(*)::int as n from private.vault_invites where vault_id = $1", [V.one]);
  assert.equal(n, 0);
});

test("limits: a save that fits is counted; one past the storage limit is refused with the reason, and nothing is saved", async () => {
  assert.equal((await post("pia", `/v/${V.one}/file`, { action: "create", path: "notes/a.md", content: "a".repeat(300) })).status, 303);
  assert.equal(await bytes(V.one), 300);
  const r = await post("pia", `/v/${V.one}/file`, { action: "create", path: "notes/b.md", content: "b".repeat(200) });
  assert.match(await flashAfter("pia", r),
    /^Plans One has 300 bytes of its 400 bytes storage limit on the Web small plan, and this needs 200 bytes more\. Erase files you no longer need \(deleting a file keeps its history\) or delete variables, then try again\. \(ref [0-9a-f]{8}\)$/);
  const [{ n }] = await sql("select count(*)::int as n from public.files where vault_id = $1 and path = 'notes/b.md'", [V.one]);
  assert.equal(n, 0);
  assert.match(await page("pia", `/v/${V.one}/config`), /Standard \(Web small\) · 2 of 2 people · 300 bytes of 400 bytes/);
});

test("limits: setting a variable past the storage limit is refused on the form with the reason, and nothing is set", async () => {
  const r = await post("pia", `/v/${V.one}/variables/set`, { name: "BIG_KEY", environment: "development", value: "v".repeat(100) });
  assert.equal(r.status, 400);
  assert.match(alertOf(await r.text()), /^Plans One has 300 bytes of its 400 bytes storage limit on the Web small plan, and this needs 116 bytes more\./);
  const [{ n }] = await sql("select count(*)::int as n from public.variables where vault_id = $1", [V.one]);
  assert.equal(n, 0);
});

test("limits: a pasted .env past the storage limit is refused on the form with the reason, and nothing is kept", async () => {
  const r = await post("pia", `/v/${V.one}/variables/import`, [["dotenv", `BIG=${"x".repeat(150)}`], ["environment", "development"]]);
  assert.equal(r.status, 400);
  assert.match(alertOf(await r.text()), /^Plans One has 300 bytes of its 400 bytes storage limit on the Web small plan, and this needs 166 bytes more\./);
  const [{ n }] = await sql("select count(*)::int as n from public.env_imports where vault_id = $1", [V.one]);
  assert.equal(n, 0);
});

test("limits: an import can't be applied in a vault already over its storage limit; the page says why and nothing is set", async () => {
  const r = await post("pia", `/v/${V.one}/variables/import`, [["dotenv", "SMALL=tiny"], ["environment", "development"]]);
  assert.equal(r.status, 303);
  const location = r.headers.get("location");
  assert.equal(await bytes(V.one), 320);
  await sql("update private.plans set max_storage_bytes = 310 where id = 'web_small'");
  try {
    const flash = await flashAfter("pia", await post("pia", `${location}/apply`, {}));
    assert.match(flash, /^Plans One has \d+ bytes of its 310 bytes storage limit on the Web small plan, and this needs \d+ bytes more\..* \(ref [0-9a-f]{8}\)$/);
    const [{ status }] = await sql("select status from public.env_imports where vault_id = $1", [V.one]);
    assert.equal(status, "pending");
    assert.equal(await bytes(V.one), 320);
  } finally {
    await sql("update private.plans set max_storage_bytes = 400 where id = 'web_small'");
  }
});

test("limits: a push to the env API past the storage limit answers 507 storage_limit with the reason, and nothing is kept", async () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const origin = S.pia.origin;
  const resource = `${origin}/api/env`;
  const client = `${origin}/cli/oauth-client.json`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await as({ user: PIA }, "select public.create_cli_grant($1, $2, $3, $4, null, true) as code", [client, redirect, resource, challenge]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  const [{ r: redeemed }] = await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(`${access}-r`),
  ]);
  assert.equal(redeemed, "ok");
  const before = await sql("select count(*)::int as n from public.env_imports where vault_id = $1", [V.one]);
  const r = await fetch(`${resource}/${V.one}/development/imports`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ variables: { PUSHED: "p".repeat(200) }, refused: [] }),
  });
  assert.equal(r.status, 507);
  const body = await r.json();
  assert.equal(body.error, "storage_limit");
  assert.match(body.message, /Plans One has \d+ bytes of its 400 bytes storage limit on the Web small plan, and this needs 216 bytes more\./);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(body) + log, /p{200}/, "the value is never echoed");
  const after = await sql("select count(*)::int as n from public.env_imports where vault_id = $1", [V.one]);
  assert.equal(after[0].n, before[0].n);
});

test("limits: New vault says when the plan is full, and creating one is refused with the database's reason", async () => {
  const form = await page("pia", "/vaults/new");
  assert.match(form, /Web small plan · 1 of 2 vaults\. <a href="\/account">Plan and usage<\/a>/);
  assert.equal((await post("pia", "/vaults/new", { name: "Plans Two", default_policy: "open" })).status, 303);
  const full = await page("pia", "/vaults/new");
  assert.match(full, /You own 2 of the 2 vaults the Web small plan allows, so a new one can’t be created\./);
  const flash = await flashAfter("pia", await post("pia", "/vaults/new", { name: "Plans Three", default_policy: "open" }));
  assert.match(flash, /^You're at your 2-vault limit on the Web small plan \(you own 2\): delete a vault you no longer need, or ask for a bigger plan\. \(ref [0-9a-f]{8}\)$/);
  const [{ n }] = await sql("select count(*)::int as n from public.vaults where created_by = $1", [PIA]);
  assert.equal(n, 2);
  assert.match(await page("pia", "/account"), /You own 2 vaults, and the Web small plan allows 2/);
});
