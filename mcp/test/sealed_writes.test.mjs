// Every write seals over MCP (src/content.ts storeBody; #462, part of
// #238): what an agent writes with write_file, propose, comment_on_proposal,
// open_thread and post_message is ciphertext in the database, opens under
// the vault's id with the servers' key, and reads back through the tools as
// the text sent. Runs as Eve (seed.sql) in Eve home, under paths and
// titles of its own (Gus is at his vault limit, so no vault of this file's).

import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { call } from "./mcp-client.mjs";

const { EVE_HOME_RW: TOKEN, MCP_URL, TEST_SUPER_URL } = process.env;
const VAULT = "Eve home";
const P = `sealed-${process.pid}`;
const content = await import("../dist/content.js");
content.configureContent({ CONTENT_KEYS: process.env.CONTENT_KEYS ?? "" });
const tool = (name, args) => call(MCP_URL, TOKEN, name, { vault: VAULT, ...args });

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: TEST_SUPER_URL });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}
let V;

test("mcp sealed: write_file stores ciphertext that opens under the vault's id and reads back with read_file", async () => {
  [{ id: V }] = await sql("select id from public.vaults where name = $1", [VAULT]);
  const w = await tool("write_file", { path: `${P}/notes.md`, content: "Sealed over MCP." });
  assert.equal(w.isError, false, w.text);
  const [row] = await sql("select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = $2", [V, `${P}/notes.md`]);
  assert.ok(content.isSealed(row.body));
  assert.doesNotMatch(row.body.toString("latin1"), /Sealed over MCP/);
  assert.equal(content.openBody(row.body, V), "Sealed over MCP.");
  assert.throws(() => content.openBody(row.body, "00000000-0000-0000-0000-000000000000"), /could not be decrypted/);
  assert.match((await tool("read_file", { path: `${P}/notes.md` })).text, /Sealed over MCP\./);
  assert.match((await tool("search", { query: "sealed over mcp" })).text, new RegExp(`${P}/notes\\.md`));
});

test("mcp sealed: propose, comment_on_proposal, open_thread and post_message store ciphertext and read back", async () => {
  const p = await tool("propose", { path: `${P}/terms.md`, content: "Proposed over MCP.", reason: "why" });
  assert.equal(p.isError, false, p.text);
  const [{ id: pid, body }] = await sql("select id, body from public.proposals where vault_id = $1 and path = $2", [V, `${P}/terms.md`]);
  assert.ok(content.isSealed(body));
  assert.equal(content.openBody(body, V), "Proposed over MCP.");
  assert.equal((await call(MCP_URL, TOKEN, "comment_on_proposal", { proposal_id: pid, comment: "Sealed comment." })).isError, false);
  const [n] = await sql("select body from public.proposal_notes where proposal_id = $1 and kind = 'comment'", [pid]);
  assert.equal(content.openBody(n.body, V), "Sealed comment.");
  assert.match((await call(MCP_URL, TOKEN, "read_proposal", { proposal_id: pid })).text, /Sealed comment\./);
  const t = await tool("open_thread", { title: `Sealed thread ${P}`, message: "First over MCP." });
  assert.equal(t.isError, false, t.text);
  const tid = /thread ([0-9a-f-]{36})/.exec(t.text)?.[1];
  assert.ok(tid, t.text);
  assert.equal((await call(MCP_URL, TOKEN, "post_message", { thread_id: tid, message: "Second over MCP." })).isError, false);
  const rows = await sql("select body from public.thread_messages where thread_id = $1 order by id", [tid]);
  assert.deepEqual(rows.map((x) => content.openBody(x.body, V)), ["First over MCP.", "Second over MCP."]);
  const r = await call(MCP_URL, TOKEN, "read_thread", { thread_id: tid });
  assert.match(r.text, /First over MCP\./);
  assert.match(r.text, /Second over MCP\./);
});
