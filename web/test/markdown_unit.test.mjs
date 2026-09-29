// Markdown rendering (src/markdown.ts): tables scroll on narrow screens
// instead of overflowing, in a file preview or a proposal's diff, not only
// on a docs page. No server needed.

import assert from "node:assert/strict";
import { test } from "node:test";

const md = await import("../dist/markdown.js");

const TABLE = "| a | a fairly long header |\n|---|---|\n| 1 | some cell text |\n";

test("renderMarkdown: a table in a file or proposal preview is wrapped to scroll, same as a docs page", () => {
  const file = md.renderMarkdown(TABLE);
  assert.match(file, /^<div class="table-wrap"><table>/);
  assert.match(file, /<\/table>\n<\/div>\n?$/);
  const docs = md.renderDocMarkdown(TABLE, (href) => href).html;
  assert.match(docs, /^<div class="table-wrap"><table>/);
});

test("renderMarkdown: text with no table is unaffected", () => {
  assert.equal(md.renderMarkdown("Just a paragraph.\n"), "<p>Just a paragraph.</p>\n");
});
