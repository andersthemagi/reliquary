#!/usr/bin/env node
// Builds the public docs into web/docs-build/ (gitignored), which the web
// app serves at /docs (src/docs.ts). Runs first in `npm run build`, so on
// Vercel and in web/test.sh; it reads outside web/, so it runs from a full
// checkout.
//
// Sources: docs/public/*.md (hand-written; the sidebar is SUMMARY.md) and,
// for the generated parts, markers a page carries on a line of their own:
//   <!-- generated:mcp-tools -->  mcp/test/contract.snapshot.json plus
//                                 docs/public/reference/mcp-access.json
//   <!-- generated:cli-help -->   the help text in cli/src/cli.ts
//   <!-- generated:changelog -->  CHANGELOG.md at the repo root, if any
// Fails (exit 1) on a page missing from the sidebar, a sidebar entry with no
// page, a page without a title or summary, an MCP tool with no entry in
// mcp-access.json. Output is
// deterministic: no dates, no absolute paths.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliDefinitions,
  mcpToolsMarkdown,
  parseSummary,
  readJson,
  titleAndSummary,
} from "./docs-lib.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");
const SRC = join(ROOT, "docs", "public");
const OUT = join(WEB, "docs-build");

function fail(message) {
  console.error(`gen-docs: ${message}`);
  process.exit(1);
}

if (!existsSync(join(SRC, "SUMMARY.md"))) fail(`no ${relative(ROOT, SRC)}/SUMMARY.md; run from a full checkout`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith(".md") ? [relative(SRC, p).split("\\").join("/")] : [];
  });
}

// Generated parts.
function changelog() {
  const file = join(ROOT, "CHANGELOG.md");
  if (!existsSync(file)) return "No releases yet.";
  const text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  // From the first release heading on: the file's own title and preamble
  // are for readers of the repo (the page has its own). Drop HTML
  // (release-please adds anchors), which the renderer would show as text,
  // and keep only the text of links into the repo, which mean nothing here.
  const start = text.search(/^## /m);
  const body = (start === -1 ? "" : text.slice(start))
    .replace(/<a name="[^"]*"><\/a>\n?/g, "")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/\[([^\]]*)\]\((?!https?:|mailto:|#)[^)]*\)/g, "$1")
    .trim();
  return body || "No releases yet.";
}

const cli = () =>
  cliDefinitions(readFileSync(join(ROOT, "cli/src/cli.ts"), "utf8"), readFileSync(join(ROOT, "cli/src/config.ts"), "utf8"));

const GENERATED = {
  "mcp-tools": () =>
    mcpToolsMarkdown(readJson(join(ROOT, "mcp/test/contract.snapshot.json")), readJson(join(SRC, "reference/mcp-access.json"))),
  "cli-help": () => ["```text", cli().help, "```"].join("\n"),
  changelog,
};

let sections;
try {
  sections = parseSummary(readFileSync(join(SRC, "SUMMARY.md"), "utf8"));
} catch (err) {
  fail(err.message);
}
const inSummary = sections.flatMap((s) => s.pages);
const files = walk(SRC).filter((f) => f !== "SUMMARY.md").sort();
for (const f of files) if (!inSummary.some((p) => p.file === f)) fail(`${f} is not in SUMMARY.md (every page must be reachable from the sidebar)`);
for (const p of inSummary) if (!files.includes(p.file)) fail(`SUMMARY.md links ${p.file}, which doesn't exist`);
const seen = new Set();
for (const p of inSummary) {
  if (seen.has(p.slug)) fail(`SUMMARY.md lists ${p.file} twice`);
  seen.add(p.slug);
}
if (!seen.has("index")) fail("SUMMARY.md must list index.md (the docs home)");

rmSync(OUT, { recursive: true, force: true });
const manifest = { sections: [] };
for (const s of sections) {
  const pages = [];
  for (const p of s.pages) {
    let text = readFileSync(join(SRC, p.file), "utf8").replace(/\r\n?/g, "\n");
    text = text.replace(/^<!-- generated:([a-z-]+) -->$/gm, (_, name) => {
      if (!GENERATED[name]) fail(`${p.file}: unknown marker generated:${name}`);
      try {
        return GENERATED[name]();
      } catch (err) {
        fail(`${p.file}: ${err.message}`);
      }
    });
    const { title, summary } = titleAndSummary(text);
    if (!title) fail(`${p.file} has no "# Title" line`);
    if (!summary) fail(`${p.file} has no summary paragraph under its title`);
    const out = join(OUT, p.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text.endsWith("\n") ? text : `${text}\n`);
    pages.push({ slug: p.slug, title, navTitle: p.navTitle, summary });
  }
  manifest.sections.push({ title: s.title, pages });
}
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.info(`gen-docs: ${inSummary.length} pages in ${relative(ROOT, OUT)}`);
