// Every email Reliquary's accounts send (web/emails/, written by
// web/emails/build.mjs): Supabase Auth's templates, pasted into the hosted
// dashboard (scripts/email-templates.sh) and served to the self-hosted Auth
// server (src/selfhost.ts, deploy/compose), and the app's own vault invite.
// Also the one route an email needed that sign-in didn't have: a change of
// address confirmed at /auth/confirm (type=email_change), against the fake
// Auth web/test.sh runs (test/fake-auth.mjs).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SAMPLE, TEMPLATES, render } from "../emails/build.mjs";
import { emailHtml, emailTemplates, vaultInviteEmail } from "../dist/emails.js";
import { emailTemplate, emailTemplatePaths } from "../dist/selfhost.js";

const REPO = process.env.REPO_DIR ?? new URL("../..", import.meta.url).pathname;
const { WEB_URL, WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE } = process.env;

const AUTH = TEMPLATES.filter((t) => t.gotrue);
const html = (t) => emailHtml(t.id);

// What Supabase Auth passes each template (supabase/auth v2.197.0,
// internal/mailer/templatemailer). A template using anything else would
// show a blank or "<no value>".
const AUTH_VARS = {
  MAGIC_LINK: ["SiteURL", "ConfirmationURL", "Email", "Token", "TokenHash", "Data", "RedirectTo"],
  CONFIRMATION: ["SiteURL", "ConfirmationURL", "Email", "Token", "TokenHash", "Data", "RedirectTo"],
  INVITE: ["SiteURL", "ConfirmationURL", "Email", "Token", "TokenHash", "Data", "RedirectTo"],
  RECOVERY: ["SiteURL", "ConfirmationURL", "Email", "Token", "TokenHash", "Data", "RedirectTo"],
  EMAIL_CHANGE: ["SiteURL", "ConfirmationURL", "Email", "NewEmail", "Token", "TokenHash", "SendingTo", "Data", "RedirectTo"],
  REAUTHENTICATION: ["SiteURL", "Email", "Token", "Data"],
  PASSWORD_CHANGED_NOTIFICATION: ["SiteURL", "Email", "Data"],
  EMAIL_CHANGED_NOTIFICATION: ["SiteURL", "Email", "OldEmail", "Data"],
  PHONE_CHANGED_NOTIFICATION: ["SiteURL", "Email", "Phone", "OldPhone", "Data"],
  IDENTITY_LINKED_NOTIFICATION: ["SiteURL", "Email", "Provider", "Data"],
  IDENTITY_UNLINKED_NOTIFICATION: ["SiteURL", "Email", "Provider", "Data"],
  MFA_FACTOR_ENROLLED_NOTIFICATION: ["SiteURL", "Email", "FactorType", "Data"],
  MFA_FACTOR_UNENROLLED_NOTIFICATION: ["SiteURL", "Email", "FactorType", "Data"],
};
const placeholders = (s) => [...s.matchAll(/\{\{\s*\.?([A-Za-z]*)[^}]*\}\}/g)].map((m) => m[1]);

// Templates --------------------------------------------------------------------

test("emails: web/emails matches web/emails/build.mjs (the one source)", () => {
  const r = spawnSync(process.execPath, ["emails/build.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(emailTemplates().map((t) => t.id), TEMPLATES.map((t) => t.id));
});

test("emails: there is a template for every email Supabase Auth sends, and the vault invite", () => {
  assert.deepEqual(AUTH.map((t) => t.gotrue).sort(), Object.keys(AUTH_VARS).sort());
  assert.ok(TEMPLATES.some((t) => t.id === "vault-invite" && !t.gotrue));
  for (const t of TEMPLATES) assert.ok(html(t), `${t.id}.html`);
});

test("emails: every template renders with sample values, with no placeholder left", () => {
  for (const t of TEMPLATES) {
    const out = render(html(t), SAMPLE);
    assert.doesNotMatch(out, /\{\{|\}\}/, t.id);
    assert.match(out, new RegExp(SAMPLE.Email.replace(".", "\\.")), `${t.id} names the account`);
  }
});

test("emails: Supabase's templates use only the variables Auth passes that email", () => {
  for (const t of AUTH) {
    for (const v of placeholders(html(t))) assert.ok(AUTH_VARS[t.gotrue].includes(v), `${t.id} uses {{ .${v} }}`);
    assert.doesNotMatch(html(t), /ConfirmationURL/, `${t.id}: never Auth's own link (tokens in a fragment)`);
  }
});

test("emails: sign-in and sign-up give the code and a link to this site's /auth/confirm with type=email", () => {
  for (const id of ["sign-in", "confirm-signup"]) {
    const h = emailHtml(id);
    assert.match(h, /<strong>\{\{ \.Token \}\}<\/strong>/, `${id}: the big code`);
    assert.match(h, /href="\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=email"/, `${id}: the button`);
    assert.match(h, /\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&amp;type=email<\/a>/, `${id}: the link written out`);
  }
});

test("emails: an Auth invite and a password reset link to /auth/confirm with type=email; reset says there's no password", () => {
  for (const id of ["invite-user", "reset-password"]) {
    assert.match(emailHtml(id), /href="\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=email"/, id);
  }
  assert.match(emailHtml("reset-password"), /doesn't use passwords/);
  assert.match(emailHtml("reset-password"), /\{\{ \.SiteURL \}\}\/signin/);
});

test("emails: a change of address links to /auth/confirm with type=email_change and names both addresses", () => {
  const h = emailHtml("change-email");
  assert.match(h, /href="\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=email_change"/);
  assert.match(h, /\{\{ \.Email \}\}/);
  assert.match(h, /\{\{ \.NewEmail \}\}/);
});

test("emails: reauthentication gives the code, and says no one from Reliquary will ask for it", () => {
  assert.match(emailHtml("reauthentication"), /<strong>\{\{ \.Token \}\}<\/strong>/);
  assert.match(emailHtml("reauthentication"), /No one from Reliquary will ever ask you for this code/);
});

test("emails: no external resources, images, scripts or remote fonts", () => {
  for (const t of TEMPLATES) {
    const h = html(t);
    for (const bad of [/<script/i, /<img/i, /<link/i, /<iframe/i, /\bsrc\s*=/i, /url\(/i, /@import/i, /@font-face/i, /https?:\/\//i, /javascript:/i]) {
      assert.doesNotMatch(h, bad, `${t.id}: ${bad}`);
    }
    // Every link is one Auth or the app fills in.
    for (const [, href] of h.matchAll(/href="([^"]*)"/g)) assert.match(href, /^\{\{ \.(SiteURL|InviteURL) \}\}/, `${t.id}: ${href}`);
  }
});

test("emails: plain words: no em dashes, no generic failure phrases, no marketing", () => {
  const banned = /\u2014|something went wrong|went wrong|an error occurred|try again later|click here|exciting|we're thrilled|unlock|seamless/i;
  for (const t of TEMPLATES) {
    assert.doesNotMatch(html(t), banned, t.id);
    assert.doesNotMatch(t.subject, banned, t.id);
  }
});

test("emails: every email says who sent it and what to do if you didn't ask", () => {
  for (const t of TEMPLATES) {
    const h = html(t);
    assert.match(h, /Sent by Reliquary at \{\{ \.SiteURL \}\}/, t.id);
    assert.match(h, /If you (didn't|weren't)/, t.id);
    if (t.section === "Security notifications") assert.match(h, /If you didn't make this change, tell the person who runs Reliquary/, t.id);
    else assert.match(h, /ignore this email\. Nothing (changes|happens)/, t.id);
  }
});

test("emails: dark mode and email-client safety: color-scheme meta, a dark palette, tables, inline styles", () => {
  for (const t of TEMPLATES) {
    const h = html(t);
    assert.match(h, /<meta name="color-scheme" content="light dark">/, t.id);
    assert.match(h, /@media \(prefers-color-scheme: dark\)/, t.id);
    assert.match(h, /<table role="presentation"/, t.id);
    assert.match(h, /<body[^>]*style="[^"]*background-color:#f7f6f5/, t.id);
    assert.match(h, /font-family:-apple-system/, t.id);
    assert.doesNotMatch(h, /border-radius/, `${t.id}: sharp corners`);
  }
});

test("emails: subjects are short sentences, the same as each template's title", () => {
  for (const t of TEMPLATES) {
    assert.match(t.subject, /^[A-Z]/, t.id);
    assert.doesNotMatch(t.subject, /[.!]$/, t.id);
    assert.ok(t.subject.length <= 70, `${t.id}: ${t.subject.length} characters`);
    assert.ok(html(t).includes(`<title>${t.subject}</title>`), t.id);
    if (t.gotrue) assert.doesNotMatch(t.subject, /\{\{/, `${t.id}: Auth subjects are fixed text`);
  }
  assert.equal(TEMPLATES.find((t) => t.id === "sign-in").subject, "Your Reliquary sign-in code");
});

test("emails: the vault invite renders with every value escaped, the link in the button and written out", () => {
  const link = "https://app.reliquary.test/invite?token=rli_" + "a".repeat(64);
  const m = vaultInviteEmail({ to: "zoe@example.test", link, vaultName: `<b>"Acme" & co</b>`, role: "editor", expiresAt: new Date("2026-10-03T14:00:00Z") }, "https://app.reliquary.test");
  assert.equal(m.subject, `You're invited to <b>"Acme" & co</b> on Reliquary`);
  assert.doesNotMatch(m.html, /<b>/);
  assert.match(m.html, /&lt;b&gt;&quot;Acme&quot; &amp; co&lt;\/b&gt;/);
  assert.ok(m.html.includes(`href="${link}"`), "the button");
  assert.ok(m.html.includes(`>${link}</a>`), "the link written out");
  assert.match(m.html, /Sat, 03 Oct 2026 14:00 UTC/);
  assert.match(m.html, /zoe@example\.test/);
  assert.doesNotMatch(m.html, /\{\{|Generated by/);
});

// Self-hosted ------------------------------------------------------------------

test("emails: self-hosted serves every Supabase Auth template, and only with SELF_HOSTED=1", () => {
  const paths = emailTemplatePaths();
  assert.equal(paths.length, AUTH.length);
  for (const t of AUTH) {
    const path = `/_selfhost/email/${t.id}.html`;
    assert.ok(paths.some((p) => p.path === path && p.gotrue === t.gotrue), path);
    assert.equal(emailTemplate(path, { SELF_HOSTED: "1" }), emailHtml(t.id), path);
    assert.equal(emailTemplate(path, {}), undefined, path);
  }
  for (const other of ["/_selfhost/email/vault-invite.html", "/_selfhost/email/manifest.tsv", "/_selfhost/email/../package.json", "/_selfhost/email/build.mjs", "/_selfhost/email/nope.html"]) {
    assert.equal(emailTemplate(other, { SELF_HOSTED: "1" }), undefined, other);
  }
});

test("emails: an instance without SELF_HOSTED serves no template over HTTP", async () => {
  assert.ok(WEB_URL, "run through web/test.sh");
  for (const t of AUTH) {
    const r = await fetch(`${WEB_URL}/_selfhost/email/${t.id}.html`, { redirect: "manual" });
    assert.doesNotMatch(await r.text(), /\{\{ \.SiteURL \}\}/, t.id);
  }
});

test("emails: deploy/compose gives self-hosted Auth every template, its subject, and turns on the security notifications", () => {
  const compose = readFileSync(join(REPO, "deploy/compose/compose.yml"), "utf8");
  for (const t of AUTH) {
    assert.ok(
      compose.includes(`GOTRUE_MAILER_TEMPLATES_${t.gotrue}: \${EMAIL_TEMPLATES_URL:-http://web:8790/_selfhost/email}/${t.id}.html\n`),
      `GOTRUE_MAILER_TEMPLATES_${t.gotrue}`,
    );
    assert.ok(compose.includes(`GOTRUE_MAILER_SUBJECTS_${t.gotrue}: ${t.subject}\n`), `GOTRUE_MAILER_SUBJECTS_${t.gotrue}`);
    if (t.notify) assert.ok(compose.includes(`GOTRUE_MAILER_NOTIFICATIONS_${t.notify}_ENABLED: "true"\n`), t.notify);
  }
  assert.equal((compose.match(/GOTRUE_MAILER_TEMPLATES_/g) ?? []).length, AUTH.length, "no template left over");
});

test("emails: scripts/email-templates.sh lists every Supabase template with where it goes and its subject", () => {
  const r = spawnSync("bash", [join(REPO, "scripts/email-templates.sh")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  for (const t of AUTH) {
    assert.ok(r.stdout.includes(t.name), t.name);
    assert.ok(r.stdout.includes(t.subject), t.subject);
    assert.ok(r.stdout.includes(`web/emails/${t.id}.html`), t.id);
  }
  assert.doesNotMatch(r.stdout, /vault-invite/);
  const one = spawnSync("bash", [join(REPO, "scripts/email-templates.sh"), "sign-in"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Your Reliquary sign-in code/);
  assert.match(one.stdout, /<strong>\{\{ \.Token \}\}<\/strong>/, "without a clipboard, the HTML is printed");
  const bad = spawnSync("bash", [join(REPO, "scripts/email-templates.sh"), "nope"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no template "nope"/);
});

// A change of address at /auth/confirm -------------------------------------------

const AT = "__Host-rlq_at";
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const remember = (...s) => appendFileSync(AUTH_SECRETS_FILE, s.filter(Boolean).map((x) => `${x}\n`).join(""));
class Jar {
  c = new Map();
  take(r) {
    for (const sc of r.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (/Max-Age=0(;|$)/.test(sc)) this.c.delete(pair.slice(0, i));
      else this.c.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return r;
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
const get = async (path, jar) => jar.take(await fetch(A + path, { headers: { cookie: jar.header }, redirect: "manual" }));
const post = async (path, fields, jar) =>
  jar.take(
    await fetch(A + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)?.[1];
async function askChange(both) {
  const n = Math.random().toString(36).slice(2, 10);
  const r = await (await fetch(`${FAKE}/_email_change`, { method: "POST", body: JSON.stringify({ email: `old-${n}@example.test`, new_email: `new-${n}@example.test`, both }) })).json();
  remember(r.token_hash_new, r.token_hash_current);
  return r;
}
async function confirm(tokenHash, jar) {
  const page = await (await get(`/auth/confirm?token_hash=${tokenHash}&type=email_change`, jar)).text();
  assert.match(page, /Confirm the change of email address/);
  assert.match(page, /<input type="hidden" name="type" value="email_change">/);
  return post("/auth/confirm", { csrf: csrfOf(page), token_hash: tokenHash, type: "email_change" }, jar);
}

test("emails: a change-of-address link confirms at /auth/confirm (type=email_change) and signs in", async () => {
  assert.ok(A && FAKE && AUTH_SECRETS_FILE, "run through web/test.sh");
  const { token_hash_new } = await askChange(false);
  const jar = new Jar();
  const r = await confirm(token_hash_new, jar);
  assert.equal(r.status, 303);
  assert.ok(jar.c.has(AT), "signed in");
  const again = new Jar();
  const spent = await confirm(token_hash_new, again);
  assert.equal(spent.status, 400);
  assert.match(await spent.text(), /Link expired/);
});

test("emails: with both addresses asked, the first confirmation says to open the other, and the second signs in", async () => {
  const { token_hash_new, token_hash_current } = await askChange(true);
  const jar = new Jar();
  const first = await confirm(token_hash_current, jar);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /One address confirmed/);
  assert.ok(!jar.c.has(AT), "not signed in yet");
  const second = await confirm(token_hash_new, jar);
  assert.equal(second.status, 303);
  assert.ok(jar.c.has(AT));
});

test("emails: a link with an unknown type is refused as incomplete", async () => {
  const r = await get("/auth/confirm?token_hash=abcdefabcdefabcdef&type=recovery", new Jar());
  assert.equal(r.status, 400);
  assert.match(await r.text(), /Link incomplete/);
});
