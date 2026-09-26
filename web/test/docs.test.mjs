// The public docs (web/src/docs.ts, built by scripts/gen-docs.mjs from
// docs/public), the roadmap, llms.txt, and the checks that keep the docs in
// step with the code: every MCP tool in the contract, every CLI command and
// option, every link and anchor, every page in the sidebar, every feature
// row's docs page. Reads the checkout at REPO_DIR (web/test.sh mounts it);
// seeds nothing and writes nothing.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { before, test } from "node:test";
import { cliDefinitions, parseRoadmap, parseSummary, roadmapProblems } from "../scripts/docs-lib.mjs";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, LOGIN_FILE } = process.env;
const REPO = process.env.REPO_DIR ?? new URL("../..", import.meta.url).pathname;
const BUILD = new URL("../docs-build/", import.meta.url).pathname;
const SRC = join(REPO, "docs/public");
// The local instance has no PUBLIC_URL: its absolute links use the default.
const LOCAL_ORIGIN = "https://reliquary.redmage.cc";
const PRE_ALPHA = "things change and may break; data is backed up daily.";

const manifest = JSON.parse(readFileSync(join(BUILD, "manifest.json"), "utf8"));
const pages = manifest.sections.flatMap((s) => s.pages);
const slugs = pages.map((p) => p.slug);
const urlOf = (slug) => (slug === "index" ? "/docs" : `/docs/${slug}`);

let cookie = "";
before(async () => {
  assert.ok(existsSync(join(REPO, "docs/public/SUMMARY.md")), "REPO_DIR must be the checkout (web/test.sh mounts it)");
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

const get = (path, base = BASE, headers = {}) => fetch(base + path, { redirect: "manual", headers });
const cache = new Map();
async function html(path) {
  if (!cache.has(path)) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    cache.set(path, await r.text());
  }
  return cache.get(path);
}
const unescape = (s) => s.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const escapeHtml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const article = (h) => /<article class="docs-article">([\s\S]*?)<\/article>/.exec(h)[1];
const ids = (h) => new Set([...h.matchAll(/\bid="([^"]+)"/g)].map((m) => unescape(m[1])));
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)).map((f) => `${n}/${f}`) : [n]));

// Pages -------------------------------------------------------------------------------

test("docs pages: /docs is the docs home, public and indexable, with a sidebar naming every page", async () => {
  const r = await get("/docs");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  const terms = await get("/terms");
  for (const name of ["content-security-policy", "x-content-type-options", "referrer-policy"]) {
    assert.equal(r.headers.get(name), terms.headers.get(name), name);
  }
  const h = await r.text();
  assert.doesNotMatch(h, /noindex/);
  assert.doesNotMatch(h, /<script/i);
  assert.match(h, /<h1 id="reliquary-docs">Reliquary docs<\/h1>/);
  const side = /<div class="docs-side"><nav aria-label="Docs">([\s\S]*?)<\/nav>/.exec(h)[1];
  const linked = [...side.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(linked, slugs.map(urlOf), "the sidebar lists every page, in SUMMARY.md's order");
  assert.match(side, /<a href="\/docs" aria-current="page">Overview<\/a>/);
  assert.match(h, /<link rel="alternate" type="text\/markdown" href="\/docs\/index\.md">/);
});

test("docs pages: every page renders its title, marks itself current, and links prev and next in sidebar order", async () => {
  for (const [i, p] of pages.entries()) {
    const h = await html(urlOf(p.slug));
    assert.match(h, new RegExp(`<h1 id="[^"]+">${escapeHtml(p.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`), p.slug);
    assert.match(h, new RegExp(`<title>${escapeHtml(p.title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `), p.slug);
    assert.ok(h.includes(`<a href="${urlOf(p.slug)}" aria-current="page">`), `${p.slug} marked current`);
    const pager = /<nav class="docs-pager"[\s\S]*?<\/nav>/.exec(h)?.[0] ?? "";
    if (i > 0) assert.match(pager, new RegExp(`class="docs-prev" href="${urlOf(pages[i - 1].slug)}" rel="prev"`), p.slug);
    else assert.doesNotMatch(pager, /docs-prev/);
    if (i < pages.length - 1) assert.match(pager, new RegExp(`class="docs-next" href="${urlOf(pages[i + 1].slug)}" rel="next"`), p.slug);
    else assert.doesNotMatch(pager, /docs-next/);
    assert.doesNotMatch(h, /<script/i, p.slug);
    assert.doesNotMatch(h, /noindex/, p.slug);
  }
});

test("docs pages: the on-page contents list each page's h2 and h3 headings, and each resolves", async () => {
  let withToc = 0;
  for (const p of pages) {
    const h = await html(urlOf(p.slug));
    const heads = [...article(h).matchAll(/<h([23]) id="([^"]+)">/g)];
    const toc = /<aside class="docs-toc">([\s\S]*?)<\/aside>/.exec(h)?.[1];
    if (heads.length < 2) {
      assert.equal(toc, undefined, `${p.slug}: no contents for fewer than two headings`);
      continue;
    }
    withToc++;
    const links = [...toc.matchAll(/<li class="toc-([23])"><a href="#([^"]+)">/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links, heads.map((m) => [m[1], m[2]]), p.slug);
  }
  assert.ok(withToc > 10, "most pages have contents");
});

test("docs pages: unknown or crafted paths are 404, and never reach the filesystem", async () => {
  // Sent as written (fetch would fold `..` and `%2e%2e` itself).
  const raw = (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(BASE);
      http
        .get({ host: u.hostname, port: u.port, path }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .on("error", reject);
    });
  for (const path of ["/docs/nope", "/docs/concepts", "/docs/concepts/", "/docs/index", "/docs/..%2fpackage.json", "/docs/manifest.json",
    "/docs/manifest.md", "/docs/roadmap.yml", "/docs/reference/mcp-access.json", "/docs/SUMMARY.md", "/docs//etc/passwd"]) {
    const r = await raw(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.body, /"sections"|"dependencies"|root:/, path);
  }
  // Dot segments leave /docs before routing: then it's not a docs path at all.
  for (const path of ["/docs/../package.json", "/docs/%2e%2e/package.json", "/docs/../../etc/passwd.md"]) {
    const r = await raw(path);
    assert.notEqual(r.status, 200, path);
    assert.doesNotMatch(r.body, /"sections"|"dependencies"|root:/, path);
  }
  const h = await (await get("/docs/nope")).text();
  assert.match(h, /<h1>Page not found<\/h1>/);
  assert.match(h, /<nav aria-label="Docs">/, "the 404 keeps the sidebar");
});

test("docs pages: a POST to a docs page is not served as the page", async () => {
  const r = await fetch(BASE + "/docs", { method: "POST", redirect: "manual" });
  assert.notEqual(r.status, 200);
});

// For agents -----------------------------------------------------------------------------

test("docs for agents: every page is served as its built Markdown at /docs/<slug>.md", async () => {
  for (const p of pages) {
    const r = await get(`/docs/${p.slug}.md`);
    assert.equal(r.status, 200, p.slug);
    assert.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8", p.slug);
    assert.equal(await r.text(), readFileSync(join(BUILD, `${p.slug}.md`), "utf8"), p.slug);
  }
  assert.doesNotMatch(await (await get("/docs/reference/mcp-tools.md")).text(), /<!-- generated:/, "markers are replaced");
});

test("docs for agents: /llms.txt names every page with its summary and Markdown URL", async () => {
  const r = await get("/llms.txt");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/plain/);
  const t = await r.text();
  assert.match(t, /^# Reliquary\n\n> .+\n/);
  for (const p of pages) assert.ok(t.includes(`- [${p.title}](${LOCAL_ORIGIN}/docs/${p.slug}.md): ${p.summary}`), p.slug);
  assert.match(t, /^## Optional$/m, "the last section is optional");
});

test("docs for agents: /llms-full.txt holds every page, with absolute links", async () => {
  const t = await (await get("/llms-full.txt")).text();
  for (const p of pages) {
    assert.ok(t.includes(`<!-- ${LOCAL_ORIGIN}${urlOf(p.slug)} -->`), p.slug);
    assert.ok(t.includes(`# ${p.title}\n`), p.slug);
  }
  assert.doesNotMatch(t, /\]\((?!https?:|mailto:|#)[^)]*\)/, "every link is absolute");
  assert.match(t, new RegExp(`\\]\\(${LOCAL_ORIGIN}/docs/concepts/agents\\.md\\)`));
});

// Drift: the MCP tool reference ---------------------------------------------------------------

test("docs mcp: every tool in the contract has a section with its title, description, arguments and who may call it", async () => {
  const tools = JSON.parse(readFileSync(join(REPO, "mcp/test/contract.snapshot.json"), "utf8"));
  const access = JSON.parse(readFileSync(join(SRC, "reference/mcp-access.json"), "utf8"));
  const h = article(await html("/docs/reference/mcp-tools"));
  const found = ids(h);
  for (const t of tools) {
    assert.ok(found.has(t.name), `${t.name} has a section`);
    const section = h.split(`<h2 id="${t.name}">`)[1].split("<h2 ")[0];
    // As read: tags dropped, entities decoded, Markdown's backticks gone.
    const read = unescape(section.replace(/<[^>]+>/g, ""));
    const plain = (s) => s.replaceAll("`", "");
    assert.ok(read.includes(plain(t.title)), `${t.name} title`);
    assert.ok(read.includes(plain(t.description)), `${t.name} description`);
    assert.ok(read.includes(plain(access[t.name])), `${t.name} who may call it`);
    for (const arg of Object.keys(t.inputSchema.properties ?? {})) assert.ok(section.includes(`<code>${arg}</code>`), `${t.name} ${arg}`);
    assert.ok(section.includes(t.annotations?.readOnlyHint ? "yes, it changes nothing" : "no, it can change the vault"), `${t.name} read-only`);
  }
  assert.deepEqual(Object.keys(access).sort(), tools.map((t) => t.name).sort(), "mcp-access.json names exactly the contract's tools");
  assert.match(h, /<h2 id="data-fencing">Data fencing<\/h2>/);
});

// Drift: the CLI reference ------------------------------------------------------------------------

const cli = () => cliDefinitions(readFileSync(join(REPO, "cli/src/cli.ts"), "utf8"), readFileSync(join(REPO, "cli/src/config.ts"), "utf8"));

test("docs cli: every command and option the CLI defines is in the CLI reference", () => {
  const { commands, options } = cli();
  assert.deepEqual(commands, ["login", "logout", "vaults", "run", "env pull", "env push"], "the commands the CLI's help lists");
  const md = readFileSync(join(SRC, "reference/cli.md"), "utf8");
  for (const c of commands) assert.match(md, new RegExp(`^### reliquary ${c}$`, "m"), `reliquary ${c} has a section`);
  for (const o of options) assert.match(md, new RegExp(`\`--${o}(?![a-z-])`), `--${o} is documented`);
});

test("docs cli: the CLI reference and how-to name no command or option the CLI doesn't have", () => {
  const { commands, options } = cli();
  let checked = 0;
  for (const file of walk(SRC).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(join(SRC, file), "utf8");
    // Every command line in code: a code block's lines, or an inline span,
    // that starts with `reliquary ` or `npx @reliquary-ai/cli `.
    const spans = [...md.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].flatMap((m) => m[0].replace(/^`+[a-z]*|`+$/g, "").split("\n"));
    for (const line of spans.map((l) => l.trim())) {
      const m = /^(?:reliquary|npx @reliquary-ai\/cli) ([a-z]+)(?: ([a-z]+))?/.exec(line);
      if (!m) continue;
      checked++;
      const cmd = m[1] === "env" ? `env ${m[2]}` : m[1];
      assert.ok(commands.includes(cmd), `${file}: \`${line}\`: reliquary ${cmd} isn't a command`);
      for (const o of line.matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)) assert.ok(options.includes(o[1]), `${file}: \`${line}\`: --${o[1]} isn't an option`);
    }
  }
  assert.ok(checked >= 10, `checked ${checked} command lines`);
});

test("docs cli: the CLI reference shows the CLI's own help text", async () => {
  const h = await html("/docs/reference/cli");
  const blocks = [...h.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) => unescape(m[1]));
  assert.ok(blocks.some((b) => b.trimEnd() === cli().help.trimEnd()), "the help, verbatim");
});

// Links and the sidebar ----------------------------------------------------------------------------

test("docs links: every link and anchor in every page resolves", async () => {
  const other = new Set();
  for (const p of pages) {
    const h = article(await html(urlOf(p.slug)));
    for (const [, raw] of h.matchAll(/<a href="([^"]*)"/g)) {
      const href = unescape(raw);
      if (/^(https?:|mailto:)/.test(href)) continue;
      assert.ok(href.startsWith("/") || href.startsWith("#"), `${p.slug}: relative link left as ${href}`);
      const [path, anchor] = href.split("#");
      if (path === "" || path === "/docs" || path.startsWith("/docs/")) {
        const target = path === "" ? p.slug : path === "/docs" ? "index" : path.slice(6);
        if (target.endsWith(".md")) {
          assert.ok(slugs.includes(target.slice(0, -3)), `${p.slug}: ${href} is no page's Markdown`);
          continue;
        }
        assert.ok(slugs.includes(target), `${p.slug}: ${href} is no page`);
        if (anchor) assert.ok(ids(await html(urlOf(target))).has(anchor), `${p.slug}: ${href} has no such anchor`);
      } else {
        other.add(path);
      }
    }
  }
  for (const path of other) {
    const r = await get(path, BASE, { cookie });
    assert.equal(r.status, 200, `${path} (linked from the docs)`);
  }
});

test("docs links: every page in docs/public is in the sidebar, and the sidebar names no missing page", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".md") && f !== "SUMMARY.md").sort();
  const listed = parseSummary(readFileSync(join(SRC, "SUMMARY.md"), "utf8")).flatMap((s) => s.pages.map((p) => p.file)).sort();
  assert.deepEqual(listed, files);
  assert.deepEqual(slugs.slice().sort(), files.map((f) => f.slice(0, -3)).sort(), "the build serves exactly those pages");
});

// Nav, sitemap and the stage ---------------------------------------------------------------------

test("docs nav: the public site links Docs and Roadmap, and the app's Account menu links both", async () => {
  const site = await (await get("/", A)).text();
  const nav = /<nav aria-label="Site">([\s\S]*?)<\/nav>/.exec(site)[1];
  assert.match(nav, /<a href="\/docs">Docs<\/a>/);
  assert.match(nav, /<a href="\/roadmap">Roadmap<\/a>/);
  assert.match(await html("/docs/concepts/agents"), /<a href="\/docs" aria-current="page">Docs<\/a>/);
  const app = await (await get("/", BASE, { cookie })).text();
  const menu = /<details class="account menu-wrap">([\s\S]*?)<\/details>/.exec(app)[1];
  assert.match(menu, /<a href="\/docs">Docs<\/a>/);
  assert.match(menu, /<a href="\/roadmap">Roadmap<\/a>/);
});

test("docs nav: the sitemap lists the roadmap and every docs page at PUBLIC_URL", async () => {
  const origin = new URL(PUBLIC_URL).origin;
  const locs = [...(await (await get("/sitemap.xml", A)).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const path of ["/roadmap", ...slugs.map(urlOf)]) assert.ok(locs.includes(origin + path), path);
});

test("stage: the landing page, the docs, the roadmap and the app say pre-alpha", async () => {
  const badge = /<a class="stage" href="\/roadmap" title="Pre-alpha: things change and may break; data is backed up daily\.">Pre-alpha<\/a>/;
  const landing = await (await get("/", A)).text();
  assert.match(landing, badge);
  assert.ok(landing.includes(`<strong>Pre-alpha:</strong> ${PRE_ALPHA}`), "the landing page says it in full");
  const docs = await html("/docs/concepts/vaults-and-files");
  assert.match(docs, badge);
  assert.ok(docs.includes(`<strong>Pre-alpha:</strong> ${PRE_ALPHA}`), "the docs say it in full");
  assert.ok((await html("/roadmap")).includes(`Pre-alpha: ${PRE_ALPHA}`), "the roadmap says it in full");
  const app = await (await get("/inbox", BASE, { cookie })).text();
  assert.match(app, badge);
  assert.ok(app.includes(`Pre-alpha: ${PRE_ALPHA}`), "the Account menu says it in full");
});

// Changelog -------------------------------------------------------------------------------------------

test("docs changelog: /docs/changelog renders CHANGELOG.md, or says there are no releases yet", async () => {
  const h = article(await html("/docs/changelog"));
  const file = join(REPO, "CHANGELOG.md");
  if (!existsSync(file)) {
    assert.match(h, /<p>No releases yet\.<\/p>/);
    return;
  }
  const release = /^##\s+(.+)$/m.exec(readFileSync(file, "utf8"));
  if (!release) {
    assert.match(h, /<p>No releases yet\.<\/p>/);
    return;
  }
  const text = release[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "");
  assert.ok(unescape(h.replace(/<[^>]+>/g, "")).includes(text.trim()), `the newest release, ${text}`);
});

// Roadmap -----------------------------------------------------------------------------------------------

const roadmap = () => parseRoadmap(readFileSync(join(SRC, "roadmap.yml"), "utf8"));

test("roadmap: roadmap.yml validates: statuses, milestones, versions, docs pages that exist, no duplicate titles", () => {
  const items = roadmap();
  assert.ok(items.length > 10);
  assert.deepEqual(roadmapProblems(items, slugs), []);
  for (const status of ["shipped", "in-progress", "planned", "considering"]) assert.ok(items.some((it) => it.status === status), status);
  for (const it of items.filter((i) => i.status === "shipped" && i.docs)) assert.ok(slugs.includes(it.docs), `${it.title}: ${it.docs}`);
});

test("roadmap: the validator refuses a bad status, an unknown page, a duplicate, a bad milestone and a version on unshipped work", () => {
  const problems = roadmapProblems(
    [
      { title: "A", summary: "s", status: "done" },
      { title: "B", summary: "s", status: "shipped", docs: "concepts/nope" },
      { title: "b", summary: "s", status: "planned", milestone: "M9", version: "1.0.0" },
      { title: "C", status: "planned", issue: "x" },
    ],
    slugs,
  );
  for (const want of [/"A": status/, /"B": docs page concepts\/nope/, /"b" is listed twice/, /"b": milestone/, /"b": only a shipped item/, /"C" has no summary/, /"C": issue/]) {
    assert.ok(problems.some((p) => want.test(p)), String(want));
  }
  assert.throws(() => parseRoadmap("- title: x\n  colour: red\n"), /unknown key colour/);
  assert.throws(() => parseRoadmap("- title: a: b\n"), /quote this value/);
  assert.throws(() => parseRoadmap("title: x\n"), /expected/);
  assert.deepEqual(parseRoadmap('# c\n- title: "a: b" # note\n  status: planned\n'), [{ title: "a: b", status: "planned" }]);
});

test("roadmap: /roadmap shows four columns with every item, public and indexable, with a way to suggest a feature", async () => {
  const r = await get("/roadmap");
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.doesNotMatch(h, /noindex|<script/i);
  const items = roadmap();
  const labels = { shipped: "Shipped", "in-progress": "In progress", planned: "Planned", considering: "Considering" };
  for (const [status, label] of Object.entries(labels)) {
    const col = new RegExp(`<section class="roadmap-col" aria-labelledby="rm-${status}">([\\s\\S]*?)</section>`).exec(h)?.[1];
    assert.ok(col, status);
    const list = items.filter((it) => it.status === status);
    assert.match(col, new RegExp(`<h2 id="rm-${status}">${label} <span class="count">${list.length}</span></h2>`));
    for (const it of list) assert.ok(col.includes(`<h3>${escapeHtml(it.title)}</h3>`), it.title);
  }
  assert.match(h, /<a class="button primary" href="mailto:andres@redmage\.cc\?subject=Reliquary%20feature%20suggestion">Suggest a feature<\/a>/);
  assert.match(h, /<a href="\/roadmap" aria-current="page">Roadmap<\/a>/);
});

test("roadmap: every shipped item links to its docs page and the changelog", async () => {
  const h = await html("/roadmap");
  for (const it of roadmap().filter((i) => i.status === "shipped")) {
    const li = h.split(`<h3>${escapeHtml(it.title)}</h3>`)[1].split("</li>")[0];
    if (it.docs) assert.ok(li.includes(`<a href="${urlOf(it.docs)}">Docs</a>`), it.title);
    assert.ok(li.includes('<a href="/docs/changelog">Changelog</a>'), it.title);
  }
});

test("roadmap: /roadmap.md and /docs/roadmap serve the same items for agents", async () => {
  const r = await get("/roadmap.md");
  assert.equal(r.headers.get("content-type"), "text/markdown; charset=utf-8");
  const md = await r.text();
  for (const it of roadmap()) assert.ok(md.includes(`- **${it.title}.** ${it.summary}`), it.title);
  assert.doesNotMatch(md, /\]\((?!https?:|mailto:)[^)]*\)/, "links are absolute");
  assert.ok((await (await get("/llms.txt")).text()).includes(`${LOCAL_ORIGIN}/docs/roadmap.md`));
});

// The registry and copy ------------------------------------------------------------------------------------

test("docs registry: every feature row in tests/features.md names a docs page that exists", () => {
  const rows = readFileSync(join(REPO, "tests/features.md"), "utf8").split("\n").filter((l) => /^\| F\d+ \|/.test(l));
  assert.ok(rows.length > 100);
  for (const row of rows) {
    const cells = row.split(" | ");
    const docs = [...cells[cells.length - 1].matchAll(/`docs\/public\/([^`]+)\.md`/g)].map((m) => m[1]);
    assert.ok(docs.length, `${cells[0]} names no docs page`);
    for (const d of docs) assert.ok(slugs.includes(d), `${cells[0]}: docs/public/${d}.md doesn't exist`);
  }
});

test("docs copy: no em dashes, and nothing shaped like a token or key", () => {
  for (const f of walk(SRC)) {
    const text = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(text, /—/, `${f}: em dash`);
    assert.doesNotMatch(text, /\brl[qoerli]_[0-9a-f]{16,}|sb_secret_|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY/, `${f}: looks like a secret`);
  }
});
