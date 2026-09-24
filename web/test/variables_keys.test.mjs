// Rotating VARIABLES_KEY (docs/variables.md, "Key rotation"; the runbook's
// "Rotating VARIABLES_KEY"): several keys by id in src/secrets.ts, the
// operator's re-encryption in src/rekey.ts, and the server's refusal to
// start without a key a stored value names.
//
// This file uses its own database ("keys", made by web/test.sh): a rotation
// moves every stored value, and the server checks every stored key id, so it
// can't share one with files that seal under keys of their own. Every value
// holds KEYVAL-; no value, key, name or vault id may reach the re-encryption's
// output or a server log.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/keys`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/keys`;
const QUINN = "00000000-0000-0000-0000-0000000000c1";
const K1 = randomBytes(32).toString("base64url");
const K2 = randomBytes(32).toString("base64url");
const KEYS = [K1, K2];

const secrets = []; // every value this file sets: none may reach an output
const value = (label) => {
  const v = `KEYVAL-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let crypto; // dist/secrets.js
let vars; // dist/variables.js
let vault = "";
let draft = "";
const vals = {};
const servers = [];

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

const keyIdOf = async (name, environment) =>
  (
    await sql(
      `select s.key_id from private.variable_secrets s join public.variables v on v.id = s.variable_id
        where v.vault_id = $1 and v.name = $2 and s.environment = $3`,
      [vault, name, environment],
    )
  )[0]?.key_id;
const storedKeyIds = async () =>
  (await sql(`select key_id, "values", imports from private.variable_key_ids()`)).map((r) => `${r.key_id}:${r.values}+${r.imports}`).join(",");

// The re-encryption, as scripts/rotate-variables-key.sh runs it: the web
// app's DATABASE_URL and the operator's password (web/test.sh gives
// reliquary_ops the password "test").
const OPS_PASSWORD = "test";
function rekey(env, args = []) {
  const r = spawnSync(process.execPath, ["dist/rekey.js", ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: WEB_DB, OPS_DB_PASSWORD: OPS_PASSWORD, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

// Nothing secret in an output: no key, value, variable name or vault id.
function clean(out) {
  for (const s of [...KEYS, ...secrets]) assert.equal(out.includes(s), false, "a key or value is in the output");
  assert.doesNotMatch(out, /KEYVAL-|API_KEY|DB_URL|PASTED/);
  assert.equal(out.includes(vault), false, "a vault id is in the output");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// Starts the web server on the keys database; resolves to its exit (code
// and output) if it stops, or to "up" once /healthz answers.
async function startServer(env) {
  const port = await freePort();
  let out = "";
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: QUINN,
      LOGIN_FILE: `/tmp/variables-keys-login-${process.pid}-${port}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: "",
      VARIABLES_KEY: "",
      VARIABLES_KEYS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ up: false, code })));
  for (let i = 0; i < 100; i++) {
    const r = await Promise.race([exited, fetch(`http://127.0.0.1:${port}/healthz`).then((x) => (x.ok ? { up: true } : null), () => null)]);
    if (r) return { ...r, out: () => out, child };
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("server neither started nor exited");
}

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  crypto = await import("../dist/secrets.js");
  vars = await import("../dist/variables.js");
  crypto.configureVariables({ VARIABLES_KEY: K1 });
  [{ id: vault }] = await as(QUINN, "select public.create_vault('Keys Vault') as id");
  vals.dev = value("dev");
  vals.prod = value("prod");
  await vars.setVariable(QUINN, vault, "API_KEY", "development", vals.dev);
  await vars.setVariable(QUINN, vault, "API_KEY", "production", vals.prod);
  // A pasted .env waiting to be applied: its values are sealed too.
  vals.pasted = value("pasted");
  const r = await vars.createImport(QUINN, vault, ["preview"], [{ name: "PASTED", value: vals.pasted }], []);
  assert.equal(r.ok, true);
  draft = r.id;
});

after(async () => {
  for (const s of servers) s.kill();
  const { pool } = await import("../dist/db.js");
  await pool.end();
});

// ---------------------------------------------------------------------------
// Several keys

test("keys: VARIABLES_KEYS takes id:key pairs, the first seals; errors name the variable and an id, never a key", () => {
  assert.equal(crypto.configureVariables({ VARIABLES_KEYS: ` k2:${K2} ,\nk1:${K1}` }), true);
  assert.equal(crypto.currentKeyId(), "k2");
  assert.deepEqual(crypto.keyIds(), ["k2", "k1"]);
  const bad = [
    [`k2:${K2},k1:short`, /VARIABLES_KEYS \(key k1\) must be 32 random bytes/],
    [`${K2}`, /comma-separated id:key pairs/],
    [`bad id:${K2}`, /comma-separated id:key pairs/],
    [`k2:${K2},k2:${K1}`, /names key id k2 twice/],
    [`k2:${K2},k1:${K2}`, /keys k2 and k1 the same key/],
    [`k2:${K2},`, /comma-separated id:key pairs/],
  ];
  for (const [raw, want] of bad) {
    try {
      crypto.configureVariables({ VARIABLES_KEYS: raw });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.match(err.message, want);
      for (const k of KEYS) assert.equal(String(err.stack).includes(k), false);
    }
  }
  crypto.configureVariables({ VARIABLES_KEY: K1 });
});

test("keys: VARIABLES_KEY alone is key k1, as existing values were sealed; beside VARIABLES_KEYS it opens but doesn't seal, and may not contradict it", () => {
  crypto.configureVariables({ VARIABLES_KEY: K1 });
  assert.equal(crypto.currentKeyId(), "k1");
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2}`, VARIABLES_KEY: K1 });
  assert.equal(crypto.currentKeyId(), "k2");
  assert.deepEqual(crypto.keyIds(), ["k2", "k1"]);
  assert.throws(() => crypto.configureVariables({ VARIABLES_KEYS: `k1:${K2}`, VARIABLES_KEY: K1 }), /give key id k1 different keys/);
  assert.throws(() => crypto.configureVariables({ VARIABLES_KEYS: `k2:${K1}`, VARIABLES_KEY: K1 }), /also key k2/);
  crypto.configureVariables({ VARIABLES_KEY: K1 });
});

test("keys: after a new key is added, values under the old key still open, and new values are sealed with the new one", async () => {
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` });
  const r = await vars.revealVariable(QUINN, vault, "API_KEY", "development");
  assert.equal(r.ok && r.value, vals.dev);
  vals.db = value("db");
  await vars.setVariable(QUINN, vault, "DB_URL", "development", vals.db);
  assert.equal(await keyIdOf("DB_URL", "development"), "k2");
  assert.equal(await keyIdOf("API_KEY", "development"), "k1");
  const back = await vars.revealVariable(QUINN, vault, "DB_URL", "development");
  assert.equal(back.ok && back.value, vals.db);
});

test("keys: a value under a key id the server doesn't hold is refused, and the additional data binds the slot under every key", async () => {
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` });
  const slot = { vaultId: vault, environment: "development", name: "X" };
  const s = crypto.seal("v", slot);
  assert.equal(s.keyId, "k2");
  assert.throws(() => crypto.open({ ...s, keyId: "k7" }, slot), /X in development could not be decrypted/);
  assert.throws(() => crypto.open({ ...s, keyId: "k1" }, slot), crypto.SecretsError);
  for (const other of [{ ...slot, name: "Y" }, { ...slot, environment: "preview" }, { ...slot, vaultId: QUINN }]) {
    assert.throws(() => crypto.open(s, other), crypto.SecretsError);
  }
  crypto.configureVariables({ VARIABLES_KEY: K1 });
  const old = crypto.seal("v", slot);
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` });
  assert.equal(crypto.open(old, slot), "v");
  assert.throws(() => crypto.open(old, { ...slot, name: "Y" }), crypto.SecretsError);
});

test("keys: the server refuses to start while a stored value names a key it doesn't hold, naming the id, never a key", async () => {
  const s = await startServer({ VARIABLES_KEYS: `k2:${K2}` });
  assert.equal(s.up, false);
  assert.equal(s.code, 1);
  assert.match(s.out(), /Refusing to start: stored values are sealed with key id k1, which VARIABLES_KEYS doesn't hold/);
  for (const k of KEYS) assert.equal(s.out().includes(k), false);
});

// ---------------------------------------------------------------------------
// The operator's re-encryption

test("rekey: --check reports the key ids in use, changes nothing, and exits 1 while anything is on an older key", async () => {
  const before = await storedKeyIds();
  const r = rekey({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` }, ["--check"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Current key: k2\. Stored now: k1: 2 values, 1 pending import value; k2: 1 value, 0 pending import values\./);
  assert.match(r.out, /3 still on another key: keep k1 in VARIABLES_KEYS\./);
  clean(r.out);
  assert.equal(await storedKeyIds(), before);
});

test("rekey: without a key for a stored id it changes nothing and says which id to add", async () => {
  const r = rekey({ VARIABLES_KEYS: `k2:${K2}` });
  assert.equal(r.status, 1);
  assert.match(r.out, /No key for k1: add it to VARIABLES_KEYS/);
  clean(r.out);
  assert.equal(await storedKeyIds(), "k1:2+1,k2:1+0");
});

test("rekey: refuses to run with no keys or a malformed one, without printing it", () => {
  assert.equal(rekey({}).status, 2);
  const r = rekey({ VARIABLES_KEYS: `k2:${K2.slice(1)}KEYMARK` });
  assert.equal(r.status, 2);
  assert.match(r.out, /VARIABLES_KEYS \(key k2\) must be 32 random bytes/);
  assert.equal(r.out.includes("KEYMARK"), false);
});

test("rekey: logs in as reliquary_ops, built from the web app's DATABASE_URL and OPS_DB_PASSWORD, keeping the pooler's project suffix", async () => {
  const { opsDatabaseUrl } = await import("../dist/rekey.js");
  assert.equal(
    opsDatabaseUrl("postgres://reliquary_web.abcref:WEBPASS@pooler.example:6543/postgres", "OPSPASS-_1"),
    "postgres://reliquary_ops.abcref:OPSPASS-_1@pooler.example:6543/postgres",
  );
  assert.equal(opsDatabaseUrl("postgres://reliquary_web:WEBPASS@127.0.0.1:5432/keys", "p/w@x"), "postgres://reliquary_ops:p%2Fw%40x@127.0.0.1:5432/keys");
  assert.equal(opsDatabaseUrl("postgres://reliquary_ops:OPSPASS@127.0.0.1:5432/keys", undefined), "postgres://reliquary_ops:OPSPASS@127.0.0.1:5432/keys");
  for (const [url, pw, want] of [
    ["postgres://reliquary_web:WEBPASS@127.0.0.1/keys", undefined, /No OPS_DB_PASSWORD/],
    ["postgres://postgres:WEBPASS@127.0.0.1/keys", "x", /reliquary_web\) or the operator's/],
    ["not a url WEBPASS", "x", /isn't a postgres:\/\/ URL/],
    [undefined, "x", /isn't a postgres:\/\/ URL/],
  ]) {
    assert.throws(() => opsDatabaseUrl(url, pw), (err) => want.test(err.message) && !err.message.includes("WEBPASS"));
  }
});

// (Postgres here trusts local connections, so a wrong password can't be
// shown failing; opsDatabaseUrl above shows which password is used.)
test("rekey: without the operator's password, or with another role's DATABASE_URL, it changes nothing and prints no connection string", async () => {
  const before = await storedKeyIds();
  const none = rekey({ VARIABLES_KEYS: `k2:${K2},k1:${K1}`, OPS_DB_PASSWORD: "" });
  assert.equal(none.status, 2);
  assert.match(none.out, /No OPS_DB_PASSWORD: the re-encryption logs in as reliquary_ops/);
  const other = rekey({ VARIABLES_KEYS: `k2:${K2},k1:${K1}`, DATABASE_URL: WEB_DB.replace("reliquary_web", "postgres") });
  assert.equal(other.status, 2);
  assert.match(other.out, /DATABASE_URL must be the web app's \(reliquary_web\) or the operator's \(reliquary_ops\)/);
  for (const out of [none.out, other.out]) {
    assert.doesNotMatch(out, /postgres:\/\/|:test@/);
    clean(out);
  }
  assert.equal(await storedKeyIds(), before);
});

test("rekey: the web app's own role is refused the operator's functions (42501), so it can't run the re-encryption", async () => {
  const web = new pg.Client({ connectionString: WEB_DB });
  await web.connect();
  try {
    for (const q of [
      `select * from private.variable_key_ids()`,
      `select * from private.rekey_vaults('k2')`,
      `select * from private.sealed_rows('${vault}')`,
      `select private.reseal('${vault}', 'rotate_key', '[]')`,
    ]) {
      await assert.rejects(web.query(q), (err) => err.code === "42501");
    }
    // What it keeps: the key ids stored values name, for its start-up check.
    assert.deepEqual((await web.query("select k from private.stored_key_ids() k order by 1")).rows.map((r) => r.k), ["k1", "k2"]);
  } finally {
    await web.end();
  }
});

test("rekey: moves every value and pending import value to the current key, prints counts only, and exits 0", async () => {
  const versions = await sql(
    `select v.name, vv.environment, vv.version, vv.updated_by, vv.updated_at from public.variable_values vv
       join public.variables v on v.id = vv.variable_id where v.vault_id = $1 order by 1, 2`,
    [vault],
  );
  const feed = (await sql("select count(*)::int as n from public.log where vault_id = $1", [vault]))[0].n;
  const r = rekey({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Re-encrypted 3 in 1 vault\./);
  assert.match(r.out, /Stored now: k2: 3 values, 1 pending import value\./);
  assert.match(r.out, /Everything is on k2\. Older keys can be dropped from VARIABLES_KEYS\./);
  clean(r.out);
  assert.equal(await storedKeyIds(), "k2:3+1");
  assert.deepEqual(
    await sql(
      `select v.name, vv.environment, vv.version, vv.updated_by, vv.updated_at from public.variable_values vv
         join public.variables v on v.id = vv.variable_id where v.vault_id = $1 order by 1, 2`,
      [vault],
    ),
    versions,
  );
  assert.equal((await sql("select count(*)::int as n from public.log where vault_id = $1", [vault]))[0].n, feed);
  const [row] = await sql("select actor, agent, names, detail from public.env_access_log where vault_id = $1 and action = 'rotate_key'", [vault]);
  assert.deepEqual(
    { actor: row.actor, agent: row.agent, names: row.names, detail: row.detail },
    { actor: null, agent: "Reliquary operator", names: ["API_KEY", "PASTED"], detail: { key_ids: ["k2"], values: 2, imports: 1 } },
  );
});

test("rekey: after it, the new key alone opens every value and applies the pending import", async () => {
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2}` });
  for (const [environment, want] of [["development", vals.dev], ["production", vals.prod]]) {
    const r = await vars.revealVariable(QUINN, vault, "API_KEY", environment);
    assert.equal(r.ok && r.value, want);
  }
  assert.equal((await vars.applyImport(QUINN, draft)).ok, true);
  const p = await vars.revealVariable(QUINN, vault, "PASTED", "preview");
  assert.equal(p.ok && p.value, vals.pasted);
  crypto.configureVariables({ VARIABLES_KEY: K1 });
});

test("keys: with the old key dropped, the server starts once nothing names it", async () => {
  const s = await startServer({ VARIABLES_KEYS: `k2:${K2}` });
  assert.equal(s.up, true, s.out());
  for (const k of KEYS) assert.equal(s.out().includes(k), false);
  s.child.kill();
});

test("rekey: a value that doesn't open with its key stays where it is, and the run exits 1 telling to keep the old key", async () => {
  // Two values under k1, then one's ciphertext moved onto the other: its
  // additional data no longer matches, so it can't be opened.
  crypto.configureVariables({ VARIABLES_KEYS: `k1:${K1}` });
  await vars.setVariable(QUINN, vault, "MOVED_A", "development", value("moved-a"));
  await vars.setVariable(QUINN, vault, "MOVED_B", "development", value("moved-b"));
  await sql(
    `update private.variable_secrets s set nonce = o.nonce, ciphertext = o.ciphertext
       from private.variable_secrets o, public.variables va, public.variables vb
      where va.vault_id = $1 and va.name = 'MOVED_A' and vb.vault_id = $1 and vb.name = 'MOVED_B'
        and s.variable_id = va.id and o.variable_id = vb.id and s.environment = 'development' and o.environment = 'development'`,
    [vault],
  );
  const r = rekey({ VARIABLES_KEYS: `k2:${K2},k1:${K1}` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Re-encrypted 1 in 1 vault; 1 could not be decrypted with their key and stay as they are\./);
  assert.match(r.out, /1 still on another key: keep k1 in VARIABLES_KEYS and run this again\./);
  clean(r.out);
  assert.equal(await keyIdOf("MOVED_A", "development"), "k1");
  assert.equal(await keyIdOf("MOVED_B", "development"), "k2");
  await vars.deleteVariable(QUINN, vault, "MOVED_A", "development");
  assert.equal(await storedKeyIds(), "k2:5+0");
  crypto.configureVariables({ VARIABLES_KEY: K1 });
});

// ---------------------------------------------------------------------------
// Values

test("values: a NUL character is refused before anything is stored", async () => {
  crypto.configureVariables({ VARIABLES_KEYS: `k2:${K2}` });
  await assert.rejects(vars.setVariable(QUINN, vault, "NUL_VALUE", "development", "a\u0000b"), /NUL character/);
  assert.equal(await keyIdOf("NUL_VALUE", "development"), undefined);
  crypto.configureVariables({ VARIABLES_KEY: K1 });
});
