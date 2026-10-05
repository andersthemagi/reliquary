// A new file whose path Windows would read otherwise (a backslash, a colon,
// a device name) is refused in the web editor with the database's reason
// (20260926130000_portable_paths.sql), and nothing is saved. Signed in as
// Ana (owner) in the seed's Team vault; paths of its own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, LOGIN_FILE } = process.env;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, fields) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });
const csrf = async (path) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];
// &amp; decodes last: decoding it first would turn a literal "&amp;lt;" in
// the source into "&lt;", which the next step would wrongly decode again.
const decode = (s) => s.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

// Creates a file at `path` in the editor; the page the refusal answers with.
async function create(path) {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "create", path, content: "Portable?" });
  assert.equal(r.status, 400);
  return decode(await r.text());
}

test("portable paths: the editor refuses a backslash with the reason, and saves nothing", async () => {
  const shown = await create("notes\\..\\..\\portable-x.md");
  assert.match(shown, /A file path can't contain a backslash \(\\\): Windows reads it as a folder separator/);
  assert.equal((await get(`${V}/file?path=${encodeURIComponent("notes\\..\\..\\portable-x.md")}`)).status, 404);
});

test("portable paths: the editor refuses a colon and a device name with the reason", async () => {
  assert.match(await create("notes/portable:x.md"), /A file path can't contain any of : \* \? " < > \| \(this one has :\)/);
  assert.match(await create("notes/portable/aux.md"), /A file or folder can't be named AUX, with or without an extension/);
});
