// A path's named owner, in the web app, actually gets the controls the
// database already lets them use (F444: comment_on_proposal and
// edit_and_approve now check can_write_path, and the file, editor and
// proposal pages now call writablePath() instead of canWrite() alone). The
// access rules themselves are path_ownership_test.sql's (F407-F409, F444);
// these tests are about what a named owner who is a plain viewer actually
// sees and can do in the web app, which the database layer can't prove on
// its own.
//
// This file starts its own servers and seeds its own vault ("Owner
// Review"), unrelated to any other test file's data: Moe owns the vault,
// Remy is an editor, Sol a viewer named the sole owner of specs/ (canon,
// quorum 1).

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
const MOE = "00000000-0000-0000-0000-000000000bd1";
const REMY = "00000000-0000-0000-0000-000000000bd2";
const SOL = "00000000-0000-0000-0000-000000000bd3";

let V;
let moe;
let remy;
let sol;

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

async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", log: "", child: null };
  const loginFile = `/tmp/path-owner-review-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.child.stdout.on("data", (d) => (s.log += d));
  s.child.stderr.on("data", (d) => (s.log += d));
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

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'moe@example.test'), ($2, 'remy@example.test'), ($3, 'sol@example.test')
             on conflict (id) do nothing`, [MOE, REMY, SOL]);
  moe = await start(MOE, "moe");
  remy = await start(REMY, "remy");
  sol = await start(SOL, "sol");

  [{ id: V }] = await as(MOE, "select public.create_vault('Owner Review', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V, REMY, MOE]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V, SOL, MOE]);
  // Written before Sol owns specs/: once she does, no vault-wide override
  // lets Moe write it directly anymore either.
  await as(MOE, "select public.write_file($1, 'specs/plan.md', 'first draft')", [V]);
  await as(MOE, "select public.set_policy($1, 'specs/', 'canon', 1)", [V]);
  await as(MOE, "select public.set_path_owner($1, 'specs/', $2)", [V, SOL]);
});

after(async () => {
  moe?.child?.kill();
  remy?.child?.kill();
  sol?.child?.kill();
});

test("file page: Sol, the path's owner but a plain viewer, gets Edit; Remy, an editor but not the owner, still gets Propose a change", async () => {
  const forSol = await page(sol, `/v/${V}/file?path=specs%2Fplan.md`);
  assert.match(forSol, /<a class="button primary" href="\/v\/[^"]+\/edit\?path=specs%2Fplan\.md">Edit<\/a>/);
  const forRemy = await page(remy, `/v/${V}/file?path=specs%2Fplan.md`);
  assert.match(forRemy, /<a class="button" href="\/v\/[^"]+\/edit\?path=specs%2Fplan\.md">Propose a change<\/a>/);
});

test("edit: Sol opens the editor and saves specs/plan.md directly, no proposal", async () => {
  const h = await page(sol, `/v/${V}/edit?path=specs%2Fplan.md`);
  assert.match(h, /<button class="primary" form="edit-file">Save<\/button>/);
  const { action, fields } = formFields(h, "Save");
  const r = await post(sol, action, { ...fields, content: "Sol's direct edit" });
  const landedPage = await landed(sol, r);
  assert.match(landedPage, /Saved specs\/plan\.md\./);
  assert.equal(
    (await sql("select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = 'specs/plan.md'", [V]))[0].body,
    "Sol's direct edit",
  );
});

test("proposal page: Sol, the owner, sees Approve, Edit-then-approve and Comment on Remy's proposal; comments, then approves", async () => {
  const [{ id: pid }] = await as(REMY, "select public.propose($1, 'specs/plan.md', 'Remy proposes', 'why') as id", [V]);
  const h = await page(sol, `/v/${V}/proposals/${pid}`);
  assert.match(h, /<button class="primary" name="decision" value="approve">Approve<\/button>/);
  assert.match(h, /Edit, then approve<\/a>/);
  assert.match(h, /<form method="post" action="\/v\/[^"]+\/proposals\/[^"]+\/comment" class="panel comment">/);

  const commentToken = csrfOf(h);
  await post(sol, `/v/${V}/proposals/${pid}/comment`, { csrf: commentToken, body: "looks fine to me" });
  const afterComment = await page(sol, `/v/${V}/proposals/${pid}`);
  assert.match(afterComment, /<p>looks fine to me<\/p>/);

  const { action, fields } = formFields(afterComment, "Approve");
  const r = await post(sol, action, { ...fields, note: "", decision: "approve" });
  const landedPage = await landed(sol, r);
  assert.match(landedPage, /Approved and applied\./);
});

test("edit, then approve: Sol edits Remy's next proposal herself and approves it in one step", async () => {
  const [{ id: pid }] = await as(REMY, "select public.propose($1, 'specs/plan.md', 'Remy proposes again', 'why') as id", [V]);
  const h = await page(sol, `/v/${V}/proposals/${pid}/edit`);
  assert.match(h, /<button class="primary" form="edit-approve">Save edit and approve<\/button>/);
  const { action, fields } = formFields(h, "Save edit and approve");
  const r = await post(sol, action, { ...fields, content: "Sol's edit of Remy's proposal", note: "tightened it up" });
  const landedPage = await landed(sol, r);
  assert.match(landedPage, /Approved and applied\./);
  assert.equal(
    (await sql("select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = 'specs/plan.md'", [V]))[0].body,
    "Sol's edit of Remy's proposal",
  );
});

test("folder page: Sol gets New file inside the folder she owns", async () => {
  const h = await page(sol, `/v/${V}/tree?path=specs%2F`);
  assert.match(h, /<a class="button primary" href="\/v\/[^"]+\/new\?dir=specs%2F">New file here<\/a>/);
});
