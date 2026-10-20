// Every write seals (src/content.ts storeBody; #462, part of #238): what the
// web app writes through its forms is ciphertext in the database, opens
// under the vault's id with the servers' key, and reads back through the
// pages as the text that was typed. The row-level rules are the SQL
// suite's; this is the wiring. Its own person and vault (start-as.mjs).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { isSealed, openBody } from "./open-row.mjs";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const SASHA = "95500000-0000-0000-0000-000000000955";
let S;
let V;

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
const page = async (path) => (await fetch(S.url + path, { headers: { cookie: S.cookie } })).text();
async function post(path, fields) {
  const h = await page(path);
  const token = /name="csrf" value="([^"]+)"/.exec(h)?.[1] ?? "";
  const body = new URLSearchParams({ csrf: token, ...fields });
  return fetch(S.url + path, { method: "POST", headers: { cookie: S.cookie, "content-type": "application/x-www-form-urlencoded", origin: S.url }, body, redirect: "manual" });
}

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'sasha@example.test') on conflict (id) do nothing`, [SASHA]);
  [{ id: V }] = await as(SASHA, "select public.create_vault('Sealed') as id");
  await as(SASHA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V]);
  S = await startAs(SASHA);
});
after(() => S.stop());

test("sealed: a file written in the editor is ciphertext in its row, opens under the vault's id, and reads back on its page", async () => {
  const r = await post(`/v/${V}/file`, { action: "create", path: "notes/sealed.md", content: "Sealed text, typed in the editor.", reason: "" });
  assert.equal(r.status, 303, await r.text());
  const [row] = await sql("select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = 'notes/sealed.md'", [V]);
  assert.ok(isSealed(row.body), "the row is sealed");
  assert.doesNotMatch(row.body.toString("latin1"), /typed in the editor/);
  assert.equal(openBody(row.body, V), "Sealed text, typed in the editor.");
  assert.throws(() => openBody(row.body, "00000000-0000-0000-0000-000000000000"), /could not be decrypted/);
  assert.match(await page(`/v/${V}/file?path=notes%2Fsealed.md`), /Sealed text, typed in the editor\./);
});

test("sealed: a proposal, its note and an approval's version are ciphertext, and the proposal page shows the text", async () => {
  const r = await post(`/v/${V}/file`, { action: "create", path: "canon/terms.md", content: "Proposed terms.", reason: "Because" });
  assert.equal(r.status, 303, await r.text());
  const [p] = await sql("select id, body from public.proposals where vault_id = $1 and path = 'canon/terms.md'", [V]);
  assert.ok(isSealed(p.body));
  assert.equal(openBody(p.body, V), "Proposed terms.");
  const c = await post(`/v/${V}/proposals/${p.id}/comment`, { body: "A sealed comment." });
  assert.equal(c.status, 303, await c.text());
  const [n] = await sql("select body from public.proposal_notes where proposal_id = $1 and kind = 'comment'", [p.id]);
  assert.ok(isSealed(n.body));
  assert.equal(openBody(n.body, V), "A sealed comment.");
  assert.match(await page(`/v/${V}/proposals/${p.id}`), /A sealed comment\./);
  const d = await post(`/v/${V}/proposals/${p.id}/decide`, { decision: "approve", note: "", revision: "1" });
  assert.equal(d.status, 303, await d.text());
  const [v] = await sql("select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = 'canon/terms.md'", [V]);
  assert.ok(isSealed(v.body), "the approved version is the sealed proposal body");
  assert.equal(openBody(v.body, V), "Proposed terms.");
});

test("sealed: a thread's messages are ciphertext and read back on the thread page", async () => {
  const r = await post(`/v/${V}/threads`, { title: "Sealed thread", body: "First sealed message." });
  assert.equal(r.status, 303, await r.text());
  const tid = /threads\/([0-9a-f-]{36})/.exec(r.headers.get("location"))?.[1];
  assert.ok(tid, r.headers.get("location"));
  const m = await post(`/v/${V}/threads/${tid}/post`, { body: "Second sealed message." });
  assert.equal(m.status, 303, await m.text());
  const rows = await sql("select body from public.thread_messages where thread_id = $1 order by id", [tid]);
  assert.deepEqual(rows.map((x) => isSealed(x.body)), [true, true]);
  assert.deepEqual(rows.map((x) => openBody(x.body, V)), ["First sealed message.", "Second sealed message."]);
  const h = await page(`/v/${V}/threads/${tid}`);
  assert.match(h, /First sealed message\./);
  assert.match(h, /Second sealed message\./);
});
