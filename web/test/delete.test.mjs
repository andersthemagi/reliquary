// Deleting files from the browser, signed in as Ana (owner). Open files
// delete directly; canon files refuse, and stay. The database rules are in
// supabase/tests/delete_test.sql. Uses its own path so other files' counts
// and proposals are untouched. Seed: test/seed.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, LOGIN_FILE } = process.env;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const csrf = async (path) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

test("delete: an open file is deleted and the vault says so", async () => {
  const path = "notes/delete-me.md";
  let token = await csrf(`${V}/new`);
  assert.equal((await post(`${V}/file`, { csrf: token, action: "create", path, content: "Temporary." })).status, 303);
  assert.equal((await get(`${V}/file?path=${encodeURIComponent(path)}`)).status, 200);

  token = await csrf(`${V}/file?path=${encodeURIComponent(path)}`);
  const r = await post(`${V}/file`, { csrf: token, action: "delete", path });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), V);
  assert.match(await page(V), /Deleted notes\/delete-me\.md\./);
  assert.equal((await get(`${V}/file?path=${encodeURIComponent(path)}`)).status, 404);
});

test("delete: needs the form token", async () => {
  const r = await post(`${V}/file`, { action: "delete", path: "notes/md.md" });
  assert.equal(r.status, 403);
  assert.equal((await get(`${V}/file?path=notes%2Fmd.md`)).status, 200);
});

test("delete: a canon file can't be deleted directly, even by the owner", async () => {
  const token = await csrf(`${V}/file?path=canon%2Fpricing.md`);
  const r = await post(`${V}/file`, { csrf: token, action: "delete", path: "canon/pricing.md" });
  assert.equal(r.status, 400);
  // The refusal is on the page that offers what to do instead.
  assert.match(await r.text(), /<div class="callout danger" role="alert"><p>[^<]*is canon[^<]*\(ref [0-9a-f]{8}\)<\/p><\/div>[\s\S]*Propose deleting pricing\.md/);
  assert.equal((await get(`${V}/file?path=canon%2Fpricing.md`)).status, 200);
});
