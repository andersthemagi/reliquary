// related_files over MCP: what an agent sees of a path's references, in
// both directions. Who may see them is proved in
// supabase/tests/file_references_test.sql; this checks the answer's shape.
// Writes its own files under refs/ in Eve home (seed.sql's "Create vault and
// delete_file" block), which no other test lists.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { EVE_HOME_RW, EVE_ALL_RO } = process.env;
const call = (token, name, args = {}) => call_(URL_, token, name, args);
const V = "Eve home";
// The fenced lines of an answer, markers dropped.
const lines = (text) => text.split("\n").filter((l) => /^(->|<-) /.test(l));

before(async () => {
  for (const [path, content] of [
    ["refs/hub.md", "See [[canon/charter]], [the plan](plan.md) and [[refs/later]]."],
    ["refs/plan.md", "Back to [[refs/hub]]."],
    ["refs/alone.md", "No references here, just https://example.com."],
  ]) {
    const r = await call(EVE_HOME_RW, "write_file", { vault: V, path, content });
    assert.equal(r.isError, false, r.text);
  }
});

test("related_files: lists what a file refers to and what refers to it, each with its policy, missing ones marked, between markers", async () => {
  const r = await call(EVE_HOME_RW, "related_files", { vault: V, path: "refs/hub.md" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Paths are between NOTE-([0-9a-f]+) and END-\1/);
  assert.deepEqual(lines(r.text), [
    "-> canon/charter.md  canon",
    "-> refs/later.md  open  missing",
    "-> refs/plan.md  open",
    "<- refs/plan.md  open",
  ]);
});

test("related_files: a path with no file yet lists what refers to it", async () => {
  const r = await call(EVE_HOME_RW, "related_files", { vault: V, path: "refs/later.md" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(lines(r.text), ["<- refs/hub.md  open"]);
});

test("related_files: a file with no references says so; a path with no file and none is refused with a reference", async () => {
  assert.equal((await call(EVE_HOME_RW, "related_files", { vault: V, path: "refs/alone.md" })).text, "No references to or from this file.");
  const r = await call(EVE_HOME_RW, "related_files", { vault: V, path: "refs/never.md" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No file at that path, and no file refers to it\. Use list_files/);
  assert.match(r.text, /where: MCP tool related_files: file lookup; ref [0-9a-f]{8}\)$/);
});

test("related_files: a read-only connection may call it", async () => {
  const r = await call(EVE_ALL_RO, "related_files", { vault: V, path: "refs/plan.md" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(lines(r.text), ["-> refs/hub.md  open", "<- refs/hub.md  open"]);
});
