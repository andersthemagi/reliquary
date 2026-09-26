// Membership polish in the web UI (20260925160000_membership_polish.sql):
// people named by email where a co-member is shown, leaving a vault, the
// one-time notice when a vault is deleted, invites as the only way in, and
// the export's rate and clean failure. The database rules are in
// supabase/tests/membership_polish_test.sql.
//
// This file starts its own servers from dist/ (local sign-in), one per
// person, none of whom any other test file uses: Bea owns "Polish Team"
// (Cy edits; Di edited, then was removed), Zed has an account and no vault.
// Their ids start differently, so a short id is recognisable.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { PassThrough } from "node:stream";
import { constants, gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const BEA = "b1000000-0000-0000-0000-0000000000b1";
const CY = "b2000000-0000-0000-0000-0000000000b2";
const DI = "b3000000-0000-0000-0000-0000000000b3";
const ZED = "b4000000-0000-0000-0000-0000000000b4";

const servers = [];
const V = {};
const S = {};
let proposal = "";

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
  const loginFile = `/tmp/membership-login-${process.pid}-${port}`;
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
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/tokens"))[1];
const post = async (who, path, fields) =>
  fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: new URLSearchParams({ csrf: await csrfOf(who), ...fields }).toString(),
  });
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  // A refusal ends with its reference (failure.ts), different each time.
  return (/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "").replace(/ \(ref [0-9a-f]{8}\)$/, "");
};
const roleOf = async (vault, user) =>
  (await sql("select role from public.vault_members where vault_id = $1 and user_id = $2", [vault, user]))[0]?.role ?? "none";
const events = async (vault, event) =>
  Number((await sql("select count(*)::int as n from public.log where vault_id = $1 and event = $2", [vault, event]))[0].n);

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'bea@example.test'), ($2, 'Cy@Example.test'),
       ($3, 'di@example.test'), ($4, 'zed@example.test') on conflict (id) do nothing`,
    [BEA, CY, DI, ZED],
  );
  [{ id: V.team }] = await as(BEA, "select public.create_vault('Polish Team') as id");
  await as(BEA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.team]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.team, CY, BEA]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.team, DI, BEA]);
  await as(CY, "select public.write_file($1, 'notes/cy.md', 'From Cy.')", [V.team]);
  await as(DI, "select public.write_file($1, 'notes/di.md', 'From Di.')", [V.team]);
  [{ id: proposal }] = await as(CY, "select public.propose($1, 'canon/plan.md', 'The plan.', 'a plan') as id", [V.team]);
  await as(CY, "select public.comment_on_proposal($1, $2)", [proposal, `[[person:0:${BEA}]] <b>not bold</b>`]);
  await as(BEA, "select public.set_member($1, $2, null)", [V.team, DI]);
  S.bea = await startAs(BEA);
  S.cy = await startAs(CY);
  S.di = await startAs(DI);
  S.zed = await startAs(ZED);
});

after(() => {
  for (const { child } of servers) child.kill();
});

// ---------------------------------------------------------------------------
// People by email

test("people: the Account menu names you by your email", async () => {
  assert.match(await page("bea", "/"), /Signed in as <strong>bea@example\.test<\/strong>/);
  assert.match(await page("cy", "/"), /Signed in as <strong>cy@example\.test<\/strong>/);
});

test("people: an account with no email is named by a short id, as before", async () => {
  await sql("update auth.users set email = null where id = $1", [ZED]);
  try {
    assert.match(await page("zed", "/"), /Signed in as <strong>b4000000<\/strong>/);
  } finally {
    await sql("update auth.users set email = 'zed@example.test' where id = $1", [ZED]);
  }
});

test("people: Activity names a co-member by email and a former member by a short id", async () => {
  const h = await page("bea", `/v/${V.team}/activity`);
  assert.match(h, /<td class="small">cy@example\.test<\/td>/);
  assert.match(h, /<td class="small">b3000000<\/td>/);
  assert.doesNotMatch(h, /di@example\.test/);
  assert.match(h, /<option value="b2000000-0000-0000-0000-0000000000b2">cy@example\.test<\/option>/);
  const all = await page("bea", "/activity");
  assert.match(all, /<td class="small">cy@example\.test<\/td>/);
});

test("people: a proposal page, its thread and the review list name the proposer by email", async () => {
  const p = await page("bea", `/v/${V.team}/proposals/${proposal}`);
  assert.match(p, /<span>By cy@example\.test<\/span>/);
  assert.match(p, /Comment · cy@example\.test · revision 1/);
  assert.match(await page("bea", "/inbox"), /by cy@example\.test · /);
  assert.match(await page("bea", "/"), /by cy@example\.test · /);
});

test("people: text a member wrote can't pass for a person, and no marker reaches a page", async () => {
  const p = await page("bea", `/v/${V.team}/proposals/${proposal}`);
  assert.match(p, new RegExp(`\\[\\[person:0:${BEA}\\]\\] &lt;b&gt;not bold&lt;/b&gt;`));
  for (const path of ["/", "/inbox", "/activity", `/v/${V.team}/activity`, `/v/${V.team}/proposals/${proposal}`, `/v/${V.team}/file?path=notes/cy.md`]) {
    assert.doesNotMatch(await page("bea", path), /\[\[person:[0-9a-f]{24}:/, path);
  }
});

test("people: a former member sees nobody's email where they can no longer look", async () => {
  const h = await page("di", "/activity");
  assert.doesNotMatch(h, /bea@example\.test|cy@example\.test/);
  assert.equal((await get("di", `/v/${V.team}/activity`)).status, 404);
});

// ---------------------------------------------------------------------------
// Invites are the only way in

test("invites only: a forged role change for someone not in the vault is refused", async () => {
  const r = await post("bea", `/v/${V.team}/config/members/role`, { user: ZED, role: "editor" });
  assert.equal(await flashAfter("bea", r), "Not a member of this vault: invite them instead.");
  assert.equal(await roleOf(V.team, ZED), "none");
});

// ---------------------------------------------------------------------------
// Leaving

test("leave: Settings offers a member Leave, and tells the only owner why not", async () => {
  const cy = await page("cy", `/v/${V.team}/config`);
  assert.match(cy, /<h2>Leave<\/h2>/);
  assert.match(cy, new RegExp(`<a href="/v/${V.team}/config/leave">Leave this vault</a>`));
  const bea = await page("bea", `/v/${V.team}/config`);
  assert.match(bea, /You’re the only owner, so you can’t leave\./);
  assert.doesNotMatch(bea, /config\/leave"/);
  assert.match(await page("bea", `/v/${V.team}/config/leave`), /You’re the only owner of Polish Team\./);
});

test("leave: the only owner's forged post is refused by the database", async () => {
  const r = await post("bea", `/v/${V.team}/config/leave`, {});
  assert.equal(await flashAfter("bea", r), "You are this vault&#39;s only owner: make someone else an owner first, or delete the vault.");
  assert.equal(await roleOf(V.team, BEA), "owner");
});

test("leave: an outsider's post finds no vault", async () => {
  assert.equal((await post("zed", `/v/${V.team}/config/leave`, {})).status, 404);
  assert.equal((await get("zed", `/v/${V.team}/config/leave`)).status, 404);
});

test("leave: the confirm page says what goes, and the post leaves, logged", async () => {
  const h = await page("cy", `/v/${V.team}/config/leave`);
  assert.match(h, /<h1>Leave Polish Team<\/h1>/);
  assert.match(h, /To come back, an owner has to invite you again\./);
  assert.match(h, new RegExp(`<form method="post" action="/v/${V.team}/config/leave" class="actions">`));
  assert.match(h, /<button class="danger">Leave Polish Team<\/button>/);
  assert.equal(await roleOf(V.team, CY), "editor", "a GET changes nothing");
  const r = await post("cy", `/v/${V.team}/config/leave`, {});
  assert.equal(r.headers.get("location"), "/");
  assert.equal(await flashAfter("cy", r), "You left Polish Team. You and your agents can no longer open it.");
  assert.equal(await roleOf(V.team, CY), "none");
  assert.equal(await events(V.team, "member.leave"), 1);
  assert.equal((await get("cy", `/v/${V.team}`)).status, 404);
  assert.match(await page("bea", `/v/${V.team}/activity`), /Left the vault/);
});

// ---------------------------------------------------------------------------
// Deletion notices

test("notices: the delete page says the other members will be told", async () => {
  [{ id: V.doomed }] = await as(BEA, "select public.create_vault('Polish Doomed') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.doomed, CY, BEA]);
  assert.match(
    await page("bea", `/v/${V.doomed}/config/delete`),
    /The other members are told once, on their Home page, within 30 days: the vault’s name, your email and the date\./,
  );
});

test("notices: a former member sees the deletion once on Home; nobody else does", async () => {
  const r = await post("bea", `/v/${V.doomed}/config/delete`, { confirm_name: "Polish Doomed" });
  assert.equal(r.status, 303);
  const day = new Date().toISOString().slice(0, 10);
  const first = await page("cy", "/");
  assert.match(first, new RegExp(`<strong>Polish Doomed</strong> was deleted by bea@example\\.test on ${day}\\.`));
  assert.doesNotMatch(await page("cy", "/"), /Polish Doomed/, "once");
  assert.doesNotMatch(await page("bea", "/"), /was deleted by/);
  assert.doesNotMatch(await page("zed", "/"), /Polish Doomed/);
});

// Home as the server builds it (pages.ts routes(), in one transaction), in
// this process, with a request whose page fails after its queries, while
// rendering: the notice is taken only by a page that was built.
test("notices: a Home page that fails while rendering leaves the notice for next time", async () => {
  const [{ id }] = await as(BEA, "select public.create_vault('Polish Doomed Twice') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [id, CY, BEA]);
  await as(BEA, "select public.delete_vault($1, 'Polish Doomed Twice')", [id]);
  const waiting = async () =>
    Number((await sql("select count(*) as n from private.vault_deletion_notices where user_id = $1 and vault_name = 'Polish Doomed Twice'", [CY]))[0].n);
  const { usePool } = await import("../dist/db.js");
  const { routes } = await import("../dist/pages.js");
  const db = new pg.Pool({ connectionString: WEB_DB, max: 1 });
  usePool(db);
  const home = (fail) => ({
    userId: CY,
    csrf: "0",
    url: new URL("http://web.test/"),
    form: new URLSearchParams(),
    method: "GET",
    theme: "auto",
    mcpUrl: "",
    setFlash() {},
    get flash() {
      if (fail) throw new Error("rendering failed");
      return undefined;
    },
  });
  try {
    await assert.rejects(routes(home(true)), /rendering failed/);
    assert.equal(await waiting(), 1, "a page that failed to render leaves the notice");
    const shown = await routes(home(false));
    assert.match(shown.html, /<strong>Polish Doomed Twice<\/strong> was deleted by/);
    assert.equal(await waiting(), 0, "a page that was built takes it");
  } finally {
    await db.end();
  }
});

// ---------------------------------------------------------------------------
// Export

test("export: after 10 exports of a vault in an hour, the next is refused with the reason", async () => {
  [{ id: V.exp }] = await as(BEA, "select public.create_vault('Polish Export') as id");
  await as(BEA, "select public.write_file($1, 'a.md', 'A')", [V.exp]);
  for (let i = 0; i < 10; i++) await as(BEA, "select public.export_vault($1)", [V.exp]);
  const r = await post("bea", `/v/${V.exp}/config/export`, {});
  assert.equal(await flashAfter("bea", r), "This vault has been exported 10 times in the last hour: try again later.");
  assert.equal(await events(V.exp, "vault.export"), 10);
});

// writeExport with a page source that fails on its second page: what a
// download that breaks part-way leaves behind.
async function exportWith(failSecondPage) {
  const { writeExport } = await import("../dist/export.js");
  const h = {
    export: "00000000-0000-0000-0000-000000000000",
    vault: { id: "00000000-0000-0000-0000-000000000000", name: "Broken", default_policy: "open", created_at: "2026-09-25T00:00:00.000Z" },
    exported_at: "2026-09-25T12:00:00.000Z",
    exported_by: BEA,
    files: 300,
    bytes: 0,
    rules: [],
    variables: [],
  };
  let calls = 0;
  const pages = async (after, limit) => {
    calls++;
    if (calls === 2 && failSecondPage) throw new Error("database went away");
    const start = calls === 1 ? 0 : limit;
    const n = calls === 1 ? limit : 100;
    return Array.from({ length: n }, (_, i) => ({
      path: `f/${String(start + i).padStart(4, "0")}.md`,
      body: randomBytes(2048).toString("hex"),
      updated_at: new Date("2026-09-25T00:00:00Z"),
      version_id: "00000000-0000-0000-0000-000000000000",
    }));
  };
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  let error;
  await writeExport(BEA, h, out, pages).catch((e) => (error = e));
  return { error, bytes: Buffer.concat(chunks) };
}

const tarNames = (tar) => {
  const names = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const name = hdr.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(hdr.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
    names.push(name);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
};

test("export: a whole archive gunzips, ends with the manifest and the end-of-archive blocks", async () => {
  const { error, bytes } = await exportWith(false);
  assert.equal(error, undefined);
  const tar = gunzipSync(bytes);
  const names = tarNames(tar);
  assert.equal(names.length, 301);
  assert.equal(names.at(-1), "broken-2026-09-25/reliquary-export.json");
  assert.ok(tar.subarray(-1024).every((b) => b === 0));
});

test("export: a failure mid-stream aborts: no gzip trailer, no manifest, no end-of-archive", async () => {
  const { error, bytes } = await exportWith(true);
  assert.ok(error, "the write rejects, so the server cuts the download");
  assert.ok(bytes.length > 0, "part of the archive was already sent");
  assert.throws(() => gunzipSync(bytes), /unexpected end of file/);
  const partial = gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH });
  const names = tarNames(partial);
  assert.ok(names.length > 0 && names.length <= 200, `${names.length} entries`);
  assert.ok(!names.some((n) => n.endsWith("reliquary-export.json")), "no manifest");
});
