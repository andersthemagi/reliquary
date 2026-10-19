// Rewrites the pending section of an open release pull request's changelog
// in tiers, so how much an entry matters shows in how much it says.
// release-please writes one bullet per PR title; this keeps those bullets
// for small changes and gives a heading and a paragraph to anything whose
// PR has a "## Release note" (.github/PULL_REQUEST_TEMPLATE.md):
//
//   Breaking changes   release-please's own BREAKING CHANGES section
//   New                a feat with a note
//   Changed            a note starting "Changed:", or any non-feat with a note
//   Smaller changes    a feat without a note, one line
//   Fixes, Performance, Security, Reverts   one line each
//
// Run by .github/workflows/release.yml after release-please on every push to
// main: release-please regenerates the section from scratch each time, and
// this rewrites it again. A section already rewritten carries MARK and is
// left alone, so running twice changes nothing.
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node web/scripts/changelog-tiers.mjs
//
// Tested by web/test/changelog_tiers.test.mjs (F980).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MARK = "<!-- tiers: web/scripts/changelog-tiers.mjs -->";

const SECTIONS = {
  "⚠ BREAKING CHANGES": "breaking",
  Features: "feat",
  "Bug fixes": "fix",
  Performance: "perf",
  Security: "security",
  Reverts: "revert",
};
const ONE_LINE = [
  ["feat", "Smaller changes"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["security", "Security"],
  ["revert", "Reverts"],
];

// The text under a PR body's "## Release note" heading, comments dropped;
// empty when there is none, or it only says there is none.
export function releaseNote(body) {
  const m = /^##[ \t]+Release note[^\n]*\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/im.exec((body ?? "").replace(/\r\n?/g, "\n"));
  // Until no "<!--" is left: one regex pass over "<!<!-- -->-- x -->" leaves
  // a new one. An unclosed comment runs to the end.
  let note = m?.[1] ?? "";
  for (let i; (i = note.indexOf("<!--")) !== -1; ) {
    const end = note.indexOf("-->", i + 4);
    note = note.slice(0, i) + (end === -1 ? "" : note.slice(end + 3));
  }
  // The attribution footer agents end a PR body with isn't part of the note.
  note = note.replace(/^🤖 Generated with \[Claude Code\].*$/gm, "").trim();
  return /^(none|n\/a|-|no)\.?$/i.test(note) ? "" : note;
}

// "* **scope:** subject ([#12](url)) ([abc1234](url)), closes ..." → its parts.
function entry(line) {
  const m = /^\* (?:\*\*[^*]+:\*\* )?(.*?)(?: \(\[#(\d+)\]\(([^)]+)\)\))?(?: \(\[[0-9a-f]{7,}\]\([^)]+\)\))?(?:, closes .*)?$/.exec(line);
  if (!m) return null;
  // A plain first word only: "dev.sh" or "npm" stay as written.
  const plain = /^[a-z]+(?:['-][a-z]+)*(?=\s|$)/.test(m[1]) && !/^(?:npm|npx|gh|git)\b/.test(m[1]);
  const text = plain ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : m[1];
  return { text, pr: m[2] ? Number(m[2]) : null, link: m[2] ? ` ([#${m[2]}](${m[3]}))` : "" };
}

const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The PR numbers a pending section's entries are for, for fetching their
// notes: one per entry, as entry() reads it, so an issue a title names
// ("... (#408) (#413)") isn't fetched as a pull request.
export function prNumbers(section) {
  return [...new Set(section.split("\n").map((l) => l.startsWith("* ") && entry(l)?.pr).filter(Boolean))];
}

// One release's section (its "## [x.y.z]" heading through the line before
// the next release's) rewritten in tiers. notes: Map of PR number → note.
export function tierSection(section, notes) {
  if (section.includes(MARK)) return section;
  const [heading, ...lines] = section.trimEnd().split("\n");
  const byType = {};
  const breaking = new Set();
  let type = null;
  for (const line of lines) {
    const h = /^### (.+)$/.exec(line);
    if (h) {
      type = SECTIONS[h[1].trim()] ?? "other";
      continue;
    }
    const e = line.startsWith("* ") && entry(line);
    if (!e || !type) continue;
    if (type === "breaking") {
      if (e.pr) breaking.add(e.pr);
      (byType.breaking ??= []).push(e);
    } else (byType[type] ??= []).push(e);
  }

  const headed = { breaking: [], new: [], changed: [] };
  const oneLine = {};
  for (const e of byType.breaking ?? []) headed.breaking.push({ ...e, note: notes.get(e.pr) || "" });
  for (const [t, list] of Object.entries(byType)) {
    if (t === "breaking") continue;
    for (const e of list) {
      if (e.pr && breaking.has(e.pr)) continue; // already told, at the top
      const note = (e.pr && notes.get(e.pr)) || "";
      if (/^changed:/i.test(note)) headed.changed.push({ ...e, note: upperFirst(note.replace(/^changed:\s*/i, "")) });
      else if (note && t === "feat") headed.new.push({ ...e, note });
      else if (note) headed.changed.push({ ...e, note });
      else (oneLine[t] ??= []).push(e);
    }
  }

  const out = [heading, "", MARK];
  const block = (title, list) => {
    if (!list.length) return;
    out.push("", `### ${title}`);
    for (const e of list) out.push("", `#### ${e.text}${e.link}`, ...(e.note ? ["", e.note] : []));
  };
  block("⚠ Breaking changes", headed.breaking);
  block("New", headed.new);
  block("Changed", headed.changed);
  for (const [t, title] of ONE_LINE) {
    if (!oneLine[t]?.length) continue;
    out.push("", `### ${title}`, "", ...oneLine[t].map((e) => `- ${e.text}${e.link}`));
  }
  return out.join("\n") + "\n";
}

// The first release section in a CHANGELOG.md or a release PR's body: from
// its "## [" heading to the next one, or to the body's "---" footer.
export function firstSection(text) {
  const start = text.search(/^## \[/m);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^## \[|^---$/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

export function retier(text, notes) {
  const section = firstSection(text);
  if (!section || section.includes(MARK)) return text;
  return text.replace(section, tierSection(section, notes) + "\n");
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set (owner/repo)");
  const prs = JSON.parse(gh(["api", `repos/${repo}/pulls?state=open&per_page=100`]));
  for (const pr of prs) {
    if (!pr.head.ref.startsWith("release-please--") || !/^Release( cli)? v\d/.test(pr.title)) continue;
    const path = pr.title.startsWith("Release cli") ? "cli/CHANGELOG.md" : "CHANGELOG.md";
    const file = JSON.parse(gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(pr.head.ref)}`]));
    const text = Buffer.from(file.content, "base64").toString("utf8");
    const section = firstSection(text);
    if (!section || section.includes(MARK)) {
      console.log(`#${pr.number} ${path}: already in tiers`);
      continue;
    }
    const notes = new Map();
    for (const n of prNumbers(section)) notes.set(n, releaseNote(JSON.parse(gh(["api", `repos/${repo}/pulls/${n}`])).body));
    gh(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "--input", "-"], JSON.stringify({
      message: "chore: the changelog in tiers (web/scripts/changelog-tiers.mjs)",
      content: Buffer.from(retier(text, notes)).toString("base64"),
      sha: file.sha,
      branch: pr.head.ref,
    }));
    // release-please publishes the GitHub Release from this body, not the file.
    gh(["api", "-X", "PATCH", `repos/${repo}/pulls/${pr.number}`, "--input", "-"], JSON.stringify({ body: retier(pr.body ?? "", notes) }));
    console.log(`#${pr.number} ${path}: rewritten in tiers, ${[...notes.values()].filter(Boolean).length} release notes`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
