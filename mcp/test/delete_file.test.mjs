// delete_file over MCP: an agent deletes an open file directly, as its
// person may; canon files still need a proposal, and read-only tokens delete
// nothing. The database rules are in supabase/tests/delete_test.sql.
// Seed: the "Create vault and delete_file" block at the end of test/seed.sql.

import assert from "node:assert/strict";
import { test } from "node:test";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { EVE_HOME_RW, EVE_ALL_RO } = process.env;

const call = (token, name, args = {}) => call_(URL_, token, name, args);

test("delete_file: an agent deletes an open file, and the log says it was the agent", async () => {
  const r = await call(EVE_HOME_RW, "delete_file", { vault: "Eve home", path: "notes/scratch.md" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.text, "Deleted notes/scratch.md. The change is logged as Eve home rw.");
  assert.doesNotMatch((await call(EVE_HOME_RW, "list_files", { vault: "Eve home" })).text, /notes\/scratch\.md/);
  assert.equal((await call(EVE_HOME_RW, "read_file", { vault: "Eve home", path: "notes/scratch.md" })).isError, true);
  assert.match((await call(EVE_HOME_RW, "changes_since", { vault: "Eve home" })).text, /file\.delete notes\/scratch\.md\s+by \S+ via Eve home rw/);
});

test("delete_file: a canon file can't be deleted directly; it points to propose", async () => {
  const r = await call(EVE_HOME_RW, "delete_file", { vault: "Eve home", path: "canon/charter.md" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not allowed: canon\/charter\.md is canon: use propose/);
  assert.equal((await call(EVE_HOME_RW, "read_file", { vault: "Eve home", path: "canon/charter.md" })).isError, false);
});

test("delete_file: a read-only token deletes nothing", async () => {
  const r = await call(EVE_ALL_RO, "delete_file", { vault: "Eve home", path: "notes/keep.md" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not allowed/);
  assert.equal((await call(EVE_ALL_RO, "read_file", { vault: "Eve home", path: "notes/keep.md" })).isError, false);
});

test("delete_file: a missing file is reported as not found", async () => {
  const r = await call(EVE_HOME_RW, "delete_file", { vault: "Eve home", path: "notes/never.md" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not found: no such file/);
});
