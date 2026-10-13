// How people see you, in the web UI (20261014150000_display_preferences.sql):
// "Show me to others as" on Account settings, the vault setting that
// requires members' emails, and asking a member who hid theirs. The rule
// itself is proved in supabase/tests/display_preferences_test.sql; these
// check what a person's pages actually hold.
//
// Its own people and vault: Uma owns "Display Team", Vic edits it, Wes
// views it. Each gets a server of their own (start-as.mjs).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const UMA = "71000000-0000-0000-0000-000000000071";
const VIC = "72000000-0000-0000-0000-000000000072";
const WES = "73000000-0000-0000-0000-000000000073";
const VIC_NAME = "Robert'); DROP TABLE students;--";
const WES_NAME = "<script>alert(1)</script>";

const S = {};
let team = "";

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
const post = async (who, path, fields) => {
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
  return fetch(S[who].url + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].url },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  });
};
const members = () => page("uma", `/v/${team}/config/members`);

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'uma@example.test'), ($2, 'vic@example.test'), ($3, 'wes@example.test')
       on conflict (id) do nothing`,
    [UMA, VIC, WES],
  );
  [{ id: team }] = await as(UMA, "select public.create_vault('Display Team') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [team, VIC, UMA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [team, WES, UMA]);
  await as(VIC, "select public.set_display_name($1)", [VIC_NAME]);
  await as(WES, "select public.set_display_name($1)", [WES_NAME]);
  await as(VIC, "select public.write_file($1, 'notes/vic.md', 'From Vic.')", [team]);
  S.uma = await startAs(UMA);
  S.vic = await startAs(VIC);
});

after(() => {
  for (const s of Object.values(S)) s.stop();
});

test("display: Account settings offers Show me to others as, display name and email by default", async () => {
  const h = await page("vic", "/settings");
  assert.match(h, /<legend>Show me to others as<\/legend>/);
  assert.match(h, /<input type="radio" name="show_email" value="1" checked>/);
  assert.match(await members(), /vic@example\.test/);
});

test("display: a member who hides their email is shown by name and tag, and the email is nowhere in another member's page", async () => {
  const r = await post("vic", "/settings/shown-as", { show_email: "0" });
  assert.equal(r.status, 303);
  assert.match(await page("vic", "/settings"), /<input type="radio" name="show_email" value="0" checked>/);
  const h = await members();
  assert.match(h, /Robert&#39;\); DROP TABLE students;-- · 72000000/);
  assert.ok(!h.includes("vic@example.test"), "Vic's hidden email is in Uma's members page");
  const changes = await page("uma", `/v/${team}/changes`);
  assert.match(changes, /Robert&#39;\); DROP TABLE students;-- · 72000000/);
  assert.ok(!changes.includes("vic@example.test"), "nor in the vault's changes");
  assert.match(await page("vic", `/v/${team}/config/members`), /vic@example\.test/, "Vic still sees their own");
});

test("display: a hostile display name is shown escaped and does nothing", async () => {
  const h = await members();
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt; \(wes@example\.test\)/);
  assert.ok(!h.includes(WES_NAME), "the name went out as markup");
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1", [team]))[0].n, 3);
});

test("require: only an owner sets a vault to require emails; an editor is refused", async () => {
  assert.doesNotMatch(await page("vic", `/v/${team}/config`), /name="require_emails"/);
  const refused = await post("vic", `/v/${team}/config/emails`, { require_emails: "1" });
  assert.equal(refused.status, 303);
  assert.match(await page("vic", refused.headers.get("location")), /only owners decide whether a vault requires members/i);
  assert.equal((await sql("select require_emails from public.vaults where id = $1", [team]))[0].require_emails, false);
  assert.match(await page("uma", `/v/${team}/config`), /<legend>Who sees members’ emails<\/legend>/);
  assert.equal((await post("uma", `/v/${team}/config/emails`, { require_emails: "1" })).status, 303);
  assert.equal((await sql("select require_emails from public.vaults where id = $1", [team]))[0].require_emails, true);
});

test("require: a member who hid their email is asked on the vault's pages, and once they agree the others see it", async () => {
  assert.match(await page("vic", `/v/${team}`), /id="email-consent"/);
  assert.ok(!(await members()).includes("vic@example.test"), "shown before they agreed");
  const r = await post("vic", `/v/${team}/config/email-consent`, {});
  assert.equal(r.status, 303);
  assert.doesNotMatch(await page("vic", `/v/${team}`), /id="email-consent"/);
  assert.match(await members(), /Robert&#39;\); DROP TABLE students;-- \(vic@example\.test\)/);
});
