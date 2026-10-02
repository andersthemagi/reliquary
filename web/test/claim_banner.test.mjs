// The claim banner on the file page and the editor (src/claimbanner.ts): who
// is working on the file you are looking at, for how much longer, and the
// note they left, quoted. What a claim is and who may take or break one is
// proved in supabase/tests/path_claims_test.sql and the Claims page's own
// tests (claims_page.test.mjs); this file is about what a person sees on the
// file they opened, and that nothing about the claim can be forged or leaked
// into the page (test-audit skill: wiring, not the access rule).
//
// This file starts its own servers from dist/, one per person, people no
// other test file uses. Ola owns "Banner main" (open, canon/ is canon), Edda
// is an editor whose agents hold the claims below, Ria is a viewer.

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
const OLA = "00000000-0000-0000-0000-0000f5200001";
const EDDA = "00000000-0000-0000-0000-0000f5200002";
const RIA = "00000000-0000-0000-0000-0000f5200003";

const V = {};
const secrets = {};
const servers = {};

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

// `q` as a signed-in person, or, with `agent`, through a connection of
// theirs: the token's `act` claims are what make the log record an agent.
async function as(user, q, params = [], agent = null) {
  const claims = { sub: user, role: "authenticated" };
  if (agent) claims.act = { sub: agent.id, name: agent.name, tok: agent.id };
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// Claims `path` as `user`: through a new connection of theirs (an agent) or,
// without `agentName`, in person. Returns the secret claim_path hands back.
async function claim(user, path, { label = null, agentName = null, minutes = 120 } = {}) {
  let agent = null;
  if (agentName) {
    await as(user, "select public.create_access_token($1, 30, array[$2]::uuid[], 'write')", [agentName, V.main]);
    const [{ id }] = await sql("select id from public.access_tokens where name = $1 and user_id = $2 order by created_at desc limit 1", [agentName, user]);
    agent = { id, name: agentName };
  }
  const [{ o_secret }] = await as(user, "select o_secret from public.claim_path($1, $2, $3, $4)", [V.main, path, label, minutes], agent);
  return o_secret;
}

// A server from dist/, signed in as `user`.
async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/claim-banner-${name}-${process.pid}-${port}`;
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
const post = (s, path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);
const file = (path, extra = "") => `/v/${V.main}/file?path=${encodeURIComponent(path)}${extra}`;
const edit = (path) => `/v/${V.main}/edit?path=${encodeURIComponent(path)}`;
// The banner's tone and text, or null when the page has none.
const bannerOf = (h) => {
  const m = /<div class="callout (\w+)" id="claim-banner">([\s\S]*?)<\/div>/.exec(h);
  return m ? { tone: m[1], html: m[2] } : null;
};
const title = (b) => /<p class="callout-title"><strong>([\s\S]*?)<\/strong><\/p>/.exec(b.html)[1];

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'banner-ola@example.test'), ($2, 'banner-edda@example.test'), ($3, 'banner-ria@example.test') on conflict (id) do nothing`,
    [OLA, EDDA, RIA],
  );
  servers.ola = await start(OLA, "ola");
  servers.edda = await start(EDDA, "edda");
  servers.ria = await start(RIA, "ria");

  [{ id: V.main }] = await as(OLA, "select public.create_vault('Banner main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, OLA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, RIA, OLA]);
  await as(OLA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.main]);
  for (const p of ["notes/draft.md", "notes/draft.md.bak", "notes/person.md", "notes/loud.md", "notes/free.md", "notes/old.md", "notes/save.md"]) {
    await as(OLA, "select public.write_file($1, $2, 'Text')", [V.main, p]);
  }
  const [{ id: first }] = await as(OLA, "select public.propose($1, 'canon/terms.md', 'Net 30.', 'first') as id", [V.main]);
  await as(OLA, "select public.decide($1, 'approve')", [first]);

  // Ola's claim on old.md lapses at once; it is Ola's so Edda's five (the cap
  // per person) are all live below.
  await claim(OLA, "notes/old.md", { agentName: "banner-agent-old" });
  await sql("update public.path_claims set expires_at = now() - interval '1 minute' where vault_id = $1 and path = 'notes/old.md'", [V.main]);

  secrets.draft = await claim(EDDA, "notes/draft.md", { label: "rewriting the intro", agentName: "banner-agent-draft" });
  await claim(EDDA, "notes/person.md", { label: "by hand" });
  await claim(EDDA, "notes/loud.md", { label: `<img src=x onerror=alert(1)>"&'`, agentName: "banner-agent-loud" });
  await claim(EDDA, "notes/save.md", { agentName: "banner-agent-save" });
  await claim(EDDA, "canon/terms.md", { label: "tightening the terms", agentName: "banner-agent-canon" });
});

after(async () => {
  for (const s of Object.values(servers)) s?.child?.kill();
});

test("banner: an agent's claim on the file says whose agent, how long is left and its note, quoted", async () => {
  for (const tab of ["", "&tab=source", "&tab=history"]) {
    const b = bannerOf(await page(servers.ola, file("notes/draft.md", tab)));
    assert.ok(b, `a banner on the file's ${tab || "preview"} tab`);
    assert.equal(b.tone, "info");
    assert.equal(title(b), "banner-edda@example.test’s agent is working on this file");
    assert.match(b.html, /<p>The claim ends <time datetime="[^"]+" title="[^"]+">in 2 h<\/time>\./);
    assert.match(b.html, /The note on it, as typed: <q class="claim-note">rewriting the intro<\/q>/);
  }
});

test("banner: a claim taken in person, not by an agent, names the person alone", async () => {
  const b = bannerOf(await page(servers.ola, file("notes/person.md")));
  assert.equal(title(b), "banner-edda@example.test is working on this file");
  assert.match(b.html, /<q class="claim-note">by hand<\/q>/);
});

test("banner: your own agent's claim says your agent", async () => {
  const b = bannerOf(await page(servers.edda, file("notes/draft.md")));
  assert.equal(title(b), "Your agent is working on this file");
});

test("banner: a viewer sees it too", async () => {
  const b = bannerOf(await page(servers.ria, file("notes/draft.md")));
  assert.equal(title(b), "banner-edda@example.test’s agent is working on this file");
});

test("banner: no claim, an expired claim, or a claim on another path shows nothing, on the file page and the editor", async () => {
  // draft.md.bak begins with the claimed path notes/draft.md, and is not it.
  for (const path of ["notes/free.md", "notes/old.md", "notes/draft.md.bak"]) {
    assert.equal(bannerOf(await page(servers.ola, file(path))), null, `${path}: file page`);
    assert.equal(bannerOf(await page(servers.ola, edit(path))), null, `${path}: editor`);
  }
});

test("banner: the note is escaped and never becomes markup", async () => {
  const h = await page(servers.ola, file("notes/loud.md"));
  const b = bannerOf(h);
  assert.match(b.html, /<q class="claim-note">&lt;img src=x onerror=alert\(1\)&gt;&quot;&amp;&#39;<\/q>/);
  assert.doesNotMatch(h, /<img src=x/);
  const e = await page(servers.ola, edit("notes/loud.md"));
  assert.doesNotMatch(e, /<img src=x/);
});

test("banner: the editor says saving still works, and a save is not blocked by the claim", async () => {
  const h = await page(servers.ola, edit("notes/save.md"));
  const b = bannerOf(h);
  assert.equal(b.tone, "warning");
  assert.match(b.html, /You can still save: a claim never blocks a write\. If the file changes before you save, your save is refused and you see the new version first/);
  const version = /name="expected_version" value="([^"]+)"/.exec(h)[1];
  const r = await post(servers.ola, `/v/${V.main}/file`, { csrf: csrfOf(h), path: "notes/save.md", action: "write", content: "Saved while claimed", expected_version: version });
  assert.equal(r.status, 303);
  const after = await page(servers.ola, r.headers.get("location"));
  assert.deepEqual(flashOf(after), ["success", "status", "Saved notes/save.md."]);
  assert.match(after, /Saved while claimed/);
  assert.ok(bannerOf(after), "the claim is still there: saving does not release it");
});

test("banner: on a canon file the editor says a change is a proposal", async () => {
  const b = bannerOf(await page(servers.ola, edit("canon/terms.md")));
  assert.equal(b.tone, "warning");
  assert.match(b.html, /You can still propose a change: a claim never blocks one\. Your change is a proposal, so the file itself stays as it is until people approve it\./);
  assert.doesNotMatch(b.html, /You can still save/);
});

test("banner: no secret and no fence is rendered", async () => {
  const pages = [file("notes/draft.md"), file("notes/draft.md", "&tab=source"), file("notes/draft.md", "&tab=history"), edit("notes/draft.md")];
  for (const p of pages) {
    const h = await page(servers.ola, p);
    assert.doesNotMatch(h, new RegExp(secrets.draft), `${p}: the claim's secret`);
    assert.doesNotMatch(bannerOf(h).html, /secret|fence/i, `${p}: the banner`);
  }
});
