// The app's shell (html.ts, inbox.ts, search.ts, settings.ts;
// 20260926100000_shell_inbox.sql): the top bar with its nav, vault switcher,
// search, inbox and account menu; the Inbox page; Home without empty
// sections; searching every vault; Account settings with a display name;
// and what the top bar costs a page. The database rules are in
// supabase/tests/shell_inbox_test.sql.
//
// This file starts its own servers from dist/ (local sign-in), one per
// person, none of whom any other test file uses: Dora owns "Shell Studio"
// (Eli edits) and "Shell Quiet"; Fay has an account and no vault; Gus owns
// "Shell Gus private".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const DORA = "d1000000-0000-0000-0000-0000000000d1";
const ELI = "d2000000-0000-0000-0000-0000000000d2";
const FAY = "d3000000-0000-0000-0000-0000000000d3";
const GUS = "d4000000-0000-0000-0000-0000000000d4";

const servers = [];
const V = {};
const S = {};
let plan = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

async function as(user, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function startAs(user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/shell-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { origin, cookie: "", log: "" };
  child.stdout.on("data", (d) => (s.log += d));
  child.stderr.on("data", (d) => (s.log += d));
  servers.push({ child, s });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (who, path) => fetch(S[who].origin + path, { headers: { cookie: S[who].cookie }, redirect: "manual" });
const page = async (who, path) => (await get(who, path)).text();
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
const post = async (who, path, fields, csrf = true) =>
  fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: new URLSearchParams({ ...(csrf ? { csrf: await csrfOf(who) } : {}), ...fields }).toString(),
  });
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  return (/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "").replace(/ \(ref [0-9a-f]{8}\)$/, "");
};
// The top bar, the main nav (without the switcher's menu), the inbox and the account menu.
const bar = (h) => /<header class="top app-top">[\s\S]*?<\/header>/.exec(h)[0];
const mainNav = (h) => /<nav class="app-nav" aria-label="Main">([\s\S]*?)<\/nav>/.exec(h)[1];
const inboxMenu = (h) => /<details class="menu-wrap inbox">([\s\S]*?)<\/details>/.exec(h)[1];
const accountMenu = (h) => /<details class="account menu-wrap">([\s\S]*?)<\/details>/.exec(h)[1];
const badge = (h) => /aria-label="Inbox, (\d+) waiting"/.exec(bar(h))?.[1] ?? "0";

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'dora@example.test'), ($2, 'eli@example.test'),
       ($3, 'fay@example.test'), ($4, 'gus@example.test') on conflict (id) do nothing`,
    [DORA, ELI, FAY, GUS],
  );
  [{ id: V.studio }] = await as(DORA, "select public.create_vault('Shell Studio') as id");
  [{ id: V.quiet }] = await as(DORA, "select public.create_vault('Shell Quiet') as id");
  [{ id: V.gus }] = await as(GUS, "select public.create_vault('Shell Gus private') as id");
  await as(DORA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.studio]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.studio, ELI, DORA]);
  await as(DORA, "select public.write_file($1, 'notes/zebra.md', 'Zebra stripes, by Dora.')", [V.studio]);
  await as(GUS, "select public.write_file($1, 'notes/zebra-gus.md', 'Zebra, but private to Gus.')", [V.gus]);
  S.dora = await startAs(DORA);
  S.eli = await startAs(ELI);
  S.fay = await startAs(FAY);
  S.gus = await startAs(GUS);
});

after(async () => {
  for (const { child } of servers) child.kill();
  for (const [who, id, name] of [[DORA, V.studio, "Shell Studio"], [DORA, V.quiet, "Shell Quiet"], [GUS, V.gus, "Shell Gus private"]]) {
    await as(who, "select public.delete_vault($1, $2)", [id, name]).catch(() => {});
  }
  // Notices of those deletions would otherwise wait for Eli.
  await sql("delete from private.vault_deletion_notices where user_id = any($1)", [[DORA, ELI, FAY, GUS]]);
});

// ---------------------------------------------------------------------------
// The top bar

test("shell: the top bar has Home, the vault switcher, Activity, Connect and Docs, then search, the inbox and the account menu", async () => {
  const h = bar(await page("dora", "/"));
  const nav = mainNav(h).replace(/<details[\s\S]*?<\/details>/g, "[switcher]");
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"|\[switcher\]/g)].map((m) => m[1] ?? "switcher"), ["/", "switcher", "/activity", "/connect", "/docs"]);
  assert.match(nav, /<a href="\/" aria-current="page">Home<\/a>/);
  const order = ['<nav class="app-nav"', 'action="/search"', '<details class="menu-wrap inbox">', '<details class="account menu-wrap">'].map((s) => h.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `in order: ${order}`);
  assert.match(h, /<form class="top-search" method="get" action="\/search" role="search">/);
  assert.match(h, /<label class="sr-only" for="top-q">Search your vaults<\/label>/);
  assert.doesNotMatch(h, /href="\/review"/);
});

test("shell: the vault switcher lists only my vaults, and names and marks the one I'm in", async () => {
  const h = mainNav(bar(await page("dora", `/v/${V.studio}`)));
  assert.match(h, /<summary aria-current="page"><span class="vault-switch-label">Shell Studio<\/span><\/summary>/);
  assert.match(h, new RegExp(`<a href="/v/${V.studio}" aria-current="page"><span class="menu-item-title">Shell Studio</span><span class="menu-item-meta">owner</span></a>`));
  assert.match(h, new RegExp(`<a href="/v/${V.quiet}"><span class="menu-item-title">Shell Quiet</span>`));
  assert.doesNotMatch(h, /Shell Gus private/);
  assert.match(h, /<a href="\/vaults\/new">New vault<\/a>/);
  assert.match(mainNav(bar(await page("dora", "/activity"))), /<span class="vault-switch-label">Vaults<\/span>/);
  assert.doesNotMatch(mainNav(bar(await page("fay", "/"))), /vault-switch/, "no vaults, no switcher");
});

test("shell: with nothing waiting, the inbox has no count and says so, and Home shows no review section", async () => {
  const h = await page("dora", "/");
  assert.match(bar(h), /<summary class="button quiet icon-button" aria-label="Inbox, nothing waiting">/);
  assert.doesNotMatch(inboxMenu(h), /class="count"/);
  assert.match(inboxMenu(h), /Nothing needs you\./);
  assert.doesNotMatch(h, /Needs your review|Nothing is waiting on you|Review \d+ waiting/);
  assert.match(h, /<h2>Your vaults<\/h2>/);
  assert.match(await page("dora", "/inbox"), /<div class="empty"><strong>Nothing needs you\.<\/strong>/);
});

test("shell: a proposal waiting on me is in the count, the menu, Home and the Inbox; snoozing it takes it out", async () => {
  [{ id: plan }] = await as(ELI, "select public.propose($1, 'canon/plan.md', 'The plan.', 'a plan') as id", [V.studio]);
  const h = await page("dora", "/");
  assert.equal(badge(h), "1");
  assert.match(bar(h), /<span class="count" aria-hidden="true">1<\/span>/);
  assert.match(inboxMenu(h), new RegExp(`<a href="/v/${V.studio}/proposals/${plan}"><span class="menu-item-title">Create canon/plan\\.md</span><span class="menu-item-meta">Review · Shell Studio · just now</span></a>`));
  assert.match(inboxMenu(h), /<a href="\/inbox">View all<\/a>/);
  assert.match(h, /<h2>Needs your review<\/h2>/);
  assert.match(h, /<a class="button" href="\/inbox">Review 1 waiting<\/a>/);
  assert.match(await page("dora", "/inbox"), /<h2>Shell Studio<\/h2><ul class="rows review-rows">/);
  await as(DORA, "select public.snooze_proposal($1)", [plan]);
  const after = await page("dora", "/");
  assert.equal(badge(after), "0");
  assert.doesNotMatch(after, /Needs your review/);
  await as(DORA, "select public.unsnooze_proposal($1)", [plan]);
  assert.equal(badge(await page("dora", "/")), "1");
});

test("shell: my proposal sent back with changes requested is in my inbox, linking to it", async () => {
  await as(DORA, "select public.decide($1, 'request_changes', 'Say when.')", [plan]);
  const h = await page("eli", "/inbox");
  assert.equal(badge(h), "1");
  assert.match(inboxMenu(h), new RegExp(`<a href="/v/${V.studio}/proposals/${plan}"><span class="menu-item-title">Revise canon/plan\\.md</span><span class="menu-item-meta">Changes requested · Shell Studio · `));
  assert.match(h, /<h2 id="revise">Changes requested on your proposals<\/h2>/);
  assert.match(h, new RegExp(`<a class="name" href="/v/${V.studio}/proposals/${plan}">Create canon/plan\\.md</a>`));
  assert.equal(badge(await page("dora", "/")), "0", "no longer waiting on the reviewer");
});

test("shell: an invite to my address is in my inbox and on Home, and in nobody else's", async () => {
  await as(DORA, "select public.create_invite($1, 'fay@example.test', 'viewer')", [V.studio]);
  const home = await page("fay", "/");
  assert.equal(badge(home), "1");
  assert.match(inboxMenu(home), /<a href="\/inbox#invites"><span class="menu-item-title">Invite to Shell Studio as viewer<\/span><span class="menu-item-meta">From dora@example\.test · just now<\/span><\/a>/);
  assert.match(home, /You have an invite waiting: <a href="\/inbox#invites">see your inbox<\/a>\./);
  const inbox = await page("fay", "/inbox");
  assert.match(inbox, /<h2 id="invites">Invites<\/h2>/);
  assert.match(inbox, /<span class="name">Shell Studio<\/span>\s*<span class="muted small"> · as viewer · from dora@example\.test · expires in 7 days<\/span>/);
  assert.equal(badge(await page("gus", "/")), "0");
  assert.doesNotMatch(await page("gus", "/inbox"), /Shell Studio/);
});

test("shell: a vault deletion notice is counted until the Inbox shows it, then gone", async () => {
  const [{ id }] = await as(DORA, "select public.create_vault('Shell Doomed') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [id, ELI, DORA]);
  await as(DORA, "select public.delete_vault($1, 'Shell Doomed')", [id]);
  const h = await page("eli", "/settings");
  assert.equal(badge(h), "2", "the notice and the proposal to revise");
  assert.match(inboxMenu(h), /<a href="\/inbox#notices"><span class="menu-item-title">Shell Doomed was deleted<\/span><span class="menu-item-meta">By dora@example\.test · just now<\/span><\/a>/);
  assert.match(await page("eli", "/settings"), /Shell Doomed was deleted/, "still there: only a page that shows it takes it");
  assert.match(await page("eli", "/inbox"), /<div id="notices"><p class="callout attention" role="status"><strong>Shell Doomed<\/strong> was deleted by dora@example\.test/);
  const later = await page("eli", "/inbox");
  assert.doesNotMatch(later, /Shell Doomed/);
  assert.equal(badge(later), "1");
});

test("shell: old Review links land on the Inbox, query and all", async () => {
  const r = await get("dora", "/review?snoozed=1");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/inbox?snoozed=1");
  assert.match(await page("dora", "/inbox"), /<h1>Inbox<\/h1>/);
});

// ---------------------------------------------------------------------------
// Search

test("search: the top bar searches every vault I'm in, and nothing else", async () => {
  const h = await page("dora", "/search?q=zebra");
  assert.match(h, /<h1>Search<\/h1>/);
  assert.match(bar(h), /<input id="top-q" type="search" name="q" placeholder="Search vaults" value="zebra"/);
  assert.match(h, new RegExp(`<a class="name" href="/v/${V.studio}/file\\?path=notes%2Fzebra\\.md">notes/zebra\\.md</a>`));
  assert.match(h, /<span class="muted small"> · Shell Studio<\/span>/);
  assert.doesNotMatch(h, /zebra-gus|private to Gus|Shell Gus private/);
  assert.match(h, /1 result for “zebra” in 1 vault/);
  const gus = await page("gus", "/search?q=zebra");
  assert.match(gus, /notes\/zebra-gus\.md/);
  assert.doesNotMatch(gus, /Zebra stripes|Shell Studio/);
});

test("search: no query shows the form; no match says so", async () => {
  const empty = await page("dora", "/search");
  assert.match(empty, /<form class="search-page" method="get" action="\/search" role="search">/);
  assert.doesNotMatch(empty, /class="rows results"|Nothing in your vaults/);
  assert.match(await page("dora", "/search?q=nothing-matches-this"), /Nothing in your vaults matches “nothing-matches-this”/);
});

// ---------------------------------------------------------------------------
// Account settings

test("settings: the page shows my email, the theme, and links to Plan and usage, Connections and Connect", async () => {
  const h = await page("dora", "/settings");
  assert.match(h, /<h1>Account settings<\/h1>/);
  assert.match(h, /<strong>dora@example\.test<\/strong>/);
  assert.match(h, /<input id="display-name" type="text" name="display_name" value="" maxlength="80"/);
  assert.match(h, /<form method="post" action="\/theme" class="theme" aria-label="Theme">/);
  for (const href of ["/account", "/connections", "/connect"]) assert.match(h, new RegExp(`<a class="name" href="${href}">`));
  const menu = accountMenu(h);
  assert.match(menu, /Signed in as <strong>dora@example\.test<\/strong>/);
  for (const [href, label] of [["/settings", "Account settings"], ["/account", "Plan and usage"], ["/connections", "Connections"]]) {
    assert.match(menu, new RegExp(`<li><a href="${href}"[^>]*>${label}</a></li>`));
  }
});

test("settings: a display name is saved trimmed, shown in my account menu, and to co-members next to my email", async () => {
  const flash = await flashAfter("dora", await post("dora", "/settings/name", { display_name: "  Dora Díaz  " }));
  assert.equal(flash, "Saved. People who share a vault with you now see you as Dora Díaz.");
  const h = await page("dora", "/");
  assert.match(bar(h), /<span class="avatar" aria-hidden="true">D<\/span><span class="account-name">Dora Díaz<\/span>/);
  assert.match(accountMenu(h), /Signed in as <strong>Dora Díaz<\/strong><span class="menu-meta">dora@example\.test<\/span>/);
  assert.match(await page("dora", "/settings"), /name="display_name" value="Dora Díaz"/);
  assert.match(await page("eli", `/v/${V.studio}/activity`), /<td class="small">Dora Díaz \(dora@example\.test\)<\/td>/);
  assert.match(await page("eli", `/v/${V.studio}/config/members`), /<td>Dora Díaz \(dora@example\.test\)/);
  assert.doesNotMatch(await page("gus", "/activity"), /Dora Díaz/);
});

test("settings: a name with \"@\", control characters or over 80 characters is refused with the reason, and the old name stays", async () => {
  assert.match(await flashAfter("dora", await post("dora", "/settings/name", { display_name: "dora@evil.test" })), /can&#39;t contain &quot;@&quot;/);
  assert.match(await flashAfter("dora", await post("dora", "/settings/name", { display_name: `Dora${String.fromCodePoint(0x202e)}evil` })), /control characters, invisible characters or text-direction marks/);
  assert.equal(await flashAfter("dora", await post("dora", "/settings/name", { display_name: "d".repeat(81) })), "A display name is at most 80 characters. Nothing was saved.");
  assert.match(await page("dora", "/settings"), /name="display_name" value="Dora Díaz"/);
});

test("settings: saving a name needs the form token and this site's origin", async () => {
  assert.equal((await post("dora", "/settings/name", { display_name: "Forged" }, false)).status, 403);
  const token = await csrfOf("dora");
  const r = await fetch(S.dora.origin + "/settings/name", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S.dora.cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: new URLSearchParams({ csrf: token, display_name: "Forged" }).toString(),
  });
  assert.equal(r.status, 403);
  assert.doesNotMatch(await page("dora", "/settings"), /Forged/);
});

test("settings: clearing the name shows my email again", async () => {
  assert.equal(await flashAfter("dora", await post("dora", "/settings/name", { display_name: "   " })), "Display name cleared. People see your email.");
  assert.match(accountMenu(await page("dora", "/")), /Signed in as <strong>dora@example\.test<\/strong>/);
  assert.match(await page("eli", `/v/${V.studio}/activity`), /<td class="small">dora@example\.test<\/td>/);
});

// ---------------------------------------------------------------------------
// What the top bar costs

test("cost: the top bar is one query per page: Account settings is begin, the summary and commit", async () => {
  const { usePool } = await import("../dist/db.js");
  const { routes } = await import("../dist/pages.js");
  const db = new pg.Pool({ connectionString: WEB_DB, max: 1 });
  const n = { roundTrips: 0, queries: [] };
  const wrapped = new WeakSet();
  db.on("acquire", (client) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = (...args) => {
      n.roundTrips++;
      n.queries.push(String(args[0].text ?? args[0]).replace(/\s+/g, " ").slice(0, 60));
      return query(...args);
    };
  });
  usePool(db);
  const ctx = (path) => ({
    userId: DORA,
    csrf: "0",
    url: new URL(`http://web.test${path}`),
    form: new URLSearchParams(),
    method: "GET",
    theme: "auto",
    mcpUrl: "",
    setFlash() {},
  });
  try {
    const settings = await routes(ctx("/settings"));
    assert.match(settings.html, /<h1>Account settings<\/h1>/);
    assert.equal(n.roundTrips, 3, `begin with the claims, the summary, commit: ${n.queries.join(" | ")}`);
    assert.match(n.queries[1], /public\.shell_summary/);
    n.roundTrips = 0;
    n.queries = [];
    // Home with nothing waiting: the summary, the plan and the vaults; no
    // review list and no notices asked for.
    await as(DORA, "select public.snooze_proposal($1)", [plan]).catch(() => {});
    const home = await routes(ctx("/"));
    assert.doesNotMatch(home.html, /Needs your review/);
    assert.ok(!n.queries.some((q) => /take_deletion_notices|with w as/.test(q)), n.queries.join(" | "));
  } finally {
    await db.end();
  }
});
