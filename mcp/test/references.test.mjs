// The MCP server's copy of the reference rules (src/references.ts) is the
// web app's: web/test/references.test.mjs proves the rules, this that the
// copy parses the same text the same way.

import assert from "node:assert/strict";
import { test } from "node:test";

const { referencesIn } = await import("../dist/references.js");

test("mcp references: the shared module finds the same references as the web app's", () => {
  assert.deepEqual(
    referencesIn("notes/a.md", "See [[canon/pricing]], [the brief](brief.md), ![[photo.png]] and [web](https://example.com/x.md)."),
    ["canon/pricing.md", "notes/brief.md"],
  );
});
