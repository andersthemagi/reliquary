// The Tasks page in the web app (src/tasks.ts): a vault's work plans with
// their tasks counted by state, and one plan's tasks grouped so what can be
// worked on comes first. The state rules are SQL's (work_plans_test.sql,
// list_work_plans_test.sql) and who may see a plan is RLS's; this file is
// about what a person reads on the page: the words for each state, what a
// task waits on, who holds it, and the marker for a changed plan file.
//
// This file starts its own servers from dist/, signed in as Noa (an owner)
// and Rex (a viewer), people no other test file uses. Noa owns "Tasks main"
// with Edda (an editor, who holds a task below) and Rex.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const NOA = "00000000-0000-0000-0000-0000000055a1";
const EDDA = "00000000-0000-0000-0000-0000000055a2";
const REX = "00000000-0000-0000-0000-0000000055a3";

const V = {};
let noa;
let rex;

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

async function as(user, q, params = [], act = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", ...(act ? { act } : {}) })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A server from dist/, signed in as `user`.
async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/tasks-page-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);

const tasksUrl = (v) => `/v/${v}/tasks`;
const planUrl = (v, path) => `/v/${v}/tasks/plan?path=${encodeURIComponent(path)}`;

// A plan file and its registration, as `user`.
async function register(user, vault, path, steps, body = "The plan") {
  await as(user, "select public.write_file($1, $2, $3)", [vault, path, body]);
  const [{ v }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = $2", [vault, path]);
  await as(user, "select public.register_work_plan($1, $2, $3, $4::jsonb)", [vault, path, v, JSON.stringify(steps)]);
}
const claim = async (user, vault, path, key, label) =>
  (await as(user, "select o_secret, o_fence from public.claim_step($1, $2, $3, $4)", [vault, path, key, label]))[0];

// The row of one task on a plan's page (its id carries the key), as HTML:
// up to the next row, or the next group's heading.
function taskRow(h, key) {
  const start = h.indexOf(`<li class="task-row" id="task-${key}">`);
  assert.ok(start >= 0, `a row for the task ${key}`);
  const ends = ['<li class="task-row"', "<h2", '<p class="hint">'].map((m) => h.indexOf(m, start + 1)).filter((i) => i > 0);
  return h.slice(start, Math.min(...ends));
}
// One plan's card on the Tasks page.
const planCard = (h, path) => h.split('<li class="plan-card">').slice(1).find((c) => c.includes(`>${path}<`));

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'noa@example.test'), ($2, 'edda@example.test'), ($3, 'rex@example.test') on conflict (id) do nothing`,
    [NOA, EDDA, REX],
  );
  noa = await start(NOA, "noa");
  rex = await start(REX, "rex");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Tasks main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, NOA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, REX, NOA]);
  // claim_step keeps to the claim rule's caps (20261013220000): Edda holds
  // a task in two plans from one connection, so the rule allows two. The
  // rest is the Org preset, the settings with no rule.
  await as(NOA, "select public.set_claim_rule($1, '', 2880, 10080, null, 2, 5, 360, 60, 900, 1, 2880)", [V.main]);

  // fetch: done. clean: held by Edda. check: ready. ship: blocked on clean and
  // check. side: cancelled. after: blocked by the cancelled side job.
  await register(EDDA, V.main, "plans/launch.md", [
    { key: "fetch", title: "Fetch the data" },
    { key: "clean", title: "Clean it", blocked_by: ["fetch"] },
    { key: "check", title: "Check it", blocked_by: ["fetch"] },
    { key: "ship", title: "Ship it", blocked_by: ["clean", "check"] },
    { key: "side", title: "Side job" },
    { key: "after", title: "After the side job", blocked_by: ["side"] },
  ]);
  const fetch1 = await claim(EDDA, V.main, "plans/launch.md", "fetch", null);
  await as(EDDA, "select public.complete_step($1, 'plans/launch.md', 'fetch', $2, $3)", [V.main, fetch1.o_fence, fetch1.o_secret]);
  await claim(EDDA, V.main, "plans/launch.md", "clean", "<b>cleaning</b> the rows");
  await as(NOA, "select public.cancel_step($1, 'plans/launch.md', 'side')", [V.main]);

  await register(EDDA, V.main, "plans/second.md", [{ key: "only", title: "The only task" }]);

  // The plan the cancel and skip tests work on. a and c are ready (b waits on
  // a, d on c), e is held by Edda, f is done.
  await register(EDDA, V.main, "plans/work.md", [
    { key: "a", title: "Draft" },
    { key: "b", title: "Review the draft", blocked_by: ["a"] },
    { key: "c", title: "Outline" },
    { key: "d", title: "Write the intro", blocked_by: ["c"] },
    { key: "e", title: "Held task" },
    { key: "f", title: "Done thing" },
  ]);
  const f1 = await claim(EDDA, V.main, "plans/work.md", "f", null);
  await as(EDDA, "select public.complete_step($1, 'plans/work.md', 'f', $2, $3)", [V.main, f1.o_fence, f1.o_secret]);
  await claim(EDDA, V.main, "plans/work.md", "e", "Edda's agent");

  [{ id: V.empty }] = await as(NOA, "select public.create_vault('Tasks empty', 'open') as id");
  [{ id: V.other }] = await as(REX, "select public.create_vault('Tasks rex-only', 'open') as id");
});

after(async () => {
  noa?.child?.kill();
  rex?.child?.kill();
});

// ---------------------------------------------------------------------------
// The list of plans

test("tasks page: a vault you're not in is 404", async () => {
  assert.equal((await get(noa, tasksUrl(V.other))).status, 404);
  assert.equal((await get(noa, planUrl(V.other, "plans/launch.md"))).status, 404);
});

test("tasks page: a vault with no plan says how one comes to exist, in two sentences, and links the docs", async () => {
  const h = await page(noa, tasksUrl(V.empty));
  assert.match(h, /<h1>Tasks<\/h1>/);
  assert.match(h, /<strong>No plans yet<\/strong>/);
  assert.match(
    h,
    /<p>A plan comes to exist when an agent registers a plan file, a file in the vault that lists tasks\. Registered plans, and the tasks in them, show up here\.<\/p>/,
  );
  assert.match(h, /<a href="\/docs\/concepts\/tasks">About tasks<\/a>/);
});

test("tasks page: lists each plan with its tasks counted in words, and links to the plan", async () => {
  const h = await page(noa, tasksUrl(V.main));
  const launch = planCard(h, "plans/launch.md");
  assert.match(launch, new RegExp(`<a href="${tasksUrl(V.main)}/plan\\?path=plans%2Flaunch\\.md">plans/launch\\.md</a>`));
  assert.match(launch, /<strong>1 of 6 done<\/strong> <span class="muted">· 1 in progress · 1 ready · 2 blocked · 1 cancelled<\/span>/);
  assert.match(launch, /edda@example\.test/, "who registered it");
  assert.match(planCard(h, "plans/second.md"), /<strong>0 of 1 done<\/strong> <span class="muted">· 1 ready<\/span>/);
  const cards = h.slice(h.indexOf('<ul class="plan-cards">'));
  assert.ok(cards.indexOf("plans/launch.md") < cards.indexOf("plans/second.md"), "in path order");
});

test("tasks page: opens on what is open across every plan, in progress, ready to pick up and blocked, each row naming its plan", async () => {
  const h = await page(noa, tasksUrl(V.main));
  const at = ["open-in-progress", "open-ready", "open-blocked", "plans"].map((g) => h.indexOf(`<h2 id="${g}">`));
  assert.ok(at.every((i) => i > 0), "a heading for each section in use, and the plans");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in progress, ready to pick up, blocked, then the plans");
  assert.match(h, /<h2 id="open-ready">Ready to pick up <span class="muted">4<\/span><\/h2>/, "check, only, Draft and Outline");
  const section = (g) => h.slice(h.indexOf(`<h2 id="${g}">`), h.indexOf("</section>", h.indexOf(`<h2 id="${g}">`)));
  const row = (g, title) => section(g).split('<li class="task-row">').find((r) => r.includes(`<strong class="task-title">${title}</strong>`));
  const launch = new RegExp(`<p class="task-meta"><a href="${tasksUrl(V.main)}/plan\\?path=plans%2Flaunch\\.md">plans/launch\\.md</a>`);
  assert.match(row("open-in-progress", "Clean it"), launch);
  assert.match(row("open-in-progress", "Clean it"), /<span class="chip task-holder">edda@example\.test<\/span>/);
  assert.match(row("open-in-progress", "Held task"), /plans\/work\.md<\/a>/);
  assert.match(row("open-ready", "The only task"), /plans\/second\.md<\/a>/);
  assert.match(row("open-blocked", "After the side job"), /<span class="badge danger">Blocked by a cancelled task<\/span>/);
  assert.match(row("open-blocked", "Ship it"), /<span class="badge warning">Blocked<\/span>/);
  assert.ok(section("open-blocked").indexOf("After the side job") < section("open-blocked").indexOf("Ship it"), "blocked by a cancelled task first");
  for (const title of ["Fetch the data", "Side job", "Done thing"]) assert.doesNotMatch(h, new RegExp(`<strong class="task-title">${title}</strong>`), `${title} is finished`);
  assert.doesNotMatch(h, /id="task-/, "keys repeat across plans, so no row ids here");
});

test("tasks page: a plan's card has a progress bar, and the plan file's first heading as its title", async () => {
  assert.match(planCard(await page(noa, tasksUrl(V.main)), "plans/launch.md"), /<progress class="task-progress" max="6" value="1" aria-label="1 of 6 done">1 of 6 done<\/progress>/);
  const [{ id: v }] = await as(NOA, "select public.create_vault('Tasks titled', 'open') as id");
  await register(NOA, v, "plans/site.md", [{ key: "one", title: "One" }], "Some notes first.\n\n# Launch the site\n\n## Steps\n");
  const card = planCard(await page(noa, tasksUrl(v)), "plans/site.md");
  assert.match(card, new RegExp(`<h3><a href="${tasksUrl(v)}/plan\\?path=plans%2Fsite\\.md">Launch the site</a></h3>`));
  assert.match(card, /<p class="path small muted">plans\/site\.md<\/p>/, "the path stays, quieter");
  assert.match(await page(noa, planUrl(v, "plans/site.md")), /<h1>Launch the site<\/h1>/);
});

test("tasks page: has its own section in the vault's nav, current on both of its pages", async () => {
  for (const url of [tasksUrl(V.main), planUrl(V.main, "plans/launch.md")]) {
    const h = await page(noa, url);
    assert.match(h, new RegExp(`<a href="${tasksUrl(V.main)}" aria-current="page">Tasks</a>`), url);
  }
});

test("tasks page: a viewer sees the same list", async () => {
  const h = await page(rex, tasksUrl(V.main));
  assert.match(h, /1 of 6 done/);
  assert.match(h, /plans\/second\.md/);
});

test("tasks page: a plan whose file has changed since it was registered carries a marker with words, and a deleted one says so", async () => {
  let h = await page(noa, tasksUrl(V.main));
  assert.match(planCard(h, "plans/second.md"), /<span class="muted">Unchanged<\/span>/);
  await as(EDDA, "select public.write_file($1, 'plans/second.md', 'The plan, edited')", [V.main]);
  h = await page(noa, tasksUrl(V.main));
  assert.match(planCard(h, "plans/second.md"), /<span class="badge warning">Changed since registered<\/span>/);
  assert.match(planCard(h, "plans/launch.md"), /<span class="muted">Unchanged<\/span>/, "another plan's file is untouched");
  await as(EDDA, "select public.delete_file($1, 'plans/second.md')", [V.main]);
  h = await page(noa, tasksUrl(V.main));
  assert.match(planCard(h, "plans/second.md"), /<span class="badge warning">File deleted<\/span>/);
});

// ---------------------------------------------------------------------------
// One plan

test("plan page: groups what is in progress and ready first, then blocked, cancelled and done", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(h, /<h1 class="path">plans\/launch\.md<\/h1>/);
  assert.match(h, /1 of 6 tasks done\./);
  const order = ["in-progress", "ready", "blocked", "cancelled", "done"].map((g) => h.indexOf(`<h2 id="g-${g}">`));
  assert.ok(order.every((i) => i > 0), "a heading for each group in use");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in progress, ready, blocked, cancelled, done, in that order");
  assert.match(h, /<h2 id="g-in-progress">In progress <span class="muted">1<\/span><\/h2>/);
  assert.match(h, /<h2 id="g-blocked">Blocked <span class="muted">2<\/span><\/h2>/);
  const keys = [...h.matchAll(/<li class="task-row" id="task-([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["clean", "check", "after", "ship", "side", "fetch"], "a task blocked by a cancelled one comes first among the blocked");
});

test("plan page: done tasks are folded into a closed Done section at the bottom, and no task's key is shown", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  const done = h.indexOf('<details class="task-done"><summary><h2 id="g-done">Done <span class="muted">1</span></h2></summary>');
  assert.ok(done > 0, "a closed <details>, with no open attribute");
  assert.ok(h.indexOf('id="task-fetch"') > done, "the done task is inside it");
  assert.ok(h.indexOf('id="task-side"') < done, "a cancelled task is not");
  assert.doesNotMatch(h, /<code>(fetch|clean|check|ship|side|after)<\/code>|work_plan/, "keys and work_plan are for agents");
});

test("plan page: a task an agent holds shows a chip naming the person and their agent", async () => {
  const [{ id: v }] = await as(NOA, "select public.create_vault('Tasks agent', 'open') as id");
  await register(NOA, v, "plans/agent.md", [{ key: "one", title: "Agent work" }, { key: "two", title: "My own work" }]);
  // Both claims come from one connection as claim_step counts them, so the rule allows two (as in before()).
  await as(NOA, "select public.set_claim_rule($1, '', 2880, 10080, null, 2, 5, 360, 60, 900, 1, 2880)", [v]);
  await as(NOA, "select public.claim_step($1, 'plans/agent.md', 'one', null)", [v], { sub: "tok-1", name: "Claude Code" });
  await claim(NOA, v, "plans/agent.md", "two", null);
  const h = await page(noa, planUrl(v, "plans/agent.md"));
  assert.match(taskRow(h, "one"), /<span class="chip task-holder">you via Claude Code<\/span>/);
  assert.match(taskRow(h, "two"), /<span class="chip task-holder">you<\/span>/);
  assert.match(await page(noa, tasksUrl(v)), /<span class="chip task-holder">you via Claude Code<\/span>/, "and on the Tasks page");
});

test("plan page: every task's state is a word in its row, not only a colour", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  const states = { clean: "In progress", check: "Ready", ship: "Blocked", after: "Blocked by a cancelled task", side: "Cancelled", fetch: "Done" };
  for (const [key, label] of Object.entries(states)) {
    assert.match(taskRow(h, key), new RegExp(`<div class="task-line">\\s*<span class="task-dot [a-z_]+" aria-hidden="true"></span><span class="badge[^"]*">${label}</span>`), key);
  }
  assert.equal(h.match(/<div class="task-line">\s*<span class="task-dot [a-z_]+" aria-hidden="true"><\/span><span class="badge/g).length, 6, "a state for every task, its shape hidden from screen readers");
});

test("plan page: a task in progress names who holds it, quotes the label as data, and shows the time left", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "clean");
  assert.match(row, /<span class="chip task-holder">edda@example\.test<\/span>/);
  assert.match(row, /<p class="task-meta">“&lt;b&gt;cleaning&lt;\/b&gt; the rows” · Time left: <time [^>]*>in 2 days<\/time><\/p>/, "the label is text, in quotes");
});

test("plan page: a blocked task names what it waits on", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "ship");
  assert.match(row, /<p class="task-meta">Blocked by Clean it, Check it\.<\/p>/);
});

test("plan page: a task blocked by a cancelled one says so plainly, and what it takes to move it", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "after");
  assert.match(row, /Blocked by a cancelled task: Side job\. A cancelled task never counts as done, so this one stays blocked until a person reopens that task, or cancels or skips this one\./);
});

test("plan page: a ready task, a done one and a cancelled one each say what they are", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.doesNotMatch(taskRow(h, "check"), /task-meta/, "a ready task needs no second line");
  assert.match(taskRow(h, "fetch"), /Done <time [^>]*>[^<]*<\/time>\./);
  assert.match(taskRow(h, "side"), /Doesn’t count as done\./);
});

test("plan page: a lapsed claim reads as ready again, and says why", async () => {
  await sql(
    `update public.work_plan_steps s set expires_at = now() - interval '1 minute'
       from public.work_plans p where p.id = s.plan_id and p.vault_id = $1 and p.path = 'plans/launch.md' and s.status = 'claimed'`,
    [V.main],
  );
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(taskRow(h, "clean"), /<span class="badge success">Ready<\/span>/);
  assert.match(taskRow(h, "clean"), /Its last claim ran out, so it can be taken again\./);
  assert.match(await page(noa, tasksUrl(V.main)), /<strong>1 of 6 done<\/strong> <span class="muted">· 2 ready · 2 blocked · 1 cancelled<\/span>/);
});

test("plan page: a changed plan file is said at the top, with a link to the file's history", async () => {
  await as(EDDA, "select public.write_file($1, 'plans/launch.md', 'The plan, edited')", [V.main]);
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(h, /<div class="callout warning"><p>This plan’s file has changed since the plan was registered\./);
  assert.match(h, new RegExp(`<a href="/v/${V.main}/file\\?path=plans%2Flaunch\\.md&amp;tab=history">See the file’s history</a>`));
});

test("plan page: a deleted plan file is said at the top, and its tasks stay", async () => {
  const h = await page(noa, planUrl(V.main, "plans/second.md"));
  assert.match(h, /<div class="callout warning"><p>This plan’s file has been deleted\. The tasks below stay, and agents can still work from them\.<\/p><\/div>/);
  assert.match(taskRow(h, "only"), /Ready/);
});

test("plan page: a path with no plan, or none at all, goes back to the list with a warning", async () => {
  const r = await get(noa, planUrl(V.main, "plans/nope.md"));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), tasksUrl(V.main));
  assert.deepEqual(flashOf(await page(noa, tasksUrl(V.main))), ["warning", "status", "There’s no plan registered at plans/nope.md."]);
  const none = await get(noa, `/v/${V.main}/tasks/plan`);
  assert.equal(none.headers.get("location"), tasksUrl(V.main));
  assert.deepEqual(flashOf(await page(noa, tasksUrl(V.main))), ["warning", "status", "There’s no plan registered at that path."]);
});

// ---------------------------------------------------------------------------
// Cancel and skip. The database decides (cancel_step and skip_step need a
// person who can write the path: work_plans_test.sql), so these check the
// wiring: who is offered the buttons, the confirm page before anything
// changes, and what the page says afterwards.

const WORK = "plans/work.md";
const post = (s, path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const landed = async (s, r) => {
  assert.equal(r.status, 303);
  return page(s, r.headers.get("location"));
};
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields };
}
const confirmUrl = (v, verb, key) => `${planUrl(v, WORK)}&${verb}=${key}`;
const stepOf = async (key) =>
  (await sql(
    `select s.status, s.holder, s.open_blockers from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
      where p.vault_id = $1 and p.path = $2 and s.key = $3`,
    [V.main, WORK, key],
  ))[0];
const logged = async (event) =>
  (await sql("select path, actor, detail->>'step' as step from public.log where vault_id = $1 and path = $2 and event = $3 order by seq", [V.main, WORK, event]));

test("actions: an owner is offered Skip and Cancel in a row's ⋯ menu on every task that isn't finished, and none on a done one", async () => {
  const h = await page(noa, planUrl(V.main, WORK));
  for (const [key, title] of [["a", "Draft"], ["b", "Review the draft"], ["c", "Outline"], ["d", "Write the intro"], ["e", "Held task"]]) {
    const row = taskRow(h, key);
    assert.match(row, new RegExp(`<summary class="button quiet icon-button" aria-label="Actions for the task ${title}"`), `a ⋯ menu on ${key}`);
    assert.match(row, new RegExp(`<a class="menu-item danger" href="${planUrl(V.main, WORK).replace("?", "\\?")}&amp;cancel=${key}"><span class="menu-item-title">Cancel</span>`), `Cancel on ${key}`);
    assert.match(row, new RegExp(`<a class="menu-item" href="[^"]*&amp;skip=${key}"><span class="menu-item-title">Skip</span>`), `Skip on ${key}`);
  }
  assert.doesNotMatch(taskRow(h, "f"), /Skip|Cancel|action-menu/, "nothing to do on a finished task");
});

test("actions: a viewer is offered nothing, is sent back from a confirm page, and the database refuses a crafted form", async () => {
  const h = await page(rex, planUrl(V.main, WORK));
  assert.doesNotMatch(h, /action-menu|&amp;cancel=|&amp;skip=/, "no ⋯ menus, no Cancel or Skip");
  assert.match(h, /Draft/, "the tasks are still there to read");
  const back = await landed(rex, await get(rex, confirmUrl(V.main, "cancel", "a")));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only someone who can write this plan’s file cancels or skips its tasks."]);
  const r = await post(rex, `/v/${V.main}/tasks/plan`, { csrf: csrfOf(back), path: WORK, key: "a", action: "cancel", confirm: "1" });
  const [tone, , text] = flashOf(await landed(rex, r));
  assert.equal(tone, "danger");
  assert.match(text, /\(ref [0-9a-f]{8}\)$/);
  assert.equal((await stepOf("a")).status, "open", "nothing cancelled");
});

test("cancel: the confirm page says what happens and what stays blocked, and opening it cancels nothing", async () => {
  const h = await page(noa, confirmUrl(V.main, "cancel", "a"));
  assert.match(h, /<h1>Cancel “Draft”\?<\/h1>/);
  assert.match(h, /Cancelling <strong>Draft<\/strong> <code>a<\/code> drops it from the plan\. A cancelled task never counts as done\./);
  assert.match(
    h,
    /<li>These tasks wait on it and stay blocked, shown as blocked by a cancelled task, until a person cancels or skips each of them: Review the draft <code>b<\/code>\.<\/li>/,
  );
  assert.match(h, /<li>A person can reopen it later from this page\.<\/li>/);
  const { action, fields } = formFields(h, "Cancel “Draft”");
  assert.equal(action, `/v/${V.main}/tasks/plan`);
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: WORK, key: "a", action: "cancel", confirm: "1" });
  assert.equal((await stepOf("a")).status, "open", "asking cancels nothing");
});

test("cancel: the confirm page's way out says Keep the task, so its only Cancel is the irreversible button; Skip's way out stays Cancel", async () => {
  const h = await page(noa, confirmUrl(V.main, "cancel", "a"));
  assert.match(h, /<button class="danger solid">Cancel “Draft”<\/button><a class="button quiet" href="[^"]+">Keep the task<\/a>/);
  assert.doesNotMatch(h, />Cancel<\/a>/);
  assert.match(await page(noa, confirmUrl(V.main, "skip", "a")), /<a class="button quiet" href="[^"]+">Cancel<\/a>/);
});

test("cancel: a form without the confirm page's field is sent to that page and cancels nothing", async () => {
  const token = csrfOf(await page(noa, planUrl(V.main, WORK)));
  const r = await post(noa, `/v/${V.main}/tasks/plan`, { csrf: token, path: WORK, key: "a", action: "cancel" });
  assert.equal(r.headers.get("location"), confirmUrl(V.main, "cancel", "a"));
  assert.equal((await stepOf("a")).status, "open");
});

test("cancel: confirming cancels it, says so as a success, logs it, and what waited on it reads as blocked by a cancelled task", async () => {
  const { action, fields } = formFields(await page(noa, confirmUrl(V.main, "cancel", "a")), "Cancel “Draft”");
  const h = await landed(noa, await post(noa, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "“Draft” is cancelled. Tasks waiting on it stay blocked until a person cancels or skips them."]);
  assert.equal((await stepOf("a")).status, "cancelled");
  assert.deepEqual(await logged("step.cancel"), [{ path: WORK, actor: NOA, step: "a" }]);
  assert.match(taskRow(h, "a"), /<span class="badge">Cancelled<\/span>/);
  assert.match(taskRow(h, "b"), /Blocked by a cancelled task: Draft\./);
  assert.doesNotMatch(taskRow(h, "a"), /Cancel<\/a>|Skip<\/a>/, "no more actions on it");
});

test("cancel: a task someone holds says who loses it, and confirming takes it from them", async () => {
  const h = await page(noa, confirmUrl(V.main, "cancel", "e"));
  assert.match(h, /<li>edda@example\.test \(“Edda&#39;s agent”\) holds it now and loses it\. If their agent tries to finish it, that is refused\.<\/li>/);
  const { action, fields } = formFields(h, "Cancel “Held task”");
  await landed(noa, await post(noa, action, fields));
  assert.deepEqual({ ...(await stepOf("e")) }, { status: "cancelled", holder: null, open_blockers: 0 });
});

test("cancel: a task already finished goes back with a warning, and a crafted form is refused with a reference", async () => {
  const back = await landed(noa, await get(noa, confirmUrl(V.main, "cancel", "f")));
  assert.deepEqual(flashOf(back), ["warning", "status", "“Done thing” is already done, so there’s nothing to cancel."]);
  const h = await landed(noa, await post(noa, `/v/${V.main}/tasks/plan`, { csrf: csrfOf(back), path: WORK, key: "f", action: "cancel", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^Step &quot;f&quot; is already done\. \(ref [0-9a-f]{8}\)$/);
  assert.equal((await stepOf("f")).status, "done");
  assert.equal((await logged("step.cancel")).length, 2, "only the two real cancels are logged");
});

test("skip: the confirm page says it counts as done and what becomes ready, and opening it skips nothing", async () => {
  const h = await page(noa, confirmUrl(V.main, "skip", "c"));
  assert.match(h, /<h1>Skip “Outline”\?<\/h1>/);
  assert.match(h, /Skipping <strong>Outline<\/strong> <code>c<\/code> marks it done, as if someone had finished it, without anyone doing the work\./);
  assert.match(h, /<li>These tasks stop waiting on it, and any with nothing else left to wait for become ready: Write the intro <code>d<\/code>\.<\/li>/);
  assert.match(h, /<li>The plan shows it as done\. The activity log records that it was skipped\.<\/li>/);
  const { fields } = formFields(h, "Skip “Outline”");
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: WORK, key: "c", action: "skip", confirm: "1" });
  assert.equal((await stepOf("c")).status, "open", "asking skips nothing");
});

test("skip: confirming marks it done, the task that waited on it is ready, and it is logged", async () => {
  assert.equal((await stepOf("d")).open_blockers, 1);
  const { action, fields } = formFields(await page(noa, confirmUrl(V.main, "skip", "c")), "Skip “Outline”");
  const h = await landed(noa, await post(noa, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "“Outline” is skipped and counts as done. Tasks that were waiting only on it are ready now."]);
  assert.equal((await stepOf("c")).status, "done");
  assert.match(taskRow(h, "d"), /<span class="badge success">Ready<\/span>/);
  assert.deepEqual(await logged("step.skip"), [{ path: WORK, actor: NOA, step: "c" }]);
});

test("skip: a task whose own blockers are not finished can be skipped, and the page says so first", async () => {
  const h = await page(noa, confirmUrl(V.main, "skip", "b"));
  assert.match(h, /<li>Its own blockers aren’t finished\. Skipping it lets what waits on it go ahead anyway\.<\/li>/);
  const { action, fields } = formFields(h, "Skip “Review the draft”");
  await landed(noa, await post(noa, action, fields));
  assert.equal((await stepOf("b")).status, "done");
});

test("skip: an unknown task goes back with a warning, and a form naming no action is refused and changes nothing", async () => {
  const back = await landed(noa, await get(noa, confirmUrl(V.main, "skip", "zzz")));
  assert.deepEqual(flashOf(back), ["warning", "status", "There’s no task zzz in this plan."]);
  const h = await landed(noa, await post(noa, `/v/${V.main}/tasks/plan`, { csrf: csrfOf(back), path: WORK, key: "d", action: "nope" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^The form didn’t say what to do, so nothing changed\. \(ref [0-9a-f]{8}\)$/);
  assert.equal((await stepOf("d")).status, "open");
});

// ---------------------------------------------------------------------------
// Reopen (issue #76). reopen_step is the database's to allow (a person who
// can write the path, only a cancelled step: reopen_step_test.sql); these
// check the button, the confirm page and its nudge toward a new task, and
// what the page says afterwards. Its own plan: base is ready, drop (waits
// on base) and solo are cancelled, next waits on drop.

const REOPEN = "plans/reopen.md";
const reopenUrl = (key) => `${planUrl(V.main, REOPEN)}&reopen=${key}`;
async function reopenPlan() {
  if ((await sql("select 1 from public.work_plans where vault_id = $1 and path = $2", [V.main, REOPEN])).length) return;
  await register(NOA, V.main, REOPEN, [
    { key: "base", title: "Base" },
    { key: "drop", title: "Dropped work", blocked_by: ["base"] },
    { key: "next", title: "Next step", blocked_by: ["drop"] },
    { key: "solo", title: "Solo work" },
  ]);
  for (const key of ["drop", "solo"]) await as(NOA, "select public.cancel_step($1, $2, $3)", [V.main, REOPEN, key]);
}
const reopenStatus = async (key) =>
  (await sql("select s.status from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id where p.vault_id = $1 and p.path = $2 and s.key = $3",
    [V.main, REOPEN, key]))[0].status;

test("reopen: an owner is offered Reopen on a cancelled task and on no other; a viewer is offered nothing and is sent back from the confirm page", async () => {
  await reopenPlan();
  const h = await page(noa, planUrl(V.main, REOPEN));
  assert.match(taskRow(h, "drop"), new RegExp(`<a class="button quiet" href="${planUrl(V.main, REOPEN).replace("?", "\\?")}&amp;reopen=drop" aria-label="Reopen the task Dropped work">Reopen</a>`));
  assert.doesNotMatch(taskRow(h, "drop"), /Cancel<\/a>|Skip<\/a>/);
  for (const key of ["base", "next"]) assert.doesNotMatch(taskRow(h, key), /Reopen/, `no Reopen on ${key}`);
  assert.match(h, /Cancel drops a task, and Reopen puts a cancelled one back\./);

  assert.doesNotMatch(await page(rex, planUrl(V.main, REOPEN)), /Reopen<\/a>/);
  const back = await landed(rex, await get(rex, reopenUrl("drop")));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only someone who can write this plan’s file reopens its tasks."]);
  assert.equal(await reopenStatus("drop"), "cancelled");
});

test("reopen: the confirm page says a new task naming the old one is usually better, what it waits on and what waits on it, and opening it reopens nothing", async () => {
  await reopenPlan();
  const h = await page(noa, reopenUrl("drop"));
  assert.match(h, /<h1>Reopen “Dropped work”\?<\/h1>/);
  assert.match(h, /Reopening <strong>Dropped work<\/strong> <code>drop<\/code> puts it back in the plan as open work, for an agent to take once what it waits on is done\./);
  assert.match(h, /<li>If the work has changed since it was cancelled, a new task that names this one \(<code>drop<\/code>\) is usually better than reopening it: an agent adds it to the plan file and registers it again, and the history reads plainly\. Reopen when the work really is the same task\.<\/li>/);
  assert.match(h, /<li>It waits on Base <code>base<\/code> again before anyone can take it\.<\/li>/);
  assert.match(h, /<li>These tasks wait on it, and wait for it to be done, the same as for any other task: Next step <code>next<\/code>\.<\/li>/);
  assert.match(h, /<button class="danger solid">Reopen “Dropped work”<\/button><a class="button quiet" href="[^"]+">Keep it cancelled<\/a>/);
  const { fields } = formFields(h, "Reopen “Dropped work”");
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: REOPEN, key: "drop", action: "reopen", confirm: "1" });
  assert.equal(await reopenStatus("drop"), "cancelled", "asking reopens nothing");
});

test("reopen: confirming reopens it, says so as a success, logs it, and what waited on it reads as blocked, not blocked by a cancelled task", async () => {
  await reopenPlan();
  assert.match(taskRow(await page(noa, planUrl(V.main, REOPEN)), "next"), /Blocked by a cancelled task/);
  const { action, fields } = formFields(await page(noa, reopenUrl("drop")), "Reopen “Dropped work”");
  const h = await landed(noa, await post(noa, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "“Dropped work” is reopened. Tasks that waited on it now wait for it to be done."]);
  assert.equal(await reopenStatus("drop"), "open");
  assert.deepEqual(
    await sql("select actor, detail->>'step' as step from public.log where vault_id = $1 and path = $2 and event = 'step.reopen' order by seq", [V.main, REOPEN]),
    [{ actor: NOA, step: "drop" }],
  );
  assert.match(taskRow(h, "drop"), /<span class="badge warning">Blocked<\/span>/);
  assert.match(taskRow(h, "next"), /<span class="badge warning">Blocked<\/span>/);
  assert.match(taskRow(h, "next"), /Blocked by Dropped work\./);
});

test("reopen: a cancelled task with nothing unfinished to wait on says it will be ready, and is ready once reopened", async () => {
  await reopenPlan();
  const h = await page(noa, reopenUrl("solo"));
  assert.match(h, /<li>Nothing it waits on is unfinished, so it is ready for an agent to take\.<\/li>/);
  assert.match(h, /<li>No other task is waiting on it\.<\/li>/);
  const { action, fields } = formFields(h, "Reopen “Solo work”");
  assert.match(taskRow(await landed(noa, await post(noa, action, fields)), "solo"), /<span class="badge success">Ready<\/span>/);
});

test("reopen: a task that isn't cancelled goes back with a warning, and a crafted form is refused with a reference and changes nothing", async () => {
  await reopenPlan();
  const back = await landed(noa, await get(noa, reopenUrl("base")));
  assert.deepEqual(flashOf(back), ["warning", "status", "“Base” isn’t cancelled, so there’s nothing to reopen."]);
  const h = await landed(noa, await post(noa, `/v/${V.main}/tasks/plan`, { csrf: csrfOf(back), path: REOPEN, key: "base", action: "reopen", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^Step &quot;base&quot; is not cancelled; only a cancelled step can be reopened\. \(ref [0-9a-f]{8}\)$/);
  assert.equal(await reopenStatus("base"), "open");
});

// ---------------------------------------------------------------------------
// Context moved (CL-3.6): a file a task cites has a newer version.

test("context moved: a task citing a file with a newer version says a file it cites changed and links the file, and the registrant's flag names the plan", async () => {
  await as(EDDA, "select public.write_file($1, 'notes/moved.md', 'first')", [V.main]);
  const [{ v }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = 'notes/moved.md'", [V.main]);
  await register(NOA, V.main, "plans/moved.md", [{ key: "uses", title: "Uses the note", cites: [{ path: "notes/moved.md", version: v }] }]);
  assert.doesNotMatch(taskRow(await page(noa, planUrl(V.main, "plans/moved.md")), "uses"), /A file it cites changed/);
  await page(noa, `/v/${V.main}/flags`);

  await as(EDDA, "select public.write_file($1, 'notes/moved.md', 'second')", [V.main]);
  const row = taskRow(await page(noa, planUrl(V.main, "plans/moved.md")), "uses");
  assert.match(row, /<span class="badge success">Ready<\/span>[\s\S]*<span class="badge warning">A file it cites changed<\/span>/);
  assert.match(row, new RegExp(`A file it cites changed: <a href="/v/${V.main}/file\\?path=notes%2Fmoved\\.md">notes/moved\\.md</a> has a newer version than the one this task cites\\.`));

  const flags = await page(noa, `/v/${V.main}/flags`);
  assert.match(flags, /<span class="badge warning">Context moved<\/span>/);
  assert.match(flags, new RegExp(`cited in <a href="${tasksUrl(V.main)}/plan\\?path=plans%2Fmoved\\.md">plans/moved\\.md</a>`));
});

// ---------------------------------------------------------------------------
// A plan that gained tasks (20261013160000_work_plan_gains_steps.sql)

test("plan gains tasks: registering the changed file again clears the marker, adds the new task and keeps the old one's state", async () => {
  const [{ id: v }] = await as(NOA, "select public.create_vault('Tasks grows', 'open') as id");
  const path = "plans/grows.md";
  await register(NOA, v, path, [{ key: "first", title: "First task" }]);
  const first = await claim(NOA, v, path, "first", null);
  await as(NOA, "select public.complete_step($1, $2, 'first', $3, $4)", [v, path, first.o_fence, first.o_secret]);
  await as(NOA, "select public.write_file($1, $2, 'The plan, with a second task')", [v, path]);
  assert.match(
    await page(noa, planUrl(v, path)),
    /The tasks below come from the version last registered, and that is what agents work from\. If the change adds tasks, an agent registers the file again to add them; tasks already here keep their state\./,
  );

  await register(NOA, v, path, [{ key: "first", title: "First task" }, { key: "second", title: "Second task", blocked_by: ["first"] }]);
  const list = await page(noa, tasksUrl(v));
  assert.match(planCard(list, path), /<span class="muted">Unchanged<\/span>/);
  assert.match(list, /1 of 2 done/);
  const h = await page(noa, planUrl(v, path));
  assert.match(taskRow(h, "first"), /<span class="badge">Done<\/span>/);
  assert.match(taskRow(h, "second"), /<span class="badge success">Ready<\/span>/);
});

// ---------------------------------------------------------------------------
// Who waits in a plan's line (issue #76). plans/line.md has one task, held
// by Edda, so whoever asks for work waits. Noa asks first, Ula second (her
// place then lapses), Ivo's agent third. The line's rules are SQL's
// (waiting_test.sql); this is what the plan page shows of it.

const IVO = "00000000-0000-0000-0000-0000000055a4";
const ULA = "00000000-0000-0000-0000-0000000055a5";
const LINE = "plans/line.md";

async function requestWork(user, label, agent) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: user, role: "authenticated", ...(agent ? { act: { sub: agent, name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query("select o_state, o_place from public.request_work($1, $2, $3)", [V.main, LINE, label]);
    await db.query("commit");
    return rows[0];
  } finally {
    await db.end();
  }
}

// The waiting section's rows, as [place, who, lapses].
function lineRows(h) {
  const s = /<section aria-labelledby="g-waiting">([\s\S]*?)<\/section>/.exec(h);
  assert.ok(s, "a Waiting for work section");
  return [...s[1].matchAll(/<tr><td><strong>(\d+)<\/strong><\/td><td [^>]*>([^<]*)<\/td><td [^>]*>([\s\S]*?)<\/td><\/tr>/g)].map((m) => m.slice(1));
}

// Set up once, by the first test that needs it: a second top-level before()
// would not wait for the first one to create the vault.
let seeded;
const seedLine = () => (seeded ??= (async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'ivo@example.test'), ($2, 'ula@example.test') on conflict (id) do nothing`, [IVO, ULA]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, IVO, NOA]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, ULA, NOA]);
  await register(EDDA, V.main, LINE, [{ key: "only", title: "The only task" }]);
  await claim(EDDA, V.main, LINE, "only", null);
  assert.deepEqual(await requestWork(NOA, "<b>secret-ish label</b>", null), { o_state: "wait", o_place: 1 });
  assert.deepEqual(await requestWork(ULA, null, null), { o_state: "wait", o_place: 2 });
  assert.deepEqual(await requestWork(IVO, null, "Ivo bot"), { o_state: "wait", o_place: 3 });
  await sql("update public.work_plan_places set expires_at = now() - interval '1 minute' where holder = $1", [ULA]);
})());

test("waiting: the plan page lists who is waiting in line order, each with their place and when it lapses, and an agent as its person's agent", async () => {
  await seedLine();
  const rows = lineRows(await page(noa, planUrl(V.main, LINE)));
  assert.equal(rows.length, 2, "a lapsed place is not listed");
  assert.deepEqual(rows.map(([n, w]) => [n, w]), [["1", "you"], ["2", "ivo@example.test’s agent"]]);
  for (const [, , lapses] of rows) assert.match(lapses, /^<time datetime="[^"]+"[^>]*>in 6 h<\/time>, unless it asks again$/, "the default place-in-line time");
});

test("waiting: a viewer sees the same list", async () => {
  await seedLine();
  const rows = lineRows(await page(rex, planUrl(V.main, LINE)));
  assert.deepEqual(rows.map(([n, w]) => [n, w]), [["1", "noa@example.test"], ["2", "ivo@example.test’s agent"]]);
});

test("waiting: the page shows no place's label, and the list no agent name, secret or fence", async () => {
  await seedLine();
  const h = await page(rex, planUrl(V.main, LINE));
  const section = /<section aria-labelledby="g-waiting">[\s\S]*?<\/section>/.exec(h)[0];
  assert.doesNotMatch(h, /secret-ish label/);
  assert.doesNotMatch(section, /Ivo bot|secret|fence/i);
});

test("waiting: a plan with no one in line says so plainly", async () => {
  const h = await page(noa, planUrl(V.main, "plans/second.md"));
  assert.deepEqual(lineRows(h), []);
  assert.match(h, /<h2 id="g-waiting">Waiting for work <span class="muted">0<\/span><\/h2><p class="muted">No one is waiting for work in this plan\.<\/p>/);
});

// ---------------------------------------------------------------------------
// Review gates (issue #78). approve_step is the database's to allow (a person
// who can write the path, only a step awaiting review: review_gate_test.sql);
// these check what the page shows of a task awaiting review, the Approve
// button and its confirm page, and the note on a linked proposal's page. Its
// own vault, Noa's, with Rex as a viewer: brief (gated) is awaiting review
// and build waits on it; spec (gated) is awaiting review with a proposal
// linked; open is plain and open.

const GATE = "plans/gate.md";
let gated;
const seedGate = () => (gated ??= (async () => {
  const [{ id: v }] = await as(NOA, "select public.create_vault('Tasks gate', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [v, REX, NOA]);
  await as(NOA, "select public.set_policy($1, 'canon/', 'canon', 1)", [v]);
  await register(NOA, v, GATE, [
    { key: "brief", title: "Write the brief", gate: "review" },
    { key: "build", title: "Build it", blocked_by: ["brief"] },
    { key: "spec", title: "Write the spec", gate: "review" },
    { key: "open", title: "Plain task" },
  ]);
  const b = await claim(NOA, v, GATE, "brief", null);
  await as(NOA, "select public.complete_step($1, $2, 'brief', $3, $4)", [v, GATE, b.o_fence, b.o_secret]);
  const s = await claim(NOA, v, GATE, "spec", null);
  const [{ pid }] = await as(NOA, "select public.propose($1, 'canon/spec.md', 'The spec', 'the spec task') as pid", [v]);
  await as(NOA, "select public.complete_step($1, $2, 'spec', $3, $4, $5)", [v, GATE, s.o_fence, s.o_secret, pid]);
  return { v, pid };
})());
const gateUrl = (v, verb, key) => `${planUrl(v, GATE)}&${verb}=${key}`;
const gateStatus = async (v, key) =>
  (await sql("select s.status from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id where p.vault_id = $1 and p.path = $2 and s.key = $3",
    [v, GATE, key]))[0].status;

test("review gate: the list counts a task awaiting review, and the plan shows it first, who finished it, who approves it and what waits on it", async () => {
  const { v } = await seedGate();
  const list = await page(noa, tasksUrl(v));
  assert.match(list, /<strong>0 of 4 done<\/strong> <span class="muted">· 2 awaiting review · 1 ready · 1 blocked<\/span>/);
  assert.ok(list.indexOf('<h2 id="open-awaiting-review">Awaiting review <span class="muted">2</span></h2>') >= 0, "the open list has awaiting review");
  assert.ok(list.indexOf('<h2 id="open-awaiting-review">') < list.indexOf('<h2 id="open-ready">'), "and it comes first");
  const h = await page(noa, planUrl(v, GATE));
  assert.ok(h.indexOf('<h2 id="g-awaiting-review">Awaiting review <span class="muted">2</span></h2>') < h.indexOf('<h2 id="g-ready">'), "awaiting review comes first");
  const row = taskRow(h, "brief");
  assert.match(row, /<span class="badge warning">Awaiting review<\/span>/);
  assert.match(row, /Finished by you, and waiting for a person who can write the plan’s file to approve it\. The tasks waiting on it start only then\. You can approve it\./);
  assert.match(taskRow(h, "build"), /Blocked by Write the brief \(awaiting review\)\./);
});

test("review gate: an owner is offered Approve on a task awaiting review and on no other; a viewer is offered nothing, is sent back, and a crafted form is refused", async () => {
  const { v } = await seedGate();
  const h = await page(noa, planUrl(v, GATE));
  assert.match(taskRow(h, "brief"), new RegExp(`<a class="button" href="${planUrl(v, GATE).replace("?", "\\?")}&amp;approve=brief" aria-label="Approve the task Write the brief">Approve</a><details class="menu-wrap action-menu[\\s\\S]*&amp;cancel=brief"><span class="menu-item-title">Cancel</span>`));
  for (const key of ["build", "open"]) assert.doesNotMatch(taskRow(h, key), /Approve/, `no Approve on ${key}`);
  assert.match(h, /Approve passes a finished task’s review, so the tasks waiting on it can start\./);

  const r = await page(rex, planUrl(v, GATE));
  assert.doesNotMatch(r, /Approve<\/a>/);
  assert.doesNotMatch(taskRow(r, "brief"), /You can approve it/);
  const back = await landed(rex, await get(rex, gateUrl(v, "approve", "brief")));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only someone who can write this plan’s file approves its tasks."]);
  const [tone, , text] = flashOf(await landed(rex, await post(rex, `/v/${v}/tasks/plan`, { csrf: csrfOf(back), path: GATE, key: "brief", action: "approve", confirm: "1" })));
  assert.equal(tone, "danger");
  assert.match(text, /\(ref [0-9a-f]{8}\)$/);
  assert.equal(await gateStatus(v, "brief"), "review", "nothing approved");
});

test("review gate: the confirm page says to check the work first and what becomes ready, and opening it approves nothing", async () => {
  const { v } = await seedGate();
  const h = await page(noa, gateUrl(v, "approve", "brief"));
  assert.match(h, /<h1>Approve “Write the brief”\?<\/h1>/);
  assert.match(h, /Approving <strong>Write the brief<\/strong> <code>brief<\/code> passes its review\. It was finished by you, and has waited for a person to check the work\./);
  assert.match(h, /<li>Approve only once you’ve checked the work: the plan counts it as done from then on\.<\/li>/);
  assert.match(h, /<li>These tasks stop waiting on it, and any with nothing else left to wait for become ready for an agent to take: Build it <code>build<\/code>\.<\/li>/);
  assert.match(h, /<button class="danger solid">Approve “Write the brief”<\/button><a class="button quiet" href="[^"]+">Not yet<\/a>/);
  const { fields } = formFields(h, "Approve “Write the brief”");
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: GATE, key: "brief", action: "approve", confirm: "1" });
  assert.equal(await gateStatus(v, "brief"), "review", "asking approves nothing");
});

test("review gate: confirming approves it, says so as a success, logs it, and what waited on it is ready", async () => {
  const { v } = await seedGate();
  const { action, fields } = formFields(await page(noa, gateUrl(v, "approve", "brief")), "Approve “Write the brief”");
  const h = await landed(noa, await post(noa, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "“Write the brief” is approved and counts as done. Tasks that were waiting only on it are ready now."]);
  assert.equal(await gateStatus(v, "brief"), "done");
  assert.deepEqual(
    await sql("select actor, detail->>'step' as step from public.log where vault_id = $1 and path = $2 and event = 'step.approve' order by seq", [v, GATE]),
    [{ actor: NOA, step: "brief" }],
  );
  assert.match(taskRow(h, "brief"), /<span class="badge">Done<\/span>/);
  assert.match(taskRow(h, "build"), /<span class="badge success">Ready<\/span>/);
});

test("review gate: a task not awaiting review goes back with a warning, and a crafted form is refused with a reference and changes nothing", async () => {
  const { v } = await seedGate();
  const back = await landed(noa, await get(noa, gateUrl(v, "approve", "open")));
  assert.deepEqual(flashOf(back), ["warning", "status", "“Plain task” isn’t awaiting review, so there’s nothing to approve."]);
  const [tone, , text] = flashOf(await landed(noa, await post(noa, `/v/${v}/tasks/plan`, { csrf: csrfOf(back), path: GATE, key: "open", action: "approve", confirm: "1" })));
  assert.equal(tone, "danger");
  assert.match(text, /^Step &quot;open&quot; is not awaiting review; only a review-gated step its holder completed is approved\. \(ref [0-9a-f]{8}\)$/);
  assert.equal(await gateStatus(v, "open"), "open");
});

test("review gate: a task with a linked proposal links it, and the proposal's page says applying it also approves the task", async () => {
  const { v, pid } = await seedGate();
  assert.match(taskRow(await page(noa, planUrl(v, GATE)), "spec"), new RegExp(`Applying <a href="/v/${v}/proposals/${pid}">its proposal</a> also approves it\\.`));
  assert.match(
    await page(noa, gateUrl(v, "approve", "spec")),
    new RegExp(`<li>Its agent linked <a href="/v/${v}/proposals/${pid}">a proposal</a> as its work\\. Approving the task here leaves that proposal waiting for its own review\\.</li>`),
  );
  const p = await page(noa, `/v/${v}/proposals/${pid}`);
  assert.match(
    p,
    new RegExp(`<p class="callout info">This is the work of the task Write the spec <code>spec</code> in <a href="${planUrl(v, GATE).replace("?", "\\?")}">plans/gate\\.md</a>, which waits for a person’s review\\. Applying this proposal also approves the task, and the tasks waiting on it can start\\.</p>`),
  );
  await as(NOA, "select public.decide($1, 'approve')", [pid]);
  assert.equal(await gateStatus(v, "spec"), "done");
  assert.doesNotMatch(await page(noa, `/v/${v}/proposals/${pid}`), /This is the work of the task/, "once applied, the note goes");
});
