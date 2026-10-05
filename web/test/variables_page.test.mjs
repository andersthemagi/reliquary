// The Variables page (docs/variables.md, "Web: the Variables page"):
// src/variablespage.ts over src/variables.ts, driven over HTTP.
//
// This file starts its own servers from dist/, signed in as Pia, a person no
// other test file uses, so nothing here moves another file's counts. Pia owns
// "Page Own" and "Page Empty", is an editor in Oren's "Page Ed" and a viewer
// in his "Page View", and isn't in his "Page Private". Every value holds
// PAGEVAL-; none may reach a page after its reveal, a URL, or a server log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const PIA = "00000000-0000-0000-0000-0000000000f5";
const OREN = "00000000-0000-0000-0000-0000000000f6";
const KEY = randomBytes(32).toString("base64url");

const secrets = []; // every value and token this file sees: none may reach a log
const value = (label) => {
  const v = `PAGEVAL-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let vars; // dist/variables.js, for fixtures
let log = "";
const servers = [];
const main = { origin: "", cookie: "" };
const bare = { origin: "", cookie: "" }; // a server without VARIABLES_KEY
const V = {}; // vault ids
const vals = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(into, extra) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/variables-page-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: PIA,
      LOGIN_FILE: loginFile,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_RESOURCE: "https://mcp.reliquary.test/mcp",
      PUBLIC_URL: "",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  into.origin = origin;
  into.cookie = r.headers.get("set-cookie").split(";")[0];
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

// As a person (no act claim), or as a database role with no claims.
async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) {
      await db.query(`set local role ${who.role}`);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const get = (path, s = main) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path, s = main) => (await get(path, s)).text();
const csrfOf = async (s = main) => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/", s))[1];
// A field given as an array is sent once for each item, as a ticked set of checkboxes is.
const formBody = (fields) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) p.append(k, x);
  return p.toString();
};
const post = async (path, fields, { s = main, csrf = true, headers = {} } = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin, ...headers },
    body: formBody({ ...(csrf ? { csrf: await csrfOf(s) } : {}), ...fields }),
  });
const vp = (vault, rest = "") => `/v/${vault}/variables${rest}`;
const reveals = async (vault) =>
  Number((await sql("select count(*)::int as n from public.env_access_log where vault_id = $1 and action in ('reveal', 'refused')", [vault]))[0].n);
const noValues = (h) => {
  for (const s of secrets) assert.equal(h.includes(s), false, "a value is on the page");
  assert.doesNotMatch(h, /PAGEVAL-/);
};

// A CLI sign-in made straight in the database, as consent and the token
// endpoint would, so the env API can log a `read` for the page to show.
async function cliToken(user, origin) {
  const b64url = (buf) => buf.toString("base64url");
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const resource = `${origin}/api/env`;
  const client = `${origin}/cli/oauth-client.json`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await as({ user }, "select public.create_cli_grant($1, $2, $3, $4, null) as code", [client, redirect, resource, challenge]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  const refresh = `rlr_${randomBytes(32).toString("hex")}`;
  secrets.push(access, refresh, code);
  const [{ r }] = await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(refresh),
  ]);
  assert.equal(r, "ok");
  return access;
}

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  const crypto = await import("../dist/secrets.js");
  vars = await import("../dist/variables.js");
  crypto.configureVariables({ VARIABLES_KEY: KEY });
  await startServer(main, { VARIABLES_KEY: KEY });
  await startServer(bare, { VARIABLES_KEY: "" });

  [{ id: V.own }] = await as({ user: PIA }, "select public.create_vault('Page Own') as id");
  [{ id: V.empty }] = await as({ user: PIA }, "select public.create_vault('Page Empty') as id");
  [{ id: V.paged }] = await as({ user: PIA }, "select public.create_vault('Page Paged') as id");
  [{ id: V.ed }] = await as({ user: OREN }, "select public.create_vault('Page Ed') as id");
  [{ id: V.view }] = await as({ user: OREN }, "select public.create_vault('Page View') as id");
  [{ id: V.priv }] = await as({ user: OREN }, "select public.create_vault('Page Private') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.ed, PIA, OREN]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.view, PIA, OREN]);

  vals.ownDev = value("own-dev");
  vals.ownProd = value("own-prod");
  vals.edDev = value("ed-dev");
  vals.edProd = value("ed-prod");
  vals.view = value("view");
  vals.priv = value("priv");
  await vars.setVariable(PIA, V.own, "API_KEY", "development", vals.ownDev);
  await vars.setVariable(PIA, V.own, "API_KEY", "production", vals.ownProd);
  await vars.setVariable(OREN, V.ed, "STRIPE_KEY", "development", vals.edDev);
  await vars.setVariable(OREN, V.ed, "STRIPE_KEY", "production", vals.edProd);
  await vars.setVariable(OREN, V.view, "VIEW_KEY", "development", vals.view);
  await vars.setVariable(OREN, V.priv, "PRIV_KEY", "development", vals.priv);
});

after(async () => {
  for (const s of servers) s.kill();
  const { pool } = await import("../dist/db.js");
  await pool.end();
});

// ---------------------------------------------------------------------------
// What each role sees

test("variables page: the vault sidebar links to Variables, on wide and narrow screens", async () => {
  const h = await page(`/v/${V.own}`);
  assert.equal(h.split(`href="${vp(V.own)}"`).length - 1, 2);
  assert.match(await page(vp(V.own)), new RegExp(`href="${vp(V.own)}" aria-current="page">Variables`));
});

test("variables page: an owner sees each environment set or not, its version, who set it and when, and never a value", async () => {
  const r = await get(vp(V.own));
  assert.equal(r.status, 200);
  const h = await r.text();
  noValues(h);
  assert.match(h, /<th scope="col">Name<\/th><th scope="col"><span class="var-env">development<\/span><\/th><th scope="col"><span class="var-env">preview<\/span><\/th><th scope="col"><span class="var-env">production<\/span> <span class="badge var-owners"[^>]*>Owners only<\/span><\/th>/);
  assert.match(h, /<code>API_KEY<\/code>/);
  assert.match(h, /<td data-label="development"><div class="var-cell">\s*<span class="var-state" title="Set by you, [^"]+ UTC \(version 1\)"><span class="var-set">Set<\/span> <span class="var-meta"><time datetime="[^"]+">[^<]+<\/time><span class="var-by"> by you<\/span>/);
  assert.match(h, /<td data-label="preview"><div class="var-cell"><span class="var-none">Not set<\/span><a class="button ghost var-add" href="[^"]+\/set\?name=API_KEY&amp;environment=preview" aria-label="Set API_KEY in preview">Set<\/a>/);
  // Reveal, Rotate and Delete in both set environments, production included.
  for (const env of ["development", "production"]) {
    assert.match(h, new RegExp(`name="name" value="API_KEY"><input type="hidden" name="environment" value="${env}"><button class="menu-item"><span class="menu-item-title">Reveal</span>`));
    assert.ok(h.includes(`href="${vp(V.own, "/set")}?name=API_KEY&amp;environment=${env}"><span class="menu-item-title">Rotate`));
    assert.ok(h.includes(`href="${vp(V.own, "/delete")}?name=API_KEY&amp;environment=${env}"><span class="menu-item-title">Delete`));
  }
  assert.match(h, new RegExp(`<a class="button" href="${vp(V.own, "/import")}">Import .env</a><a class="button primary" href="${vp(V.own, "/set")}">Add a variable</a>`));
  assert.match(h, new RegExp(`<a href="${vp(V.own, "/log")}">Access log</a>`));
});

test("variables page: an editor gets controls outside production only, and a line saying owners handle production", async () => {
  const h = await page(vp(V.ed));
  noValues(h);
  assert.match(h, /<code>STRIPE_KEY<\/code>/);
  assert.match(h, /Only owners set, rotate, delete or reveal values in production\./);
  assert.match(h, /name="environment" value="development"><button class="menu-item"><span class="menu-item-title">Reveal<\/span>/);
  assert.doesNotMatch(h, /value="production"/);
  assert.doesNotMatch(h, /environment=production/);
  // The production cell still says it's set, and by whom.
  assert.match(h, /<td data-label="production \(owners only\)"><div class="var-cell">\s*<span class="var-state" title="Set by 00000000, [^"]+"><span class="var-set">Set<\/span>/);
  assert.match(h, /Access log<\/a>/);
  // The form offers development and preview, not production.
  const f = await page(vp(V.ed, "/set"));
  assert.match(f, /<input type="checkbox" name="environment" value="development" checked> development<\/label><label class="choice"><input type="checkbox" name="environment" value="preview"> preview<\/label><label class="choice is-disabled"><input type="checkbox" name="environment" value="production" disabled> production/);
  assert.match(f, /Only owners set values in production\./);
  const rot = await get(vp(V.ed, "/set?name=STRIPE_KEY&environment=production"));
  assert.equal(rot.status, 403);
  assert.match(await rot.text(), /Only owners set values in production\./);
});

test("variables page: a viewer sees names only: no value, no control, no access log", async () => {
  const h = await page(vp(V.view));
  noValues(h);
  assert.match(h, /<code>VIEW_KEY<\/code>/);
  assert.match(h, /As a viewer you see names only\./);
  // The page itself: the top bar links Account settings (/settings) on every page.
  const main = /<main id="main">[\s\S]*<\/main>/.exec(h)[0];
  for (const s of ["/reveal", "/set", "/delete", "/log", "<button>Reveal", "Add a variable"]) assert.equal(main.includes(s), false, s);
  const l = await page(vp(V.view, "/log"));
  assert.match(l, /Only owners and editors can see this vault’s access log\./);
  assert.doesNotMatch(l, /<table/);
  const f = await get(vp(V.view, "/set"));
  assert.equal(f.status, 403);
  assert.match(await f.text(), /Your role in this vault can’t set variables\./);
});

test("variables page: a vault you're not in is not found, and nothing is revealed or logged", async () => {
  const before = await reveals(V.priv);
  for (const p of ["", "/log", "/set"]) assert.equal((await get(vp(V.priv, p))).status, 404, p);
  const r = await post(vp(V.priv, "/reveal"), { name: "PRIV_KEY", environment: "development" });
  assert.equal(r.status, 404);
  noValues(await r.text());
  assert.equal(await reveals(V.priv), before);
});

// ---------------------------------------------------------------------------
// Set, rotate, delete

test("variables page: setting a value redirects with a flash naming it and its environment, and the value is in no URL or page", async () => {
  const v = value("new");
  const r = await post(vp(V.own, "/set"), { name: "NEW_KEY", environment: "preview", value: v });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), vp(V.own));
  const h = await page(r.headers.get("location"));
  assert.match(h, /<p class="callout success flash" role="status">Set NEW_KEY in preview\.<\/p>/);
  noValues(h);
  assert.equal((await vars.revealVariable(PIA, V.own, "NEW_KEY", "preview")).value, v);
  // Again: a rotation.
  const w = value("new-rotated");
  const r2 = await post(vp(V.own, "/set"), { name: "NEW_KEY", environment: "preview", value: w });
  assert.equal(r2.headers.get("location"), vp(V.own));
  assert.match(await page(vp(V.own)), /Rotated NEW_KEY in preview\./);
  assert.equal((await vars.revealVariable(PIA, V.own, "NEW_KEY", "preview")).value, w);
});

test("variables page: Rotate opens the form with the name and environment fixed and an empty value", async () => {
  const h = await page(vp(V.own, "/set?name=API_KEY&environment=production"));
  assert.match(h, /<h1 class="path">Rotate API_KEY<\/h1>/);
  assert.match(h, /<input type="hidden" name="name" value="API_KEY">/);
  assert.match(h, /<input type="hidden" name="environment" value="production">/);
  assert.match(h, /<textarea id="vv" name="value" class="short secret-input" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><\/textarea>/);
  noValues(h);
});

test("variables page: a refused set shows the database's reason and the form again, without the value", async () => {
  for (const [name, reason] of [["PATH", /PATH changes how programs start/], ["1BAD", /a variable name is letters, digits and underscores/i]]) {
    const v = value(`refused-${name}`);
    const r = await post(vp(V.own, "/set"), { name, environment: "development", value: v });
    assert.equal(r.status, 400);
    const h = await r.text();
    assert.match(h, reason);
    assert.match(h, /role="alert"/);
    assert.match(h, new RegExp(`name="name" value="${name}"`));
    assert.match(h, /spellcheck="false"><\/textarea>/);
    noValues(h);
  }
});

test("variables page: editors can't touch production: set, rotate, delete and reveal are refused, and the value stays", async () => {
  const v = value("editor-prod");
  const set = await post(vp(V.ed, "/set"), { name: "STRIPE_KEY", environment: "production", value: v });
  assert.equal(set.status, 403);
  const sh = await set.text();
  assert.match(sh, /Only owners set values in production\./);
  noValues(sh);
  const add = await post(vp(V.ed, "/set"), { name: "NEW_PROD", environment: "production", value: v });
  assert.equal(add.status, 403);
  noValues(await add.text());

  const del = await post(vp(V.ed, "/delete"), { name: "STRIPE_KEY", environment: "production" });
  assert.equal(del.status, 303);
  assert.match(await page(del.headers.get("location")), /Only owners delete values in production\./);

  const rev = await post(vp(V.ed, "/reveal"), { name: "STRIPE_KEY", environment: "production" });
  assert.equal(rev.status, 403);
  const rh = await rev.text();
  assert.match(rh, /Your role can’t reveal values in production\. The attempt is in the access log\./);
  noValues(rh);

  assert.equal((await vars.revealVariable(OREN, V.ed, "STRIPE_KEY", "production")).value, vals.edProd);
  assert.deepEqual((await vars.listVariables(OREN, V.ed)).variables.map((x) => x.name), ["STRIPE_KEY"]);
});

test("variables page: an editor sets and reveals outside production", async () => {
  const v = value("ed-preview");
  const r = await post(vp(V.ed, "/set"), { name: "STRIPE_KEY", environment: "preview", value: v });
  assert.equal(r.status, 303);
  const rev = await post(vp(V.ed, "/reveal"), { name: "STRIPE_KEY", environment: "preview" });
  assert.equal(rev.status, 200);
  assert.ok((await rev.text()).includes(v));
});

test("variables page: delete asks to confirm, then removes one environment's value", async () => {
  await vars.setVariable(PIA, V.own, "GONE_KEY", "development", value("gone-dev"));
  await vars.setVariable(PIA, V.own, "GONE_KEY", "preview", value("gone-preview"));
  const c = await page(vp(V.own, "/delete?name=GONE_KEY&environment=development"));
  assert.match(c, /Delete the value of <code>GONE_KEY<\/code> in <strong>development<\/strong>\?/);
  assert.match(c, new RegExp(`<form method="post" action="${vp(V.own, "/delete")}" class="panel confirm">`));
  assert.match(c, /<button class="danger solid">Delete GONE_KEY from development<\/button>/);
  noValues(c);
  assert.equal((await get(vp(V.own, "/delete?name=GONE_KEY&environment=production"))).status, 404);
  const r = await post(vp(V.own, "/delete"), { name: "GONE_KEY", environment: "development" });
  assert.equal(r.status, 303);
  const h = await page(r.headers.get("location"));
  assert.match(h, /Deleted GONE_KEY from development\./);
  const gone = (await vars.listVariables(PIA, V.own)).variables.find((x) => x.name === "GONE_KEY");
  assert.deepEqual(gone.values.map((x) => x.environment), ["preview"]);
});

// ---------------------------------------------------------------------------
// Reveal

test("variables reveal: reveal needs a POST with this site's CSRF token and origin; anything else shows and logs nothing", async () => {
  const before = await reveals(V.own);
  const g = await get(vp(V.own, "/reveal?name=API_KEY&environment=production"));
  assert.equal(g.status, 404);
  noValues(await g.text());
  const noCsrf = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "production" }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  noValues(await noCsrf.text());
  const badCsrf = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "production", csrf: "0".repeat(64) }, { csrf: false });
  assert.equal(badCsrf.status, 403);
  const foreign = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "production" }, { headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  noValues(await foreign.text());
  assert.equal(await reveals(V.own), before);
});

test("variables reveal: a reveal answers with the value once, never cached, says it is logged, and logs it", async () => {
  const r = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "production" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("location"), null);
  assert.match(r.headers.get("cache-control"), /no-store/);
  const h = await r.text();
  assert.match(h, /<strong>This reveal is logged\.<\/strong>/);
  assert.ok(h.includes(`<pre class="secret">${vals.ownProd}</pre>`));
  assert.equal(h.split(vals.ownProd).length - 1, 1, "the value appears once");
  // The theme switch on this page comes back to the list, not to the POST route.
  assert.match(h, new RegExp(`name="back" value="${vp(V.own)}"`));
  const [row] = await sql("select actor, agent, action, environment, names from public.env_access_log where vault_id = $1 order by seq desc limit 1", [V.own]);
  assert.deepEqual(row, { actor: PIA, agent: null, action: "reveal", environment: "production", names: ["API_KEY"] });
});

test("variables reveal: a revealed value is on no later page", async () => {
  await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "development" });
  for (const p of [vp(V.own), vp(V.own, "/log"), vp(V.own, "/log?name=API_KEY"), vp(V.own, "/set?name=API_KEY&environment=development"),
    vp(V.own, "/delete?name=API_KEY&environment=development"), `/v/${V.own}`, `/v/${V.own}/activity`, "/activity", "/"]) {
    noValues(await page(p));
  }
});

test("variables reveal: a missing value says so, and a value that won't decrypt says to set it again", async () => {
  const r = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "preview" });
  assert.equal(r.status, 404);
  assert.match(await r.text(), /<code>API_KEY<\/code> has no value in preview\./);
  // Two values swapped between rows: each fails its additional data.
  await vars.setVariable(PIA, V.own, "SWAP_A", "development", value("swap-a"));
  await vars.setVariable(PIA, V.own, "SWAP_B", "development", value("swap-b"));
  await sql(
    `with s as (select s.variable_id, v.name, s.nonce, s.ciphertext from private.variable_secrets s
                  join public.variables v on v.id = s.variable_id
                 where v.vault_id = $1 and s.environment = 'development' and v.name in ('SWAP_A', 'SWAP_B'))
     update private.variable_secrets t set nonce = o.nonce, ciphertext = o.ciphertext
       from s me, s o
      where t.variable_id = me.variable_id and t.environment = 'development' and me.name <> o.name`,
    [V.own],
  );
  const d = await post(vp(V.own, "/reveal"), { name: "SWAP_A", environment: "development" });
  assert.equal(d.status, 500);
  const h = await d.text();
  assert.match(h, /<code>SWAP_A<\/code> in development can’t be decrypted\. Set it again to replace it\./);
  noValues(h);
  await vars.deleteVariable(PIA, V.own, "SWAP_A", "development");
  await vars.deleteVariable(PIA, V.own, "SWAP_B", "development");
});

// ---------------------------------------------------------------------------
// Access log and rotation help

test("variables log: next to a value, who read or revealed it since it was set, with a link to revoke", async () => {
  const token = await cliToken(PIA, main.origin);
  const r = await fetch(`${main.origin}/api/env/${V.own}/development`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const h = await page(vp(V.own));
  noValues(h);
  const dev = /<td data-label="development">[\s\S]*?<\/td>/.exec(h.slice(h.indexOf("<code>API_KEY</code>")))[0];
  assert.match(dev, /Since then: .*read by you \(CLI\).*revealed by you|Since then: .*revealed by you.*read by you \(CLI\)/);
  assert.match(dev, /href="\/connections"><span class="menu-item-title">Manage connections<\/span>/);
  // Setting it again starts over.
  await post(vp(V.own, "/set"), { name: "API_KEY", environment: "development", value: value("own-dev-2") });
  const after = /<td data-label="development">[\s\S]*?<\/td>/.exec((await page(vp(V.own))).split("<code>API_KEY</code>")[1])[0];
  assert.doesNotMatch(after, /Since then/);
  assert.match(after, /title="Set by you, [^"]+ \(version 2\)"/);
});

test("variables log: the access log shows who set, read, revealed and was refused what, when and from which client", async () => {
  const h = await page(vp(V.own, "/log"));
  noValues(h);
  assert.match(h, /<h1>Variables<\/h1>/);
  assert.match(h, new RegExp(`<a href="${vp(V.own, "/log")}" aria-current="page">Access log</a>`));
  assert.match(h, /<th>When<\/th><th>Who<\/th><th>What<\/th><th>Variables<\/th><th>Environment<\/th>/);
  assert.match(h, /you <span class="muted">· web UI<\/span><\/div><\/td>\s*<td class="small" data-label="What"><div>Revealed<\/div>/);
  assert.match(h, /you <span class="muted">· CLI<\/span><\/div><\/td>\s*<td class="small" data-label="What"><div>Read<\/div>/);
  assert.match(h, /data-label="What"><div>Rotated<\/div>/);
  assert.match(h, /data-label="What"><div>Deleted<\/div>/);
  // The editor's refused production attempts, with their reason, in Oren's vault.
  const e = await page(vp(V.ed, "/log"));
  assert.match(e, /<span class="badge danger">Refused<\/span> <span class="muted">reveal: role editor<\/span>/);
  noValues(e);
});

test("variables log: the access log filters by action and by variable", async () => {
  const h = await page(vp(V.own, "/log?action=reveal"));
  assert.match(h, /<option value="reveal" selected>Revealed<\/option>/);
  assert.match(h, /Revealed/);
  assert.doesNotMatch(h, /data-label="What"><div>(Set|Rotated|Deleted|Read)<\/div>/);
  const n = await page(vp(V.own, "/log?name=GONE_KEY"));
  assert.match(n, /<code>GONE_KEY<\/code>/);
  assert.doesNotMatch(n, /<code>API_KEY<\/code>/);
  assert.match(n, /Clear filters/);
  assert.match(await page(vp(V.own, "/log?name=NOPE_NONE")), /Nothing matches these filters\./);
});

test("variables log: the access log pages 50 at a time, newest first", async () => {
  for (let i = 0; i < 51; i++) await vars.setVariable(PIA, V.paged, "PAGED", "development", value(`paged-${i}`));
  const h = await page(vp(V.paged, "/log"));
  assert.equal(h.split('data-label="What"><div>Rotated</div>').length - 1, 50);
  const older = /<a class="older" href="([^"]+)">Older<\/a>/.exec(h)[1].replaceAll("&amp;", "&");
  const o = await page(older);
  assert.equal(o.split('data-label="What"><div>Set</div>').length - 1, 1);
  assert.doesNotMatch(o, /data-label="What"><div>Rotated<\/div>/);
  assert.match(o, /Newest<\/a>/);
});

// ---------------------------------------------------------------------------
// Empty vault, no key, Connect

test("variables page: an empty vault explains variables, how to run a command with them, and what they can't protect against", async () => {
  const h = await page(vp(V.empty));
  assert.match(h, /<strong>No variables yet\.<\/strong>/);
  assert.match(h, /npx @reliquary-ai\/cli run --env development -- &lt;command&gt;/);
  assert.match(h, /npx @reliquary-ai\/cli login/);
  assert.match(h, /<strong>Agents can read what reaches them\.<\/strong>/);
  assert.match(h, /<strong>The hosted operator can decrypt\.<\/strong>/);
  assert.match(h, new RegExp(`<a class="button primary" href="${vp(V.empty, "/set")}">Add a variable</a>`));
  assert.doesNotMatch(h, /<table/);
});

test("variables page: without VARIABLES_KEY, names are listed and values can't be set or revealed", async () => {
  const before = await reveals(V.own);
  const h = await page(vp(V.own), bare);
  assert.match(h, /<code>API_KEY<\/code>/);
  assert.match(h, /This server has no encryption key, so values can’t be set or revealed here\./);
  assert.doesNotMatch(h, /<button>Reveal|Add a variable|\/set\?/);
  const r = await post(vp(V.own, "/reveal"), { name: "API_KEY", environment: "production" }, { s: bare });
  assert.equal(r.status, 503);
  noValues(await r.text());
  assert.equal(await reveals(V.own), before, "nothing revealed, nothing logged");
  const s = await post(vp(V.own, "/set"), { name: "NOKEY", environment: "development", value: value("nokey") }, { s: bare });
  assert.equal(s.status, 403);
  noValues(await s.text());
  assert.equal((await vars.listVariables(PIA, V.own)).variables.some((x) => x.name === "NOKEY"), false);
});

test("variables page: the Connect page shows the CLI: login, run and env pull", async () => {
  const h = await page("/connect?client=cli");
  assert.match(h, /<a href="\/connect\?client=cli" aria-current="page">Environment variables<\/a>/);
  const cli = h.slice(h.indexOf('<section id="cli">'));
  assert.match(cli, /npx @reliquary-ai\/cli login/);
  assert.match(cli, /npx @reliquary-ai\/cli run --env development -- &lt;command&gt;/);
  assert.match(cli, /npx @reliquary-ai\/cli env pull --env development/);
});

// ---------------------------------------------------------------------------
// One menu per value, tabs, the Add form, the log's cells

// The cell of a variable in an environment, on the Values tab.
const cellOf = (h, name, env) => new RegExp(`<td data-label="${env}[^"]*">[\\s\\S]*?</td>`).exec(h.slice(h.indexOf(`<code>${name}</code>`)))[0];

test("variables values: a set value reads Set and how long ago, with who, the exact time and its version in its title and at the top of its menu, and no version number in the cell", async () => {
  const dev = cellOf(await page(vp(V.own)), "API_KEY", "development");
  assert.match(dev, /<span class="var-set">Set<\/span> <span class="var-meta"><time datetime="\d{4}-\d\d-\d\dT[^"]+">[^<]+<\/time>/);
  assert.match(dev, /title="Set by you, \d{4}-\d\d-\d\d \d\d:\d\d UTC \(version \d+\)"/);
  assert.match(dev, /<p class="menu-label">Set by you, \d{4}-\d\d-\d\d \d\d:\d\d UTC\./);
  assert.doesNotMatch(dev.replace(/title="[^"]*"/g, ""), /\bv\d+\b|version/);
});

test("variables values: each set value has one menu (Reveal as a POST, Rotate, Delete) instead of loose buttons, and an empty one offers Set", async () => {
  const h = await page(vp(V.own));
  const row = h.slice(h.indexOf("<code>API_KEY</code>"));
  const tr = row.slice(0, row.indexOf("</tr>"));
  assert.equal((tr.match(/<details class="menu-wrap action-menu var-menu">/g) ?? []).length, (tr.match(/class="var-set"/g) ?? []).length);
  assert.match(tr, /aria-label="Actions for API_KEY in production"/);
  assert.match(tr, new RegExp(`<form method="post" action="${vp(V.own, "/reveal")}"><input type="hidden" name="csrf" value="[0-9a-f]+">`));
  assert.doesNotMatch(tr, /href="[^"]*\/reveal/);
  assert.doesNotMatch(tr, /class="var-actions"/);
  assert.match(tr, new RegExp(`class="menu-item danger" href="${vp(V.own, "/delete")}\\?name=API_KEY&amp;environment=production"`));
  assert.match(cellOf(h, "API_KEY", "preview"), /<span class="var-none">Not set<\/span><a class="button ghost var-add" [^>]*aria-label="Set API_KEY in preview">Set<\/a>/);
  // Editors get no menu where they can't act: the owners-only column.
  assert.doesNotMatch(cellOf(await page(vp(V.ed)), "STRIPE_KEY", "production"), /<details/);
});

test("variables tabs: owners get Values, Environments, Access log and Imports under one header; editors all but Environments; viewers no tabs", async () => {
  const nav = (h) => /<nav class="tabs" aria-label="Variables">[\s\S]*?<\/nav>/.exec(h)?.[0] ?? "";
  const labels = (h) => [...nav(h).matchAll(/<a href="[^"]+"(?: aria-current="page")?>([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(labels(await page(vp(V.own))), ["Values", "Environments", "Access log", "Imports"]);
  assert.deepEqual(labels(await page(vp(V.ed))), ["Values", "Access log", "Imports"]);
  assert.equal(nav(await page(vp(V.view))), "");
  for (const [path, label] of [["", "Values"], ["/environments", "Environments"], ["/log", "Access log"], ["/imports", "Imports"]]) {
    const h = await page(vp(V.own, path));
    assert.match(nav(h), new RegExp(`aria-current="page">${label}<`), path);
    assert.match(h, /<h1>Variables<\/h1>/, path);
  }
});

test("variables tabs: the Imports tab says when nothing waits and how to send an import; viewers are told it's for owners and editors", async () => {
  const h = await page(vp(V.own, "/imports"));
  assert.match(h, /<strong>No imports waiting\.<\/strong>/);
  assert.match(h, /npx @reliquary-ai\/cli env push --env development/);
  assert.match(h, new RegExp(`<a class="button primary" href="${vp(V.own, "/import")}">Import .env</a>`));
  const v = await get(vp(V.view, "/imports"));
  assert.equal(v.status, 200);
  assert.match(await v.text(), /Only owners and editors see this vault’s imports\./);
  assert.equal((await get(vp(V.priv, "/imports"))).status, 404);
});

test("variables add: the environments are a checkbox for each one, the one asked for (else the first) ticked, owners-only ones badged, and those a role can't set disabled", async () => {
  const o = await page(vp(V.own, "/set?environment=preview"));
  assert.match(o, /<legend>Environments<\/legend>/);
  assert.match(o, /type="checkbox" name="environment" value="development"> development/);
  assert.match(o, /value="preview" checked> preview/);
  assert.match(o, /value="production"> production <span class="badge var-owners"[^>]*>Owners only<\/span>/);
  assert.doesNotMatch(o, /<select|type="radio" name="environment"/);
  const e = await page(vp(V.ed, "/set"));
  assert.match(e, /value="development" checked> development/);
  assert.match(e, /<label class="choice is-disabled"><input type="checkbox" name="environment" value="production" disabled> production/);
});

test("variables add: ticking several environments sets the one value in each, and the flash names each as set or rotated", async () => {
  const first = value("many");
  const r = await post(vp(V.own, "/set"), { name: "MANY_KEY", environment: ["development", "preview"], value: first });
  assert.equal(r.status, 303);
  assert.match(await page(vp(V.own)), /<p class="callout success flash" role="status">Set MANY_KEY in development, preview\.<\/p>/);
  for (const env of ["development", "preview"]) assert.equal((await vars.revealVariable(PIA, V.own, "MANY_KEY", env)).value, first);
  const second = value("many-again");
  await post(vp(V.own, "/set"), { name: "MANY_KEY", environment: ["development", "production"], value: second });
  assert.match(await page(vp(V.own)), /Set MANY_KEY in production\. Rotated MANY_KEY in development\./);
  assert.equal((await vars.revealVariable(PIA, V.own, "MANY_KEY", "development")).value, second);
  assert.equal((await vars.revealVariable(PIA, V.own, "MANY_KEY", "production")).value, second);
  assert.equal((await vars.revealVariable(PIA, V.own, "MANY_KEY", "preview")).value, first, "an environment left unticked keeps its value");
});

test("variables add: a tick the role can't set refuses the whole form, so none of the ticked environments is set", async () => {
  const r = await post(vp(V.ed, "/set"), { name: "PARTIAL_KEY", environment: ["development", "production"], value: value("partial") });
  assert.equal(r.status, 403);
  const h = await r.text();
  assert.match(h, /role="alert"/);
  noValues(h);
  assert.equal((await vars.listVariables(PIA, V.ed)).variables.some((x) => x.name === "PARTIAL_KEY"), false);
});

test("variables add: a refused set keeps the ticks, and no tick at all is told to tick one", async () => {
  const none = await post(vp(V.own, "/set"), { name: "NONE_KEY", value: value("none") });
  assert.equal(none.status, 400);
  assert.match(await none.text(), /Tick at least one environment\./);
  const noValue = await post(vp(V.own, "/set"), { name: "NOVALUE_KEY", environment: ["development", "preview"], value: "" });
  assert.equal(noValue.status, 400);
  const h = await noValue.text();
  assert.match(h, /Enter a value\./);
  assert.match(h, /value="development" checked> development/);
  assert.match(h, /value="preview" checked> preview/);
  assert.doesNotMatch(h, /value="production" checked/);
});

test("variables add: a multi-line value is stored with LF line endings, though a browser sends CRLF", async () => {
  const first = value("crlf-a");
  const second = value("crlf-b");
  const r = await post(vp(V.own, "/set"), { name: "CRLF_KEY", environment: "development", value: `${first}\r\n${second}\r\n` });
  assert.equal(r.status, 303);
  assert.equal((await vars.revealVariable(PIA, V.own, "CRLF_KEY", "development")).value, `${first}\n${second}\n`);
});

test("variables log cells: a row naming no variable shows a dash, the environment has its own column, and who is followed by the client", async () => {
  await vars.createEnvironment(PIA, V.own, "logdash", false);
  const h = await page(vp(V.own, "/log?action=create_environment"));
  assert.match(h, /data-label="What"><div>Environment added<\/div><\/td>\s*<td class="small path-cell" data-label="Variables"><div><span class="muted" aria-label="none">—<\/span><\/div><\/td>\s*<td class="small" data-label="Environment"><div>logdash<\/div>/);
  assert.match(h, /data-label="Who"><div>you <span class="muted">· web UI<\/span>/);
  assert.doesNotMatch(h, />none</);
  await vars.deleteEnvironment(PIA, V.own, "logdash", "logdash");
});

// ---------------------------------------------------------------------------

test("variables reveal: no value, key or token reaches the server log", async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.match(log, /POST \/v\/[0-9a-f-]+\/variables\/reveal 200/);
  assert.match(log, /POST \/v\/[0-9a-f-]+\/variables\/set 303/);
  for (const s of secrets) assert.equal(log.includes(s), false, "a secret reached the log");
  assert.equal(log.includes(KEY), false, "the key reached the log");
  assert.doesNotMatch(log, /PAGEVAL|rl[ecor]_[0-9a-f]{8}|name=|environment=/);
});
