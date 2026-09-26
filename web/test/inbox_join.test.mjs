// Join and Decline in the Inbox (20260926140000_inbox_join.sql,
// web/src/members.ts inboxInviteRoutes, pages.ts inbox()): an invite to
// your address is answered from the Inbox, without its link. The database
// rules are in supabase/tests/inbox_join_test.sql; the race with a link
// accept is in web/test/races.test.mjs.
//
// This file starts its own servers from dist/ (local sign-in), one per
// person, none of whom any other test file uses: Owen owns "Join Club" and
// "Join Lounge"; Ivy, Jax and Uma have accounts and no vault, and Uma's
// address isn't confirmed.

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
const OWEN = "ab100000-0000-4000-8000-0000000000a1";
const IVY = "ab200000-0000-4000-8000-0000000000a2";
const JAX = "ab300000-0000-4000-8000-0000000000a3";
const UMA = "ab400000-0000-4000-8000-0000000000a4";

const servers = [];
const V = {};
const S = {};

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
  const loginFile = `/tmp/inbox-join-login-${process.pid}-${port}`;
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
const post = async (who, path, fields, { csrf = true, origin } = {}) =>
  fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: origin ?? S[who].origin },
    body: new URLSearchParams({ ...(csrf ? { csrf: await csrfOf(who) } : {}), ...fields }).toString(),
  });
// The flash on the page a POST redirected to: [tone, text without its ref, had a ref].
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  const m = /<p class="callout (info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h);
  assert.ok(m, "a flash");
  const text = m[2].replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  return [m[1], text.replace(/ \(ref [0-9a-f]{8}\)$/, ""), / \(ref [0-9a-f]{8}\)$/.test(text)];
};
const badge = (h) => /aria-label="Inbox, (\d+) waiting"/.exec(h)?.[1] ?? "0";
const invitesOf = (h) => /<h2 id="invites">Invites<\/h2>[\s\S]*?<\/ul>/.exec(h)?.[0] ?? "";
const inviteToken = async (vault, to, role) =>
  (await as(OWEN, "select public.create_invite($1, $2, $3) as t", [vault, to, role]))[0].t;
const idOf = async (token) =>
  (await sql("select id from private.vault_invites where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')", [token]))[0].id;

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'owen@example.test'), ($2, 'ivy@example.test'), ($3, 'jax@example.test')
     on conflict (id) do nothing`,
    [OWEN, IVY, JAX],
  );
  await sql(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'uma@example.test', null) on conflict (id) do nothing`, [UMA]);
  [{ id: V.club }] = await as(OWEN, "select public.create_vault('Join Club') as id");
  [{ id: V.lounge }] = await as(OWEN, "select public.create_vault('Join Lounge') as id");
  S.owen = await startAs(OWEN);
  S.ivy = await startAs(IVY);
  S.jax = await startAs(JAX);
  S.uma = await startAs(UMA);
});

after(async () => {
  for (const { child } of servers) child.kill();
  for (const [id, name] of [[V.club, "Join Club"], [V.lounge, "Join Lounge"]]) {
    await as(OWEN, "select public.delete_vault($1, $2)", [id, name]).catch(() => {});
  }
  await sql("delete from private.vault_deletion_notices where user_id = any($1)", [[OWEN, IVY, JAX, UMA]]);
});

test("inbox join: an invite to my address has Join and Decline in my inbox, carrying its id, and nobody else sees them", async () => {
  const token = await inviteToken(V.club, "ivy@example.test", "viewer");
  const id = await idOf(token);
  const h = invitesOf(await page("ivy", "/inbox"));
  assert.match(h, /Join makes you a member with the role they chose; Decline ends the invite, and its owners see that you declined\./);
  assert.match(h, new RegExp(`<form method="post" action="/inbox/invites/join"><input type="hidden" name="csrf" value="[0-9a-f]+"><input type="hidden" name="invite" value="${id}"><button aria-label="Join Join Club as viewer">Join</button></form>`));
  assert.match(h, new RegExp(`<form method="post" action="/inbox/invites/decline"><input type="hidden" name="csrf" value="[0-9a-f]+"><input type="hidden" name="invite" value="${id}"><button class="quiet" aria-label="Decline the invite to Join Club">Decline</button></form>`));
  assert.doesNotMatch(h, new RegExp(token), "never the link's token");
  for (const who of ["jax", "owen"]) assert.doesNotMatch(await page(who, "/inbox"), new RegExp(id));
});

test("inbox join: Home tells an account with no vault it can join or decline its invite in the inbox", async () => {
  assert.match(await page("ivy", "/"), /You have an invite waiting: <a href="\/inbox#invites">see your inbox<\/a>\. Join or decline it there, no link needed\./);
});

test("inbox join: an account whose address isn't confirmed sees no invite to answer, and is refused if it posts one", async () => {
  const id = await idOf(await inviteToken(V.club, "uma@example.test", "viewer"));
  const h = await page("uma", "/inbox");
  assert.equal(badge(h), "0");
  assert.doesNotMatch(h, /<h2 id="invites">/);
  const [tone, text, ref] = await flashAfter("uma", await post("uma", "/inbox/invites/join", { invite: id }));
  assert.deepEqual([tone, ref], ["danger", true]);
  assert.match(text, /email address isn't confirmed yet/i);
  assert.match(text, /open the invite link you were sent instead/);
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1 and user_id = $2", [V.club, UMA]))[0].n, 0);
});

test("inbox join: someone else posting my invite's id is refused with a danger flash, and the invite still waits", async () => {
  const id = (await as(IVY, "select id from public.my_invites() where vault_name = 'Join Club'"))[0].id;
  for (const action of ["join", "decline"]) {
    const r = await post("jax", `/inbox/invites/${action}`, { invite: id });
    assert.equal(r.headers.get("location"), "/inbox#invites");
    const [tone, text, ref] = await flashAfter("jax", r);
    assert.deepEqual([tone, ref], ["danger", true]);
    assert.match(text, /no invite with this id is waiting for your address/i);
  }
  const [{ n }] = await sql("select count(*)::int as n from private.vault_invites where id = $1 and accepted_at is null and revoked_at is null", [id]);
  assert.equal(n, 1);
});

test("inbox join: the forms need the form token and this site's origin", async () => {
  const id = (await as(IVY, "select id from public.my_invites() where vault_name = 'Join Club'"))[0].id;
  assert.equal((await post("ivy", "/inbox/invites/join", { invite: id }, { csrf: false })).status, 403);
  assert.equal((await post("ivy", "/inbox/invites/decline", { invite: id }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1 and user_id = $2", [V.club, IVY]))[0].n, 0);
});

test("inbox join: a form without a well-formed invite id says which form and why", async () => {
  const [tone, text, ref] = await flashAfter("ivy", await post("ivy", "/inbox/invites/join", { invite: "not-an-id" }));
  assert.deepEqual([tone, ref], ["danger", true]);
  assert.match(text, /The form didn’t say which invite: reload your inbox and try again/);
});

test("inbox join: Join makes me a member with the invite's role, takes me to the vault with a success flash, and the owner sees it in Activity", async () => {
  const id = (await as(IVY, "select id from public.my_invites() where vault_name = 'Join Club'"))[0].id;
  const r = await post("ivy", "/inbox/invites/join", { invite: id });
  assert.equal(r.headers.get("location"), `/v/${V.club}`);
  const [tone, text, ref] = await flashAfter("ivy", r);
  assert.deepEqual([tone, text, ref], ["success", "You’re a member of Join Club, as a viewer.", false]);
  assert.equal((await sql("select role from public.vault_members where vault_id = $1 and user_id = $2", [V.club, IVY]))[0].role, "viewer");
  assert.doesNotMatch(await page("ivy", "/inbox"), /<h2 id="invites">/);
  assert.match(await page("owen", `/v/${V.club}/activity`), /Joined by invite as a viewer/);
  // Its link is used up too.
  const [again] = await flashAfter("ivy", await post("ivy", "/inbox/invites/join", { invite: id }));
  assert.equal(again, "danger");
});

test("inbox join: Decline ends the invite with a success flash; the owner's list loses it, Activity says so, and its link says I declined", async () => {
  const token = await inviteToken(V.lounge, "ivy@example.test", "editor");
  const id = await idOf(token);
  const r = await post("ivy", "/inbox/invites/decline", { invite: id });
  assert.equal(r.headers.get("location"), "/inbox");
  const [tone, text, ref] = await flashAfter("ivy", r);
  assert.deepEqual([tone, ref], ["success", false]);
  assert.equal(text, "You declined the invite to Join Lounge. Its owners can see that in the vault’s activity; to join later, ask them for a new invite.");
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1 and user_id = $2", [V.lounge, IVY]))[0].n, 0);
  assert.equal((await as(OWEN, "select count(*)::int as n from public.list_invites($1)", [V.lounge]))[0].n, 0);
  assert.match(await page("owen", `/v/${V.lounge}/activity`), /Declined an invite as an editor/);
  assert.match(await page("ivy", `/invite?token=${token}`), /You declined this invite\. Ask the person who invited you for a new one\./);
  const [again, why] = await flashAfter("ivy", await post("ivy", "/inbox/invites/join", { invite: id }));
  assert.equal(again, "danger");
  assert.match(why, /you declined this invite: to join, ask an owner of the vault to invite you again/i);
});

test("inbox join: an expired invite and a full vault are refused with the reason, and the invite isn't used up", async () => {
  const expired = await idOf(await inviteToken(V.lounge, "jax@example.test", "viewer"));
  await sql("update private.vault_invites set expires_at = now() - interval '1 minute' where id = $1", [expired]);
  const [t1, why1] = await flashAfter("jax", await post("jax", "/inbox/invites/join", { invite: expired }));
  assert.equal(t1, "danger");
  assert.match(why1, /this invite has expired/i);

  await sql(`insert into private.vault_tiers (id, name, max_members, max_storage_bytes) values ('inbox_join_one', 'Inbox join one', 1, 1000000)
             on conflict (id) do nothing`);
  const full = await idOf(await inviteToken(V.lounge, "jax@example.test", "viewer"));
  await sql("select private.set_vault_tier($1, 'inbox_join_one')", [V.lounge]);
  try {
    const [t2, why2] = await flashAfter("jax", await post("jax", "/inbox/invites/join", { invite: full }));
    assert.equal(t2, "danger");
    assert.match(why2, /Join Lounge is at its 1-person limit on .*: ask an owner to make room, then choose Join in your inbox again/);
    const [{ n }] = await sql("select count(*)::int as n from private.vault_invites where id = $1 and accepted_at is null and revoked_at is null", [full]);
    assert.equal(n, 1);
  } finally {
    await sql("select private.set_vault_tier($1, 'standard')", [V.lounge]);
  }
});
