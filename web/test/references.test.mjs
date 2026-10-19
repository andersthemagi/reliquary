// The reference rules (src/references.ts, the same file as
// mcp/src/references.ts), carried over from the SQL cases they replaced
// (supabase/tests/file_references_test.sql before #464).

import assert from "node:assert/strict";
import { test } from "node:test";

const { referencesIn } = await import("../dist/references.js");

test("references: wiki and Markdown references are vault paths, each once, sorted", () => {
  const body = `
See [[canon/pricing]] and [[people/ben.md|Ben]], [the brief](brief.md), [up](../index.md)
and [rooted](/canon/pricing.md#tiers), [angled](<the brief.md> "title"), [[canon/pricing#tiers]], [spaced](the%20brief.md).
`;
  assert.deepEqual(referencesIn("notes/a.md", body), ["canon/pricing.md", "index.md", "notes/brief.md", "notes/the brief.md", "people/ben.md"]);
});

test("references: URLs, anchors alone, images, non-.md links, paths above the root and the file itself are not references", () => {
  const body = `
[web](https://example.com/x.md) [mail](mailto:a@example.com) [anchor](#top) [[#top]] [[]]
![diagram](pic.md) ![[photo.png]] [image](chart.png) [too far](../../out.md) [self](noise.md) [[notes/noise]]
`;
  assert.deepEqual(referencesIn("notes/noise.md", body), []);
  assert.deepEqual(referencesIn("notes/noise.md", ""), []);
});

test("references: a path over 1024 characters is not one", () => {
  assert.deepEqual(referencesIn("a.md", `[[${"x".repeat(1025)}]]`), []);
});
