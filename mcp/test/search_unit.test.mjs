// The MCP server's copy of the search that moved up from SQL
// (src/search.ts) is the web app's: web/test/search_unit.test.mjs proves
// it; this checks the copy answers the same, including the vector layout
// SQL tests build with float4send.

import assert from "node:assert/strict";
import { test } from "node:test";

const { rankFiles, vectorBytes } = await import("../dist/search.js");

test("mcp search unit: the shared module ranks words and meaning as the web app's does", () => {
  const f = (path, body, ms) => ({ path, policy: "open", body, updated_at: new Date(ms), author: "a", agent: null });
  const files = [f("a.md", "needle", 1000), f("b.md", "needle needle", 2000), f("c.md", "Seats and plans.", 3000)];
  const v = Array.from({ length: 384 }, (_, k) => (k === 7 ? 1 : 0));
  assert.deepEqual(rankFiles(files, "needle", 10, null, 0.78).map((h) => h.path), ["b.md", "a.md"]);
  assert.equal(vectorBytes([1]).toString("hex"), "3f800000", "float4send's bytes");
  assert.deepEqual(rankFiles(files, "charging", 10, v, 0.78, [{ path: "c.md", line: 1, embedding: vectorBytes(v) }]).map((h) => h.path), ["c.md"]);
});
