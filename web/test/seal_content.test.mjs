// Sealing stored content (src/seal-content.ts, run by scripts/seal-content.sh;
// the runbook's "Sealing content and rotating CONTENT_KEYS"): the backfill of
// plain rows and the reseal of a CONTENT_KEYS rotation, as the operator runs
// them. Who may call its functions is supabase/tests/seal_content_test.sql's.
//
// This file uses its own database ("sealing", made by web/test.sh): a run
// seals every body in its database. Every body holds BODYMARK-; no body, key
// or vault id may reach the run's output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/sealing`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/sealing`;
const QUINN = "00000000-0000-0000-0000-0000000000c1";
const C1 = randomBytes(32).toString("base64url");
const C2 = randomBytes(32).toString("base64url");

const texts = {}; // what each row holds, by label
const body = (label) => (texts[label] = `BODYMARK-${label}-${randomBytes(6).toString("hex")}`);
let content; // dist/content.js
let open = "";
let canon = "";

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

// As scripts/seal-content.sh runs it: the web app's DATABASE_URL and the
// operator's password (web/test.sh gives reliquary_ops the password "test").
function seal(env, args = []) {
  const r = spawnSync(process.execPath, ["dist/seal-content.js", ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: WEB_DB, OPS_DB_PASSWORD: "test", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const out = r.stdout + r.stderr;
  for (const s of [C1, C2, open, canon, ...Object.values(texts)]) assert.equal(out.includes(s), false, "a key, a body or a vault id is in the output");
  assert.doesNotMatch(out, /BODYMARK-/);
  return { status: r.status, out };
}

// Every stored body with its vault, opened with the keys configured now.
async function stored() {
  const rows = await sql(
    `select vault_id, body from public.file_versions union all select vault_id, body from public.proposals
     union all select vault_id, body from public.proposal_notes union all select vault_id, body from public.thread_messages`,
  );
  return rows.map((r) => ({ sealed: r.body[0] === 0, text: content.openBody(r.body, r.vault_id) }));
}
const vector = async () => {
  const [r] = await sql("select vault_id, embedding from public.file_embeddings");
  return { sealed: r.embedding[0] === 0, first: content.openBytes(r.embedding, r.vault_id).readFloatBE(0) };
};

before(async () => {
  content = await import("../dist/content.js");
  [{ id: open }] = await as(QUINN, "select public.create_vault('Open') as id");
  [{ id: canon }] = await as(QUINN, "select public.create_vault('Canon', 'canon') as id");
  // Written before writes sealed: plain bytes, through the text forms.
  const [{ v }] = await as(QUINN, "select public.write_file($1, 'a.md', $2) as v", [open, body("file")]);
  const [{ p }] = await as(QUINN, "select public.propose($1, 'c.md', convert_to($2, 'UTF8'), 'why') as p", [canon, body("proposal")]);
  await as(QUINN, "select public.comment_on_proposal($1, convert_to($2, 'UTF8'))", [p, body("note")]);
  await as(QUINN, "select public.open_thread($1, 'Topic', convert_to($2, 'UTF8'), $3, null, null, null, null)", [open, body("message"), texts.message.length]);
  const vec = Buffer.alloc(384 * 4);
  vec.writeFloatBE(0.5, 0);
  const [{ id: file }] = await sql("select id from public.files where vault_id = $1 and path = 'a.md'", [open]);
  await as(QUINN, "select private.store_embeddings($1, $2, $3::jsonb)", [file, v, JSON.stringify([{ chunk: 0, line: 1, embedding: vec.toString("base64") }])]);
  // And one written since, sealed under c1.
  content.configureContent({ CONTENT_KEYS: `c1:${C1}` });
  await as(QUINN, "select public.write_file($1, 'b.md', $2::bytea)", [open, content.sealBody(body("sealed"), open)]);
});

test("seal content: --check counts plain rows and rows by key id, changes nothing, and exits 1", async () => {
  const r = seal({ CONTENT_KEYS: `c1:${C1}` }, ["--check"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Stored now: plaintext: 1 search vectors, 1 file versions, 1 notes, 1 proposals, 1 thread messages; c1: 1 file versions\./);
  assert.match(r.out, /5 not yet on c1\./);
  assert.equal((await stored()).filter((s) => s.sealed).length, 1);
});

test("seal content: seals every plain row in every content table in place, prints counts only, and exits 0", async () => {
  const r = seal({ CONTENT_KEYS: `c1:${C1}` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Sealed 5 under c1\./);
  assert.match(r.out, /Stored now: c1: 1 search vectors, 2 file versions, 1 notes, 1 proposals, 1 thread messages\./);
  assert.match(r.out, /Everything is on c1\./);
  const rows = await stored();
  assert.equal(rows.every((s) => s.sealed), true);
  assert.deepEqual(rows.map((s) => s.text).sort(), Object.values(texts).sort());
  assert.deepEqual(await vector(), { sealed: true, first: 0.5 });
});

test("seal content: run again, it finds nothing left to seal", () => {
  const r = seal({ CONTENT_KEYS: `c1:${C1}` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Sealed 0 under c1\./);
});

test("seal content: without a key for a stored id it changes nothing and says which id to add", async () => {
  const r = seal({ CONTENT_KEYS: `c2:${C2}` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /No key for c1: add it to CONTENT_KEYS \(after the current key\) and run this again\./);
  assert.equal((await sql("select count(*)::int as n from private.content_key_ids() where key_id <> 'c1'"))[0].n, 0);
});

test("seal content: refuses to run with no keys or a malformed one, without printing it", () => {
  assert.equal(seal({}).status, 2);
  const r = seal({ CONTENT_KEYS: `c2:${C2.slice(1)}KEYMARK` });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.out, /KEYMARK/);
});

test("seal content: rotating CONTENT_KEYS moves every sealed row to the new key, which alone opens them after", async () => {
  const r = seal({ CONTENT_KEYS: `c2:${C2},c1:${C1}` });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Sealed 6 under c2\./);
  assert.match(r.out, /Everything is on c2\. Older keys can be dropped from CONTENT_KEYS\./);
  content.configureContent({ CONTENT_KEYS: `c2:${C2}` });
  assert.deepEqual((await stored()).map((s) => s.text).sort(), Object.values(texts).sort());
  assert.deepEqual(await vector(), { sealed: true, first: 0.5 });
  assert.equal(seal({ CONTENT_KEYS: `c2:${C2}` }, ["--check"]).status, 0);
});

test("seal content: a body that doesn't open stays as it is, and the run exits 1 telling to keep the old key", async () => {
  // Sealed for the canon vault, stored in the open one: it can't be opened there.
  content.configureContent({ CONTENT_KEYS: `c1:${C1}` });
  await as(QUINN, "select public.write_file($1, 'moved.md', $2::bytea)", [open, content.sealBody(body("moved"), canon)]);
  const r = seal({ CONTENT_KEYS: `c2:${C2},c1:${C1}` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Sealed 0 under c2; 1 could not be decrypted with their key and stay as they are\./);
  assert.match(r.out, /1 not yet on c2; keep c1 in CONTENT_KEYS; run this again\./);
});
