// Proposing to delete a canon file from the web UI: the file's edit page
// (reached from the file page's "Propose a change") has a "Propose deleting
// this file" form (action propose-delete in src/pages.ts). Posting it makes a
// delete proposal and leaves the file; approving it removes the file. The
// database rules are in supabase/tests/delete_test.sql.
//
// This file starts its own server from dist/, signed in as Pim, a person no
// other test file uses, so nothing here moves another file's counts (Review
// in web.test.mjs is Ana's). Pim owns "Pim delete", with a canon/ rule and
// one approved canon file.

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
const PIM = "00000000-0000-0000-0000-0000000001a9";
const PATH = "canon/old-terms.md";

let child;
let log = "";
let vault = "";
const s = { origin: "", cookie: "" };

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

async function asPim(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: PIM, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const get = (path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const flash = (h) => /<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "";
const filePage = () => `/v/${vault}/file?path=${encodeURIComponent(PATH)}`;
const editPage = () => `/v/${vault}/edit?path=${encodeURIComponent(PATH)}`;

// The fields of the form on `h` whose submit button says `label`.
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields };
}

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/propose-delete-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: PIM, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];

  [{ id: vault }] = await asPim("select public.create_vault('Pim delete', 'open') as id");
  await asPim("select public.set_policy($1, 'canon/', 'canon', 1)", [vault]);
  const [{ id: first }] = await asPim("select public.propose($1, $2, 'Net 90.', 'first') as id", [vault, PATH]);
  await asPim("select public.decide($1, 'approve')", [first]);
});

after(async () => {
  child?.kill();
});

let proposal = "";

test("propose-delete: from a canon file's page, a person proposes deleting it, and the file stays until approved", async () => {
  const file = await page(filePage());
  assert.match(file, new RegExp(`href="/v/${vault}/edit\\?path=canon%2Fold-terms\\.md"`), "the file page links to its edit page");
  const { action, fields } = formFields(await page(editPage()), "Propose deleting this file");
  assert.equal(fields.action, "propose-delete");
  assert.equal(fields.path, PATH);

  const r = await post(action, fields);
  assert.equal(r.status, 303);
  const loc = r.headers.get("location");
  const m = new RegExp(`^/v/${vault}/proposals/([0-9a-f-]{36})$`).exec(loc);
  assert.ok(m, loc);
  proposal = m[1];
  const h = await page(loc);
  assert.equal(flash(h), "Proposed. It applies once enough people approve it.");
  assert.match(h, /Delete old-terms\.md|Deletes the file/);

  const [row] = await sql("select kind, status, proposed_by, agent from public.proposals where id = $1", [proposal]);
  assert.deepEqual(row, { kind: "delete", status: "open", proposed_by: PIM, agent: null });
  assert.equal((await get(filePage())).status, 200);
  assert.match(await page(filePage()), /Net 90\./);
});

test("propose-delete: approving the proposal removes the file, and the log records the delete", async () => {
  assert.ok(proposal, "the proposal from the previous test");
  const { action, fields } = formFields(await page(`/v/${vault}/proposals/${proposal}`), "Approve");
  const r = await post(action, { ...fields, decision: "approve" });
  assert.equal(r.status, 303);
  assert.equal(flash(await page(r.headers.get("location"))), "Approved and applied.");
  assert.equal((await get(filePage())).status, 404);
  const [{ n }] = await sql("select count(*)::int as n from public.log where vault_id = $1 and event = 'file.delete' and path = $2", [vault, PATH]);
  assert.equal(n, 1);
});
