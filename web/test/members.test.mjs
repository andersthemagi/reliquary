// Members and invites in the web UI (src/members.ts), driven over HTTP. The
// database rules are in supabase/tests/invites_test.sql.
//
// This file starts its own servers from dist/ (local sign-in), one per
// person, none of whom any other test file uses: Olga owns "Members Team",
// Paul edits it, Ivan is invited (his address is mixed case), and Zoe has an
// account and is never in the vault. Their emails are in the stubbed
// auth.users.

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
const OLGA = "00000000-0000-0000-0000-0000000000a1";
const IVAN = "00000000-0000-0000-0000-0000000000a2";
const PAUL = "00000000-0000-0000-0000-0000000000a3";
const ZOE = "00000000-0000-0000-0000-0000000000a4";

const servers = [];
const V = {};
const S = {}; // person -> { origin, cookie }

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
  const loginFile = `/tmp/members-login-${process.pid}-${port}`;
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
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/"))[1];
const post = async (who, path, fields, { csrf = true } = {}) =>
  fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: new URLSearchParams({ ...(csrf ? { csrf: await csrfOf(who) } : {}), ...fields }).toString(),
  });
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  return /<p class="callout info flash" role="status">([^<]*)<\/p>/.exec(h)?.[1] ?? "";
};
const members = (id) => `/v/${id}/config/members`;
const roleOf = async (vault, user) =>
  (await sql("select role from public.vault_members where vault_id = $1 and user_id = $2", [vault, user]))[0]?.role ?? "none";
const tokenOf = (h) => /\/invite\?token=(rli_[0-9a-f]{64})/.exec(h)?.[1];
const tokens = {};

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'olga@example.test'), ($2, 'Ivan@Example.test'),
       ($3, 'paul@example.test'), ($4, 'zoe@example.test') on conflict (id) do nothing`,
    [OLGA, IVAN, PAUL, ZOE],
  );
  [{ id: V.team }] = await as(OLGA, "select public.create_vault('Members Team') as id");
  [{ id: V.paul }] = await as(PAUL, "select public.create_vault('Paul own') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.team, PAUL, OLGA]);
  await as(PAUL, "select public.create_access_token('Paul laptop', 30, array[$1]::uuid[], 'read')", [V.team]);
  await as(PAUL, "select public.create_access_token('Paul both', 30, array[$1, $2]::uuid[], 'write')", [V.team, V.paul]);
  await as(PAUL, "select public.create_access_token('Paul private', 30, array[$1]::uuid[], 'write')", [V.paul]);
  await sql("update public.access_tokens set client_name = 'Cursor <b>bold</b>', last_used_at = now() where name = 'Paul laptop'");
  S.olga = await startAs(OLGA);
  S.ivan = await startAs(IVAN);
  S.paul = await startAs(PAUL);
  S.zoe = await startAs(ZOE);
});

after(() => {
  for (const { child } of servers) child.kill();
});

// ---------------------------------------------------------------------------
// The Members page

test("members: Settings links to Members, which lists each member by email and role, never by id", async () => {
  assert.match(await page("olga", `/v/${V.team}/config`), new RegExp(`<a href="/v/${V.team}/config/members">Members</a>`));
  const h = await page("olga", members(V.team));
  assert.match(h, /<h1>Members<\/h1>/);
  assert.match(h, new RegExp(`href="/v/${V.team}/config" aria-current="page">Settings`));
  assert.match(h, /<td>olga@example\.test <span class="badge">You<\/span><\/td>/);
  assert.match(h, /<td>paul@example\.test<\/td>/);
  assert.match(h, /Owner<span class="muted token-client">The only owner<\/span>/);
  assert.match(h, /<option value="editor" selected>Editor<\/option>/);
  assert.match(h, /This vault has one owner\. Two are recommended/);
  assert.doesNotMatch(h, new RegExp(`>${PAUL}|Account ${PAUL.slice(0, 8)}`));
});

test("members: an editor sees the members but no invite form, role controls, invites or connections", async () => {
  const h = await page("paul", members(V.team));
  assert.match(h, /<td>olga@example\.test<\/td>/);
  assert.match(h, /Only owners invite people, change roles or remove members\./);
  assert.doesNotMatch(h, /Invite someone|<select name="role"|Pending invites|Agent connections|\/remove\?user=/);
});

test("members: an outsider gets not found, and no member's email", async () => {
  const r = await get("ivan", members(V.team));
  assert.equal(r.status, 404);
  // Their own address is in the Account menu (F123); no member's is anywhere.
  assert.doesNotMatch(await r.text(), /olga@example\.test|paul@example\.test/);
});

test("home: someone with no vaults is told to open their invite link", async () => {
  assert.match(await page("ivan", "/"), /Joining someone else’s vault\? Open the invite link they sent you\./);
});

// ---------------------------------------------------------------------------
// Invites

test("invite: the owner makes an invite and sees its link once, to copy and send themself", async () => {
  const r = await post("olga", `${members(V.team)}/invite`, { email: " Ivan@example.TEST ", role: "viewer" });
  assert.equal(r.status, 200);
  const h = await r.text();
  tokens.ivan = tokenOf(h);
  assert.ok(tokens.ivan, "the link is on the page");
  assert.match(h, new RegExp(`<p class="secret">${S.olga.origin.replace(/\./g, "\\.")}/invite\\?token=${tokens.ivan}</p>`));
  assert.match(h, /Invite for ivan@example\.test \(Viewer\)/);
  assert.match(h, /Copy this link and send it to them yourself: Reliquary doesn’t email invites yet\./);
  assert.match(h, /only for someone signed in as <strong>ivan@example\.test<\/strong>/);
  const again = await page("olga", members(V.team));
  assert.equal(tokenOf(again), undefined, "shown once");
  assert.match(again, /<tr><td>ivan@example\.test<\/td><td class="small">Viewer<\/td>/);
  const [row] = await sql("select count(*)::int as n from private.vault_invites where vault_id = $1 and email = 'ivan@example.test'", [V.team]);
  assert.equal(row.n, 1);
});

test("invite: a bad address, an unknown role or a member's address is refused with the database's reason", async () => {
  assert.equal(await flashAfter("olga", await post("olga", `${members(V.team)}/invite`, { email: "nope", role: "viewer" })),
    "Enter an email address, like name@example.com.");
  assert.equal(await flashAfter("olga", await post("olga", `${members(V.team)}/invite`, { email: "zoe@example.test", role: "admin" })),
    "A role is owner, editor or viewer.");
  assert.equal(await flashAfter("olga", await post("olga", `${members(V.team)}/invite`, { email: "PAUL@example.test", role: "viewer" })),
    "That address already belongs to a member of this vault.");
});

test("invite: an editor's forged invite is refused by the database", async () => {
  assert.equal(await flashAfter("paul", await post("paul", `${members(V.team)}/invite`, { email: "zoe@example.test", role: "owner" })),
    "Only owners invite people.");
  const [row] = await sql("select count(*)::int as n from private.vault_invites where email = 'zoe@example.test'");
  assert.equal(row.n, 0);
});

test("invite: a post without the form token makes nothing", async () => {
  const r = await post("olga", `${members(V.team)}/invite`, { email: "zoe@example.test", role: "viewer" }, { csrf: false });
  assert.equal(r.status, 403);
  const [row] = await sql("select count(*)::int as n from private.vault_invites where email = 'zoe@example.test'");
  assert.equal(row.n, 0);
});

test("invite page: someone signed in with another address is told whose it is, and can't join", async () => {
  const h = await page("zoe", `/invite?token=${tokens.ivan}`);
  assert.match(h, /<h1>Join Members Team<\/h1>/);
  assert.match(h, /This invite is for <strong>i•••@example\.test<\/strong>, and you’re signed in as <strong>zoe@example\.test<\/strong>\./);
  assert.doesNotMatch(h, /ivan@/i);
  assert.doesNotMatch(h, /<form method="post" action="\/invite"/);
  const r = await post("zoe", "/invite", { token: tokens.ivan });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /This invite is for a different email address\./);
  assert.equal(await roleOf(V.team, ZOE), "none");
});

test("invite page: the invitee sees the vault and role, and joins", async () => {
  const h = await page("ivan", `/invite?token=${tokens.ivan}`);
  assert.match(h, /You’ve been invited to <strong>Members Team<\/strong> as a <strong>Viewer<\/strong>\./);
  assert.match(h, /<button class="primary">Join Members Team<\/button>/);
  const flash = await flashAfter("ivan", await post("ivan", "/invite", { token: tokens.ivan }));
  assert.equal(flash, "You’re a member of Members Team, as a viewer.");
  assert.equal(await roleOf(V.team, IVAN), "viewer");
  assert.match(await page("ivan", "/"), /Members Team/);
});

test("invite page: a used link says so, and can't be used again", async () => {
  assert.match(await page("ivan", `/invite?token=${tokens.ivan}`), /This invite has already been used\./);
  const r = await post("zoe", "/invite", { token: tokens.ivan });
  assert.equal(r.status, 400);
  assert.equal(await roleOf(V.team, ZOE), "none");
});

test("invite page: a malformed or unknown link is not found", async () => {
  for (const t of ["", "rli_" + "0".repeat(64), "nonsense", tokens.ivan.slice(0, 40)]) {
    const r = await get("zoe", `/invite?token=${t}`);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /This invite link isn’t valid\./);
  }
});

test("invite: revoking a pending invite kills its link", async () => {
  const h = await (await post("olga", `${members(V.team)}/invite`, { email: "zoe@example.test", role: "editor" })).text();
  tokens.zoe = tokenOf(h);
  const [{ id }] = await sql("select id from private.vault_invites where email = 'zoe@example.test' and revoked_at is null");
  assert.match(await page("olga", members(V.team)), new RegExp(`action="/v/${V.team}/config/members/invites/${id}/revoke"`));
  assert.equal(await flashAfter("olga", await post("olga", `${members(V.team)}/invites/${id}/revoke`, {})), "Invite revoked. Its link no longer works.");
  assert.match(await page("zoe", `/invite?token=${tokens.zoe}`), /This invite was withdrawn\./);
  assert.equal((await post("zoe", "/invite", { token: tokens.zoe })).status, 400);
  assert.equal(await roleOf(V.team, ZOE), "none");
  assert.match(await page("olga", members(V.team)), /No invites waiting\./);
});

// ---------------------------------------------------------------------------
// Roles and removal

test("members: the owner changes a role", async () => {
  assert.equal(await flashAfter("olga", await post("olga", `${members(V.team)}/role`, { user: IVAN, role: "editor" })), "Role changed to Editor.");
  assert.equal(await roleOf(V.team, IVAN), "editor");
});

test("members: the only owner can't step down, even by a forged form", async () => {
  const flash = await flashAfter("olga", await post("olga", `${members(V.team)}/role`, { user: OLGA, role: "viewer" }));
  assert.equal(flash, "A vault needs at least one owner: make someone else an owner first.");
  assert.equal(await roleOf(V.team, OLGA), "owner");
});

test("members: an editor's forged role change is refused by the database", async () => {
  assert.equal(await flashAfter("paul", await post("paul", `${members(V.team)}/role`, { user: PAUL, role: "owner" })), "Only owners manage members.");
  assert.equal(await roleOf(V.team, PAUL), "editor");
});

test("members: removing asks first, saying what goes and what stays, then removes", async () => {
  const h = await page("olga", `${members(V.team)}/remove?user=${PAUL}`);
  assert.match(h, /<h1>Remove paul@example\.test<\/h1>/);
  assert.match(h, /Their 2 agent connections to this vault stop working on the next request\./);
  assert.match(h, /What they wrote, proposed and approved stays/);
  assert.equal(await roleOf(V.team, PAUL), "editor", "nothing happens on GET");
  const r = await post("olga", `${members(V.team)}/remove`, { user: IVAN });
  assert.equal(await flashAfter("olga", r), "Removed. They can no longer open this vault, and nor can their agents.");
  assert.equal(await roleOf(V.team, IVAN), "none");
  assert.equal((await get("ivan", `/v/${V.team}`)).status, 404);
});

// ---------------------------------------------------------------------------
// Members' agent connections

test("connections: the owner sees each member's connections to this vault, escaped, and none that don't reach it", async () => {
  const h = await page("olga", members(V.team));
  assert.match(h, /<h2>Agent connections<\/h2>/);
  assert.match(h, /<td class="small">paul@example\.test<\/td>\s*<td>Paul laptop<span class="muted token-client">MCP token · Cursor &lt;b&gt;bold&lt;\/b&gt;<\/span><\/td>/);
  assert.match(h, /Paul both/);
  assert.doesNotMatch(h, /Paul private/);
});

test("connections: revoking one cuts it off from this vault only", async () => {
  const [{ id }] = await sql("select id from public.access_tokens where name = 'Paul both'");
  const flash = await flashAfter("olga", await post("olga", `${members(V.team)}/connections/${id}/revoke`, {}));
  assert.equal(flash, "Connection cut off from this vault. It stops working here on its next request.");
  const [t] = await sql("select revoked_at, all_vaults, vault_ids from public.access_tokens where id = $1", [id]);
  assert.equal(t.revoked_at, null);
  assert.deepEqual(t.vault_ids, [V.paul]);
  assert.doesNotMatch(await page("olga", members(V.team)), /Paul both/);
});

test("connections: an editor's forged revoke is refused by the database", async () => {
  const [{ id }] = await sql("select id from public.access_tokens where name = 'Paul laptop'");
  assert.equal(await flashAfter("paul", await post("paul", `${members(V.team)}/connections/${id}/revoke`, {})),
    "Only owners revoke agent connections.");
  const [t] = await sql("select revoked_at from public.access_tokens where id = $1", [id]);
  assert.equal(t.revoked_at, null);
});

// ---------------------------------------------------------------------------

test("activity: invites show in the vault's activity, without addresses", async () => {
  const h = await page("olga", `/v/${V.team}/activity`);
  assert.match(h, /Invited someone/);
  assert.match(h, /Joined by invite/);
  assert.match(h, /Withdrew an invite/);
  assert.match(h, /Cut off a member’s connection/);
  const rows = await sql("select count(*)::int as n from public.log where vault_id = $1 and detail::text like '%@%'", [V.team]);
  assert.equal(rows[0].n, 0);
});

test("logs: no invite token or email address reaches the server logs", async () => {
  for (const { s } of servers) {
    assert.doesNotMatch(s.log, /rli_|@/);
  }
});
