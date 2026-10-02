// Shared by scripts/gen-docs.mjs (the build) and test/docs.test.mjs (the
// drift checks): reading the sidebar, the CLI's own definitions and the MCP
// tool contract. Plain Node, no dependencies.

import { readFileSync } from "node:fs";

// docs/public/SUMMARY.md: `## Section` headings, each followed by
// `- [Title](path.md)` lines; a link before the first heading is its own
// untitled section (the overview). Returns [{ title, pages: [{ file, slug, navTitle }] }].
export function parseSummary(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = { title: h[1], pages: [] };
      sections.push(current);
      continue;
    }
    const l = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (!l) continue;
    if (!current) {
      current = { title: "", pages: [] };
      sections.push(current);
    }
    const file = l[2];
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.md$/.test(file)) throw new Error(`SUMMARY.md: bad page path ${file}`);
    current.pages.push({ file, slug: file.replace(/\.md$/, ""), navTitle: l[1] });
  }
  return sections;
}

// A page's title (its first `# ` heading) and summary (the first paragraph
// after it, joined into one line).
export function titleAndSummary(markdown) {
  const lines = markdown.split("\n");
  const i = lines.findIndex((l) => /^# /.test(l));
  if (i === -1) return { title: "", summary: "" };
  const title = lines[i].slice(2).trim();
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  const para = [];
  while (j < lines.length && lines[j].trim() !== "" && !/^(#|```|\||[-*] |\d+\. |<!--)/.test(lines[j])) para.push(lines[j++].trim());
  return { title, summary: para.join(" ") };
}

// The CLI's help text, commands and options, read from cli/src/cli.ts
// (the one place they are defined) and cli/src/config.ts.
export function cliDefinitions(cliSource, configSource) {
  const m = /const HELP = `([\s\S]*?)`;/.exec(cliSource);
  if (!m) throw new Error("cli/src/cli.ts: no HELP text found");
  const server = /export const DEFAULT_SERVER = "([^"]+)"/.exec(configSource)?.[1];
  if (!server) throw new Error("cli/src/config.ts: no DEFAULT_SERVER found");
  let help = m[1].replace("${DEFAULT_SERVER}", server).replace("${credentialsFile()}", "~/.config/reliquary/credentials.json");
  if (help.includes("${")) throw new Error("cli/src/cli.ts: HELP interpolates something gen-docs doesn't know; teach docs-lib.mjs");
  // Commands: the usage lines, `reliquary <command> [<sub>]`.
  const usage = help.split("\n\nOptions:")[0];
  const commands = [...usage.matchAll(/^\s+reliquary ((?:env )?[a-z]+)/gm)].map((c) => c[1]);
  // Options: every name a parse() spec accepts, plus what HELP lists.
  const options = new Set();
  for (const s of cliSource.matchAll(/(values|flags): \[([^\]]*)\]/g)) {
    for (const n of s[2].matchAll(/"([a-z-]+)"/g)) options.add(n[1]);
  }
  for (const o of help.matchAll(/--([a-z][a-z-]+)/g)) options.add(o[1]);
  options.add("help");
  options.add("version");
  return { help, commands: [...new Set(commands)], options: [...options].sort() };
}

// One argument's limits, in words.
function limits(p) {
  const out = [];
  if (p.enum) out.push(`one of ${p.enum.map((e) => `\`${e}\``).join(", ")}`);
  if (p.minLength !== undefined && p.maxLength !== undefined) out.push(`${p.minLength} to ${p.maxLength} characters`);
  else if (p.maxLength !== undefined) out.push(`up to ${p.maxLength} characters`);
  if (p.minimum !== undefined && p.maximum !== undefined) out.push(`${p.minimum} to ${p.maximum}`);
  if (p.pattern) out.push(p.pattern === "^[0-9a-fA-F-]{36}$" ? "a proposal id (UUID)" : `matches \`${p.pattern}\``);
  return out.join("; ");
}

const cell = (s) => String(s ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");

// Words for arguments the contract leaves undescribed. A new undescribed
// argument shows an empty cell until it gets words here or in the schema.
const ARGUMENT_WORDS = {
  vault: "The vault's name or id, as `list_vaults` gives them",
  path: "A file's path in the vault, like `notes/standup.md`",
  proposal_id: "The proposal's id, from `list_proposals`",
  content: "The file's full new text",
  cursor: "The `next cursor` the last call returned; omit it to start from the beginning",
  query: "Words to find; `\"a phrase\"`, `or` and `-word` work",
  comment: "Your comment, as plain text",
  status: "Which proposals; `open` when omitted",
  delete: "`true` to propose deleting the file (then leave out `content`)",
  default_policy: "`open` or `canon` for files without a rule; `open` when omitted",
  from_line: "First line to return, counting from 1",
  to_line: "Last line to return",
  max_bytes: "At most this many bytes of text (default 100000)",
  thread_id: "The thread's id, from `list_threads` or a flag",
  title: "The thread's title, on one line",
  message: "The text, as plain text",
  to: "Member ids to address a side thread to; leave it out for the whole vault",
  all: "`true` to add the side threads addressed to others",
  before: "The `before` value the last page named, for older threads",
};

// The MCP tools reference, from mcp/test/contract.snapshot.json (what the
// server offers, byte for byte, checked by mcp/test/contract.test.mjs) and
// docs/public/reference/mcp-access.json (who may call each tool).
export function mcpToolsMarkdown(tools, access) {
  const missing = tools.filter((t) => !access[t.name]).map((t) => t.name);
  if (missing.length) throw new Error(`docs/public/reference/mcp-access.json has no entry for: ${missing.join(", ")}`);
  const extra = Object.keys(access).filter((n) => !tools.some((t) => t.name === n));
  if (extra.length) throw new Error(`docs/public/reference/mcp-access.json names tools the server doesn't offer: ${extra.join(", ")}`);
  const out = [];
  out.push("| Tool | Does | Read-only | Who may call it |", "|---|---|---|---|");
  for (const t of tools) {
    out.push(`| [\`${t.name}\`](#${t.name}) | ${cell(t.title)} | ${t.annotations?.readOnlyHint ? "yes" : "no"} | ${cell(access[t.name])} |`);
  }
  for (const t of tools) {
    out.push("", `## \`${t.name}\``, "", `**${t.title}.** ${t.description}`, "");
    out.push(`- **Who may call it:** ${access[t.name]}`);
    out.push(`- **Read-only:** ${t.annotations?.readOnlyHint ? "yes, it changes nothing" : "no, it can change the vault"}`);
    const props = Object.entries(t.inputSchema?.properties ?? {});
    const required = new Set(t.inputSchema?.required ?? []);
    out.push("");
    if (!props.length) {
      out.push("No arguments.");
      continue;
    }
    out.push("| Argument | Type | Required | Limits | Description |", "|---|---|---|---|---|");
    for (const [name, p] of props) {
      out.push(`| \`${name}\` | ${p.type ?? ""} | ${required.has(name) ? "yes" : "no"} | ${cell(limits(p))} | ${cell(p.description ?? ARGUMENT_WORDS[name] ?? "")} |`);
    }
  }
  return out.join("\n");
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// docs/public/roadmap.yml: a YAML list of flat items, parsed by this small
// reader (no dependency), which accepts only that shape and fails loudly on
// anything else:
//
//   - title: Shared connections        # a comment
//     summary: "Quoted if it has a colon: like this"
//     status: planned
//
// Keys: title, summary, status (shipped, in-progress, planned, considering),
// and optionally milestone (M1 to M7), issue (a number), docs (a docs page's
// slug, like concepts/variables) and version (the release it shipped in).
export const ROADMAP_STATUSES = ["shipped", "in-progress", "planned", "considering"];
const ROADMAP_KEYS = ["title", "summary", "status", "milestone", "issue", "docs", "version"];

function yamlScalar(raw, where) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const q = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(v);
    if (!q) throw new Error(`${where}: a double-quoted value must close on the same line`);
    return JSON.parse(q[1]);
  }
  if (v.startsWith("'")) {
    const q = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(v);
    if (!q) throw new Error(`${where}: a single-quoted value must close on the same line`);
    return q[1].replaceAll("''", "'");
  }
  const plain = v.replace(/\s+#.*$/, "");
  if (/^[&*!|>%@`]/.test(plain) || /:\s/.test(plain) || plain.endsWith(":")) {
    throw new Error(`${where}: quote this value ("...")`);
  }
  return plain;
}

export function parseRoadmap(text) {
  const items = [];
  let cur = null;
  text.split("\n").forEach((line, i) => {
    const where = `roadmap.yml line ${i + 1}`;
    if (/^\s*(#.*)?$/.test(line)) return;
    const m = /^(- |  )([a-z_]+):(?:\s+(.*))?$/.exec(line.replace(/\r$/, ""));
    if (!m) throw new Error(`${where}: expected "- key: value" or "  key: value"`);
    if (m[1] === "- ") {
      cur = {};
      items.push(cur);
    } else if (!cur) {
      throw new Error(`${where}: a key before the first "- "`);
    }
    const key = m[2];
    if (!ROADMAP_KEYS.includes(key)) throw new Error(`${where}: unknown key ${key} (${ROADMAP_KEYS.join(", ")})`);
    if (key in cur) throw new Error(`${where}: ${key} given twice`);
    cur[key] = yamlScalar(m[3] ?? "", where);
  });
  return items;
}

// Every problem with the roadmap, as sentences; [] when it's valid.
// `slugs`: the docs pages that exist.
export function roadmapProblems(items, slugs) {
  const problems = [];
  const titles = new Set();
  items.forEach((it, i) => {
    const name = it.title ? `"${it.title}"` : `item ${i + 1}`;
    if (!it.title) problems.push(`${name} has no title`);
    else if (titles.has(it.title.toLowerCase())) problems.push(`${name} is listed twice`);
    titles.add(String(it.title ?? "").toLowerCase());
    if (!it.summary) problems.push(`${name} has no summary`);
    else if (it.summary.length > 200) problems.push(`${name}: keep the summary to one line (200 characters)`);
    if (!ROADMAP_STATUSES.includes(it.status)) problems.push(`${name}: status must be one of ${ROADMAP_STATUSES.join(", ")}`);
    if (it.milestone !== undefined && !/^M[1-7]$/.test(it.milestone)) problems.push(`${name}: milestone must be M1 to M7`);
    if (it.issue !== undefined && !/^[1-9][0-9]*$/.test(it.issue)) problems.push(`${name}: issue must be a number`);
    if (it.docs !== undefined && !slugs.includes(it.docs)) problems.push(`${name}: docs page ${it.docs} doesn't exist`);
    if (it.version !== undefined && !/^\d+\.\d+\.\d+$/.test(it.version)) problems.push(`${name}: version must look like 0.1.0`);
    if (it.version !== undefined && it.status !== "shipped") problems.push(`${name}: only a shipped item has a version`);
  });
  return problems;
}

const ROADMAP_HEADINGS = { shipped: "Shipped", "in-progress": "In progress", planned: "Planned", considering: "Considering" };
export const roadmapHeading = (status) => ROADMAP_HEADINGS[status];

// The roadmap as Markdown, for the docs page and agents: a section per
// status, an item per line. `docsLink(slug)` makes a link to a docs page
// relative to the page it lands on.
export function roadmapMarkdown(items, docsLink) {
  const out = [];
  for (const status of ROADMAP_STATUSES) {
    const list = items.filter((it) => it.status === status);
    out.push(`## ${ROADMAP_HEADINGS[status]}`, "");
    if (!list.length) out.push("Nothing here yet.", "");
    for (const it of list) {
      const meta = [
        it.milestone ? `milestone ${it.milestone.slice(1)}` : "",
        it.version ? `in ${it.version}` : "",
        it.issue ? `issue #${it.issue}` : "",
        it.docs ? `[docs](${docsLink(it.docs)})` : "",
      ].filter(Boolean);
      out.push(`- **${it.title}.** ${it.summary}${meta.length ? ` (${meta.join(", ")})` : ""}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}
