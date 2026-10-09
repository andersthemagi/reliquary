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
      out.push(`| \`${name}\` | ${p.type ?? ""} | ${required.has(name) ? "yes" : "no"} | ${cell(limits(p))} | ${cell(p.description ?? "")} |`);
    }
  }
  return out.join("\n");
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
