// The changelog in tiers (scripts/changelog-tiers.mjs, F980): release-please's
// flat list rewritten so a breaking change, a new feature or a change to how
// something works gets a heading and its PR's release note, and everything
// else stays one line. Pure functions only; nothing here calls GitHub.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MARK, firstSection, prNumbers, releaseNote, retier, tierSection } from "../scripts/changelog-tiers.mjs";

const U = "https://github.com/o/r";
const bullet = (scope, text, n, sha = "abc1234") =>
  `* ${scope ? `**${scope}:** ` : ""}${text} ([#${n}](${U}/issues/${n})) ([${sha}](${U}/commit/${sha}))`;

const PENDING = [
  `## [0.25.0](${U}/compare/v0.24.0...v0.25.0) (2026-10-18)`,
  "",
  "",
  "### ⚠ BREAKING CHANGES",
  "",
  bullet("mcp", "search takes a vault id, not a name", 9),
  "",
  "### Features",
  "",
  bullet("search", "find files by meaning, not only by shared words", 1),
  bullet("web", "New file warns when a path has no extension", 2),
  bullet("mcp", "search takes a vault id, not a name", 9),
  bullet("tasks", "a plan names a member by tag", 3),
  "",
  "",
  "### Bug fixes",
  "",
  bullet("web", "landing page says what Reliquary is in one line", 4) + `, closes [#420](${U}/issues/420)`,
  bullet("sql", "a held step is released when its holder leaves", 5),
  bullet("dev", "dev.sh lists every subcommand", 7),
  "",
  "### Performance",
  "",
  bullet(null, "search in a small vault no longer scans every vault", 6),
  "",
].join("\n");
const OLDER = `## [0.24.0](${U}/compare/v0.23.0...v0.24.0) (2026-10-13)\n\nWhat 0.24.0 did.\n\n### Features\n\n${bullet("web", "older", 0)}\n`;
const NOTES = new Map([
  [1, "Search now matches what a file means.\n\nAsk in your own words."],
  [3, "Changed: `for:` takes a member's short tag; an email is refused."],
  [5, "A task held by someone who leaves goes back to ready."],
  [9, "Pass the vault's id from `list_vaults`."],
]);

test("changelog tiers: a PR's release note is the text under its heading, without comments, and a note that says none is none", () => {
  const body = "## What and why\n\nStuff.\n\n## Release note\n\n<!-- guidance -->\nSearch now matches meaning.\r\n\n## Issue\n\nCloses #1";
  assert.equal(releaseNote(body), "Search now matches meaning.");
  assert.equal(releaseNote("## Release note\n\n<!-- only the template -->\n\n## Testing\n"), "");
  assert.equal(releaseNote("## Release note\n\nNone.\n"), "");
  assert.equal(releaseNote("## Release note\n\nLast section.\n"), "Last section.");
  assert.equal(releaseNote(null), "");
  assert.equal(releaseNote("## Release note\n\n<!<!-- -->-- hidden -->Kept."), "Kept.", "a comment nested to survive one pass is still dropped");
});

test("changelog tiers: breaking changes come first, then new features and changes with their notes, then one line for everything else", () => {
  const out = tierSection(firstSection(PENDING + "\n" + OLDER), NOTES);
  const headings = [...out.matchAll(/^#{3,4} (.+)$/gm)].map((m) => m[1].replace(/ \(\[#\d+\].*$/, ""));
  assert.deepEqual(headings, [
    "⚠ Breaking changes",
    "Search takes a vault id, not a name",
    "New",
    "Find files by meaning, not only by shared words",
    "Changed",
    "A plan names a member by tag",
    "A held step is released when its holder leaves",
    "Smaller changes",
    "Fixes",
    "Performance",
  ]);
  assert.match(out, /#### Find files by meaning, not only by shared words \(\[#1\]\(https:\/\/github\.com\/o\/r\/issues\/1\)\)\n\nSearch now matches what a file means\.\n\nAsk in your own words\./);
  assert.match(out, /#### A plan names a member by tag \(\[#3\][^\n]*\n\n`for:` takes a member's short tag; an email is refused\./, "the Changed: prefix is dropped");
  assert.match(out, /### Smaller changes\n\n- New file warns when a path has no extension \(\[#2\]\([^)]+\)\)\n/);
  assert.match(out, /### Fixes\n\n- Landing page says what Reliquary is in one line \(\[#4\]\([^)]+\)\)\n- dev\.sh lists every subcommand/, "a file name keeps its case");
  assert.match(out, /### Performance\n\n- Search in a small vault no longer scans every vault \(\[#6\]\([^)]+\)\)\n/);
  assert.equal(out.match(/Search takes a vault id/g).length, 1, "a breaking feature is told once, at the top");
  assert.doesNotMatch(out, /abc1234|\*\*\w+:\*\*|closes/, "no commit hashes, scopes or closes noise");
});

test("changelog tiers: only the pending release is rewritten, once; running again changes nothing", () => {
  const file = `# Changelog\n\nPreamble.\n\n${PENDING}\n${OLDER}`;
  const once = retier(file, NOTES);
  assert.ok(once.startsWith("# Changelog\n\nPreamble.\n\n## [0.25.0]"));
  assert.ok(once.includes(MARK));
  assert.ok(once.endsWith(OLDER), "the released 0.24.0 entry is untouched");
  assert.equal(retier(once, new Map()), once);
});

test("changelog tiers: a release pull request's body is rewritten up to its footer, header and footer kept", () => {
  const body = `Merging this pull request tags this version.\n---\n\n\n${PENDING}\n---\nThis PR was generated with Release Please.`;
  const out = retier(body, NOTES);
  assert.ok(out.startsWith("Merging this pull request tags this version.\n---\n\n\n## [0.25.0]"));
  assert.ok(out.endsWith("\n---\nThis PR was generated with Release Please."));
  assert.ok(out.includes("### New"));
  assert.deepEqual(prNumbers(firstSection(body)), [9, 1, 2, 3, 4, 5, 7, 6]);
});
