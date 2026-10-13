// Deleting an account while owning vaults, and orphaned vaults, in the web
// UI (20261014170000_orphaned_vaults.sql). The rules are proved in
// supabase/tests/orphaned_vaults_test.sql; these check what a person's
// pages say and that Become owner reaches take_vault.
//
// Its own people and vaults: Orla owns "Orphan Solo" alone and "Orphan
// Team" (Pim edits, Quin views), and is the second owner of Pim's "Orphan
// Pim". Each gets a server of their own (start-as.mjs).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const ORLA = "81000000-0000-0000-0000-000000000081";
const PIM = "82000000-0000-0000-0000-000000000082";
const QUIN = "83000000-0000-0000-0000-000000000083";

const S = {};
const V = {};

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

const page = async (who, path) => (await fetch(S[who].url + path, { headers: { cookie: S[who].cookie }, redirect: "manual" })).text();
const post = async (who, path, fields = {}) => {
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
  return fetch(S[who].url + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].url },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  });
};
const role = async (user, vault) =>
  (await sql("select role from public.vault_members where vault_id = $1 and user_id = $2", [vault, user]))[0]?.role;

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'orla@example.test'), ($2, 'pim@example.test'), ($3, 'quin@example.test')
       on conflict (id) do nothing`,
    [ORLA, PIM, QUIN],
  );
  [{ id: V.solo }] = await as(ORLA, "select public.create_vault('Orphan Solo') as id");
  [{ id: V.team }] = await as(ORLA, "select public.create_vault('Orphan Team') as id");
  [{ id: V.pim }] = await as(PIM, "select public.create_vault('Orphan Pim') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.team, PIM, ORLA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.team, QUIN, ORLA]);
  await sql("select test_support.add_member($1, $2, 'owner', $3)", [V.pim, ORLA, PIM]);
  await sql(
    `insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes)
     values ('orphan_none', 'Orphan none', 0, 10, 1000000) on conflict (id) do nothing`,
  );
  S.orla = await startAs(ORLA);
  S.pim = await startAs(PIM);
  S.quin = await startAs(QUIN);
});

after(() => {
  for (const s of Object.values(S)) s.stop();
});

test("orphaned: the confirm page says which vault goes with my account, which is left without an owner, and which I just leave", async () => {
  const h = await page("orla", "/settings/delete");
  assert.match(h, /You leave 2 vaults: <strong>Orphan Pim<\/strong> \(owner\), <strong>Orphan Team<\/strong> \(owner\)\./);
  assert.match(
    h,
    new RegExp(`<li>Nobody else is in <strong>Orphan Solo</strong>, so it is deleted with your account, with everything in it\\. <a href="/v/${V.solo}/config/export">Export it</a> first to keep a copy\\.</li>`),
  );
  assert.match(h, /<li><strong>Orphan Team<\/strong> has no other owner, so it is left without one\. Its members keep working in it, and any of them can choose to become its owner\.<\/li>/);
  assert.doesNotMatch(h, /<strong>Orphan Pim<\/strong> has no other owner/);
  assert.match(h, /action="\/settings\/delete"/);
});

test("orphaned: deleting my account says which vaults were left without an owner and which were deleted", async () => {
  const r = await post("orla", "/settings/delete", { confirm_email: "orla@example.test" });
  assert.equal(r.status, 200);
  assert.match(
    await r.text(),
    /You left 2 vaults, 0 connections were deleted\. One of them has no owner now, until a member chooses to become one\. 1 vault nobody else was in was deleted with your account\./,
  );
  assert.equal((await sql("select count(*)::int as n from public.vaults where id = $1", [V.solo]))[0].n, 0);
});

test("orphaned: every member sees on the vault's pages that it needs an owner, with Become owner, and a vault with an owner says nothing", async () => {
  for (const [who, path] of [["pim", `/v/${V.team}`], ["quin", `/v/${V.team}/config`], ["quin", `/v/${V.team}/proposals`]]) {
    const h = await page(who, path);
    assert.match(h, /<p class="callout-title"><strong>This vault needs an owner<\/strong><\/p>/, `${who} ${path}`);
    assert.match(h, /Orphan Team’s only owner deleted their account\. Everyone keeps reading, writing and proposing as before, but nobody can do what only an owner may/);
    assert.match(h, new RegExp(`<form method="post" action="/v/${V.team}/config/take" class="actions">.*<button class="primary">Become owner</button></form>`, "s"));
  }
  assert.doesNotMatch(await page("pim", `/v/${V.pim}`), /id="needs-owner"/);
});

test("orphaned: Become owner at my vault limit is refused in words, and the vault still needs an owner", async () => {
  await sql("select private.set_account_plan($1, 'orphan_none')", [QUIN]);
  const r = await post("quin", `/v/${V.team}/config/take`);
  assert.equal(r.status, 303);
  const h = await page("quin", r.headers.get("location"));
  assert.match(h, /you(?:’|'|&#39;)re at your 0-vault limit on the Orphan none plan \(you own 0\), and becoming the owner of Orphan Team would count it against your plan: delete a vault you no longer need, or ask for a bigger plan/i);
  assert.match(h, /id="needs-owner"/);
  assert.equal(await role(QUIN, V.team), "viewer");
});

test("orphaned: the first member to choose Become owner is its owner, the notice goes, and the next is told it has one", async () => {
  const r = await post("pim", `/v/${V.team}/config/take`);
  assert.equal(r.status, 303);
  const h = await page("pim", r.headers.get("location"));
  assert.match(h, /You’re the owner of Orphan Team now\. It counts against your plan\./);
  assert.doesNotMatch(h, /id="needs-owner"/);
  assert.equal(await role(PIM, V.team), "owner");
  await sql("select private.set_account_plan($1, 'free')", [QUIN]);
  const again = await post("quin", `/v/${V.team}/config/take`);
  assert.match(await page("quin", again.headers.get("location")), /Orphan Team has an owner, so there is no owner(?:’|'|&#39;)s place to take/);
  assert.equal(await role(QUIN, V.team), "viewer");
});
