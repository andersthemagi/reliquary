// The search that moved up from SQL (src/search.ts, the same file as
// mcp/src/search.ts; docs/design.md, "Encryption at rest", section 4): the
// word match as websearch_to_tsquery('simple') read it, ts_rank's order,
// the 10 KB head, meaning blended by reciprocal rank, the lines a hit shows
// and the cap note. What the servers wire around it is in their own tests.

import assert from "node:assert/strict";
import { test } from "node:test";

const { capNote, parseQuery, pickLines, rankFiles, vectorBytes, wordScore, SEARCH_CAP } = await import("../dist/search.js");

let t = 0;
const file = (path, body, extra = {}) => ({ path, policy: "open", body, updated_at: new Date(1_700_000_000_000 + t++ * 1000), author: "a", agent: null, ...extra });
const paths = (hits) => hits.map((h) => h.path);
const unit = (i) => Array.from({ length: 384 }, (_, k) => (k === i ? 1 : 0));

test("search unit: a query reads as websearch_to_tsquery: words required, a phrase adjacent, or between alternatives, -word and -\"phrase\" left out", () => {
  assert.deepEqual(parseQuery('needle "the hay" -straw or barn -"old barn"'), [
    { must: [["needle"], ["the", "hay"]], not: [["straw"]] },
    { must: [["barn"]], not: [["old", "barn"]] },
  ]);
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery("  \"\" - or "), []);
  assert.deepEqual(parseQuery("Beaux-Arts école"), [{ must: [["beaux", "arts"], ["école"]], not: [] }]);
});

test("search unit: words match whole words in any case, phrases only adjacent, exclusions and alternatives as read; wildcards match nothing extra", () => {
  const q = (s) => parseQuery(s);
  const body = "The needle is in the hay.\nAnother Needle, no straw.";
  assert.ok(wordScore(body, q("needle")) > 0);
  assert.ok(wordScore(body, q("NEEDLE hay")) > 0);
  assert.equal(wordScore(body, q("need")), null, "a prefix is not a word");
  assert.ok(wordScore(body, q('"the needle"')) > 0);
  assert.equal(wordScore(body, q('"needle hay"')), null, "not adjacent");
  assert.equal(wordScore(body, q("needle -hay")), null);
  assert.ok(wordScore(body, q("needle -barn")) > 0);
  assert.ok(wordScore(body, q("barn or hay")) > 0);
  assert.equal(wordScore(body, q("barn or silo")), null);
  assert.equal(wordScore(body, q("%")), null);
  assert.equal(wordScore(body, q("")), null);
});

test("search unit: the rank is ts_rank's: 0.1 per occurrence falling off as 1/n² over Zeta(2), summed over terms, at most 256 occurrences", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(wordScore("needle", parseQuery("needle")), 0.1 / 1.64493406685);
  near(wordScore("needle needle", parseQuery("needle")), (0.1 + 0.1 / 4) / 1.64493406685);
  near(wordScore("needle hay", parseQuery("needle hay")), 0.2 / 1.64493406685);
  near(wordScore("needle ".repeat(300), parseQuery("needle")), wordScore("needle ".repeat(256), parseQuery("needle")));
});

test("search unit: words match over a file's first 10,000 characters; a longer file is found by its path and its head", () => {
  const long = `${"x ".repeat(5000)}needle`;
  assert.equal(wordScore(long, parseQuery("needle")), null);
  assert.ok(wordScore(`needle ${long}`, parseQuery("needle")) > 0);
  assert.deepEqual(paths(rankFiles([file("notes/needle.md", long)], "needle", 10, null, 0.78)), ["notes/needle.md"]);
});

test("search unit: hits are by rank, then newest first, then by path match; the limit is clamped to 1 to 100", () => {
  const files = [file("a.md", "needle"), file("b.md", "needle needle"), file("c.md", "needle"), file("needle/d.md", "nothing here")];
  assert.deepEqual(paths(rankFiles(files, "needle", 10, null, 0.78)), ["b.md", "c.md", "a.md", "needle/d.md"]);
  assert.equal(rankFiles(files, "needle", 0, null, 0.78).length, 1);
  assert.equal(rankFiles(files, "needle", 2, null, 0.78).length, 2);
  assert.deepEqual(paths(rankFiles(files, "  NEEDLE/D ", 10, null, 0.78)), ["needle/d.md"], "a path matches the trimmed query as a substring, any case");
  assert.deepEqual(rankFiles(files, "   ", 10, null, 0.78), []);
});

test("search unit: meaning finds a file with no shared words at the floor, names its best chunk's line, and a file found both ways ranks above one found by words alone", () => {
  const files = [file("pricing.md", "# Pricing\n\nSeats and plans.", { policy: "canon" }), file("garden.md", "Tomatoes need sun.")];
  const vectors = [
    { path: "pricing.md", line: 1, embedding: vectorBytes(unit(1)) },
    { path: "pricing.md", line: 3, embedding: vectorBytes(unit(2)) },
    { path: "garden.md", line: 1, embedding: vectorBytes(unit(5)) },
  ];
  const byMeaning = rankFiles(files, "what are you charging", 10, unit(2), 0.78, vectors);
  assert.deepEqual(byMeaning.map((h) => [h.path, h.line, h.policy]), [["pricing.md", 3, "canon"]]);
  assert.deepEqual(byMeaning[0].lines, [[3, "Seats and plans."]], "the lines of the part that matched");
  assert.deepEqual(rankFiles(files, "what are you charging", 10, unit(9), 0.78, vectors), [], "an unrelated vector finds nothing");
  assert.deepEqual(rankFiles(files, "what are you charging", 10, null, 0.78, vectors), [], "without a vector, words only");
  assert.deepEqual(paths(rankFiles(files, "seats or tomatoes", 10, unit(5), 0.78, vectors)), ["garden.md", "pricing.md"]);
  assert.deepEqual(paths(rankFiles(files, "zzz", 10, unit(1), 0.78, [{ path: "elsewhere.md", line: 1, embedding: vectorBytes(unit(1)) }])), [], "a vector of a file not in the set never answers");
});

test("search unit: a hit shows up to three lines holding a searched word, cut at 200 characters, else the first non-blank line", () => {
  assert.deepEqual(pickLines("intro\nthe needle is here\nfiller\nanother Needle\nmore\nthird NEEDLE\nfourth needle", ["needle"], null), [
    [2, "the needle is here"],
    [4, "another Needle"],
    [6, "third NEEDLE"],
  ]);
  assert.deepEqual(pickLines(`short\n${"x".repeat(250)}`, ["x"], null), [[2, `${"x".repeat(200)}...`]]);
  assert.deepEqual(pickLines("\n\n   \n  first real line\nmore", ["zzz"], null), [[4, "  first real line"]]);
  assert.deepEqual(pickLines(" \t\n　\n﻿\nreal text", ["zzz"], null), [[4, "real text"]]);
  assert.deepEqual(pickLines("", ["zzz"], null), []);
  assert.deepEqual(pickLines("a\n\nb\nc\nd", ["zzz"], 3), [[3, "b"], [4, "c"], [5, "d"]], "a hit by meaning shows three lines from its chunk");
});

test("search unit: the cap is 2,000 and the note says when a vault has more", () => {
  assert.equal(SEARCH_CAP, 2000);
  assert.equal(capNote(2000, 2000), "");
  assert.equal(capNote(2001, 2000), "This vault has 2,001 files; the newest 2,000 were searched.");
});
