// Sign-in with Supabase Auth (docs/research/hosting.md, sections 3 and 10B).
// web/test.sh starts two AUTH_MODE=supabase instances (A and B, one
// SESSION_SECRET, PUBLIC_URL=https://...) and a fake Supabase Auth
// (test/fake-auth.mjs) that both trust. Ana signs in by email; Eve
// (00000000-0000-0000-0000-0000000000e1) exists only here and has no vaults.
//
// Every code, token hash and refresh token seen is appended to
// AUTH_SECRETS_FILE; test.sh then checks none reached the server logs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { before, test } from "node:test";

const { WEB_AUTH_A_URL: A, WEB_AUTH_B_URL: B, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE } = process.env;
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const ANA = "00000000-0000-0000-0000-00000000000a";
const EVE = "00000000-0000-0000-0000-0000000000e1";
const BEN = "00000000-0000-0000-0000-00000000000b";
const AT = "__Host-rlq_at";
const RT = "__Host-rlq_rt";

const remember = (...secrets) => appendFileSync(AUTH_SECRETS_FILE, secrets.filter(Boolean).map((s) => `${s}\n`).join(""));

// A cookie jar per browser: name -> value, following Set-Cookie (Max-Age=0 deletes).
class Jar {
  constructor(init = {}) {
    this.c = new Map(Object.entries(init));
  }
  take(r) {
    for (const sc of r.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (/Max-Age=0(;|$)/.test(sc)) this.c.delete(k);
      else this.c.set(k, v);
      if (k === RT && v) remember(v);
    }
    return r;
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const get = async (base, path, jar) => jar.take(await fetch(base + path, { headers: { cookie: jar.header }, redirect: "manual" }));
const post = async (base, path, fields, jar, headers = {}) =>
  jar.take(
    await fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
// One retry on a dropped connection: the fake Auth runs in its own container,
// and a kept-alive socket it closed while the suite was busy elsewhere fails
// the first request on it (undici doesn't replay a POST).
const fake = async (path, init) => {
  try {
    return await (await fetch(FAKE + path, init)).json();
  } catch (e) {
    if (e?.message !== "fetch failed") throw e;
    return (await fetch(FAKE + path, init)).json();
  }
};
const stats = () => fake("/_stats");
const lastEmail = async (email) => {
  const m = await fake(`/_last_email?email=${encodeURIComponent(email)}`);
  if (m) remember(m.code, m.token_hash);
  return m;
};
const mint = async (body) => (await fake("/_mint", { method: "POST", body: JSON.stringify(body) })).token;

// GET /signin, then POST the email: the jar holds the pre-sign-in cookie.
async function askForCode(base, jar, email, next) {
  const page = await (await get(base, `/signin${next ? `?next=${encodeURIComponent(next)}` : ""}`, jar)).text();
  return post(base, "/signin", { csrf: csrfOf(page), email, next: next ?? "/" }, jar);
}
async function signInByCode(base, email = "ana@example.test", next) {
  const jar = new Jar();
  const r = await askForCode(base, jar, email, next);
  assert.equal(r.status, 200);
  const page = await r.text();
  const { code } = await lastEmail(email);
  const done = await post(base, "/signin/code", { csrf: csrfOf(page), email, code, next: next ?? "/" }, jar);
  return { jar, done };
}

before(() => {
  assert.ok(A && B && FAKE && PUBLIC_URL && AUTH_SECRETS_FILE, "run through web/test.sh (supabase-mode instances and the fake Auth)");
  assert.match(PUBLIC_URL, /^https:\/\//);
  appendFileSync(AUTH_SECRETS_FILE, "");
});

// Sign-in ------------------------------------------------------------------

test("sign-in: a signed-out page sends you to sign in and back", async () => {
  const r = await get(A, "/review?x=1", new Jar());
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/signin?next=${encodeURIComponent("/review?x=1")}`);
  const page = await (await get(A, r.headers.get("location"), new Jar())).text();
  assert.match(page, /<input type="hidden" name="next" value="\/review\?x=1">/);
  assert.doesNotMatch(page, /<script/i);
});

test("sign-in: by 6-digit code lands on the page asked for, signed in", async () => {
  const before = await stats();
  const { jar, done } = await signInByCode(A, "ana@example.test", "/review");
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/review");
  assert.equal((await stats()).lastCreateUser, false, "sign-in must not create users");
  assert.equal((await stats()).otp, before.otp + 1);
  const h = await (await get(A, "/inbox", jar)).text();
  assert.match(h, /Signed in as <strong>00000000<\/strong>/);
  assert.doesNotMatch(h, /\(local\)/);
  assert.match(h, /action="\/signout"/);
});

test("sign-in: by link, through a Sign in button; opening the link alone signs nobody in", async () => {
  const jar = new Jar();
  await askForCode(A, jar, "ana@example.test", "/activity");
  const { token_hash } = await lastEmail("ana@example.test");
  // A mail scanner (no cookies) fetching the link:
  const verifies = (await stats()).verify;
  const scanner = await get(A, `/auth/confirm?token_hash=${token_hash}&type=email`, new Jar());
  assert.equal(scanner.status, 200);
  assert.ok(!scanner.headers.getSetCookie().some((c) => c.startsWith(AT) || c.startsWith(RT)));
  assert.equal((await stats()).verify, verifies, "the GET must not spend the link");
  // The person, in the browser that asked:
  const page = await (await get(A, `/auth/confirm?token_hash=${token_hash}&type=email`, jar)).text();
  assert.match(page, /<form method="post" action="\/auth\/confirm"/);
  const r = await post(A, "/auth/confirm", { csrf: csrfOf(page), token_hash }, jar);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/activity");
  assert.equal((await get(A, "/", jar)).status, 200);
});

test("sign-in: an unknown email gets the same page as a known one", async () => {
  const known = await askForCode(A, new Jar(), "ana@example.test");
  const unknown = await askForCode(A, new Jar(), "nobody@example.test");
  assert.equal(known.status, unknown.status);
  const norm = (h) => h.replace(/ana@example\.test|nobody@example\.test/g, "EMAIL").replace(/value="[0-9a-f]{48}"/g, 'value="T"');
  assert.equal(norm(await known.text()), norm(await unknown.text()));
  const names = (r) => r.headers.getSetCookie().map((c) => c.split("=")[0]).sort();
  assert.deepEqual(names(known), names(unknown));
});

test("sign-in: a wrong code, a used code or a used link signs nobody in", async () => {
  const jar = new Jar();
  const page = await (await askForCode(A, jar, "ana@example.test")).text();
  const { code, token_hash } = await lastEmail("ana@example.test");
  const wrong = code === "123456" ? "654321" : "123456";
  const bad = await post(A, "/signin/code", { csrf: csrfOf(page), email: "ana@example.test", code: wrong }, jar);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /That code didn’t work/);
  assert.ok(!jar.c.has(AT));
  // The right code works once; then neither it nor the link works again.
  assert.equal((await post(A, "/signin/code", { csrf: csrfOf(page), email: "ana@example.test", code }, jar)).status, 303);
  const again = new Jar();
  const p2 = await (await get(A, "/signin", again)).text();
  assert.equal((await post(A, "/signin/code", { csrf: csrfOf(p2), email: "ana@example.test", code }, again)).status, 400);
  const link = await (await get(A, `/auth/confirm?token_hash=${token_hash}&type=email`, again)).text();
  const r = await post(A, "/auth/confirm", { csrf: csrfOf(link), token_hash }, again);
  assert.equal(r.status, 400);
  assert.ok(!again.c.has(AT));
});

test("sign-in: forms need the pre-sign-in token and the site's Origin", async () => {
  const jar = new Jar();
  const token = csrfOf(await (await get(A, "/signin", jar)).text());
  const otp = (await stats()).otp;
  assert.equal((await post(A, "/signin", { email: "ana@example.test" }, jar)).status, 403, "no token");
  assert.equal((await post(A, "/signin", { csrf: "0".repeat(48), email: "ana@example.test" }, jar)).status, 403, "wrong token");
  assert.equal((await post(A, "/signin", { csrf: token, email: "ana@example.test" }, new Jar())).status, 403, "token without its cookie");
  for (const origin of ["https://evil.example", "null", A]) {
    assert.equal((await post(A, "/signin", { csrf: token, email: "ana@example.test" }, jar, { origin })).status, 403, origin);
  }
  assert.equal((await stats()).otp, otp, "no email may be sent");
});

test("sign-in: next never leaves the site", async () => {
  for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    const page = await (await get(A, `/signin?next=${encodeURIComponent(next)}`, new Jar())).text();
    assert.match(page, /name="next" value="\/"/, next);
  }
  const { done } = await signInByCode(A, "ana@example.test", "//evil.example/x");
  assert.equal(done.headers.get("location"), "/");
});

test("sign-in: copy has no em dashes or straight apostrophes", async () => {
  const jar = new Jar();
  const pages = [await (await get(A, "/signin", jar)).text(), await (await askForCode(A, jar, "nobody@example.test")).text(),
    await (await get(A, "/auth/confirm?token_hash=abcdefabcdefabcdef&type=email", jar)).text()];
  for (const h of pages) {
    const visible = h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");
    assert.doesNotMatch(visible, /—/);
    assert.doesNotMatch(visible, /[a-z]'[a-z]/i);
  }
});

test("sign-in: the page says Reliquary is invite-only, what an invite does, and how to request access", async () => {
  const h = await (await get(A, "/signin", new Jar())).text();
  assert.match(h, /<p class="hint">Reliquary is invite-only\. Anyone can sign in, but an account creates vaults only after it joins one by invite\. Have an invite\? Open its link\. Otherwise, <a href="mailto:[^"?]+\?subject=Reliquary%20early%20access">request access<\/a>\.<\/p>/);
  assert.match(h, /<a href="[^"]*\/docs">About Reliquary<\/a>/);
});

test("sign-in: a malformed email is refused in the danger tone, announced, and tied to the email field", async () => {
  const jar = new Jar();
  const page = await (await get(A, "/signin", jar)).text();
  assert.doesNotMatch(page, /aria-invalid/);
  const r = await post(A, "/signin", { csrf: csrfOf(page), email: "not-an-address", next: "/" }, jar);
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<p class="callout danger" role="alert" id="email-error">Enter your email address, like name@example\.com\.<\/p>/);
  assert.match(h, /<input type="text" id="email" name="email"[^>]* required aria-invalid="true" aria-describedby="email-error">/);
});

test("sign-in: a bad or expired code is refused in the danger tone, announced, and tied to the code field", async () => {
  const jar = new Jar();
  const page = await (await askForCode(A, jar, "danger-tone@example.test")).text();
  assert.doesNotMatch(page, /aria-invalid/);
  const r = await post(A, "/signin/code", { csrf: csrfOf(page), email: "danger-tone@example.test", code: "12" }, jar);
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<p class="callout danger" role="alert" id="code-error">That code didn’t work\. It may have expired or been used already/);
  assert.match(h, /<input type="text" id="code" name="code"[^>]* required aria-invalid="true" aria-describedby="code-error">/);
  assert.doesNotMatch(h, /callout attention/);
});

test("sign-in: an incomplete link is an error page with what, where, why and a reference", async () => {
  const r = await get(A, "/auth/confirm?token_hash=short", new Jar());
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<h1>Link incomplete<\/h1>/);
  assert.match(h, /<p class="lede">This sign-in link is missing a part\. Copy the whole link from the email, or <a href="\/signin">send a new one<\/a>\.<\/p>/);
  assert.match(h, /<dt>What<\/dt><dd>Signing in with a link<\/dd>/);
  assert.match(h, /<dt>Where<\/dt><dd>sign-in link<\/dd>/);
  assert.match(h, /<dt>Why<\/dt><dd>The link is missing its token or its type: it was cut short when it was copied\.<\/dd>/);
  assert.match(h, /<dt>Reference<\/dt><dd><code>ref [0-9a-f]{8}<\/code><\/dd>/);
});

test("sign-in: an expired or used link is an error page with a reference", async () => {
  const jar = new Jar();
  const hash = "expiredlinkexpiredlink";
  const page = await (await get(A, `/auth/confirm?token_hash=${hash}&type=email`, jar)).text();
  const r = await post(A, "/auth/confirm", { csrf: csrfOf(page), token_hash: hash }, jar);
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<h1>Link expired<\/h1>/);
  assert.match(h, /That sign-in link has expired or was already used\. <a href="\/signin">Send a new one<\/a>\./);
  assert.match(h, /<dt>Where<\/dt><dd>sign-in \(Supabase Auth\)<\/dd>/);
  assert.match(h, /<dt>Reference<\/dt><dd><code>ref [0-9a-f]{8}<\/code><\/dd>/);
  assert.ok(!jar.c.has(AT));
});

// Session cookies ------------------------------------------------------------

test("session: cookies are __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, and private", async () => {
  const { done } = await signInByCode(A);
  const set = done.headers.getSetCookie();
  const at = set.find((c) => c.startsWith(`${AT}=`));
  const rt = set.find((c) => c.startsWith(`${RT}=`));
  for (const c of [at, rt]) {
    assert.ok(c);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; Secure(;|$)/);
    assert.match(c, /; SameSite=Lax/);
    assert.match(c, /; Path=\//);
    assert.doesNotMatch(c, /Domain=/i);
  }
  assert.match(at, /Max-Age=3600/);
  assert.match(rt, /Max-Age=2592000/);
  assert.equal(done.headers.get("cache-control"), "private, no-store");
});

test("session: two instances accept each other's cookies and form tokens", async () => {
  const { jar } = await signInByCode(A);
  const csrf = csrfOf(await (await get(A, "/", jar)).text());
  assert.equal((await get(B, "/", jar)).status, 200);
  assert.equal(csrfOf(await (await get(B, "/", jar)).text()), csrf);
  const r = await post(B, "/theme", { csrf, theme: "dark", back: "/" }, jar);
  assert.equal(r.status, 303);
});

test("session: the form token differs per session and only works with its own", async () => {
  const one = (await signInByCode(A)).jar;
  const two = (await signInByCode(A)).jar;
  const c1 = csrfOf(await (await get(A, "/", one)).text());
  const c2 = csrfOf(await (await get(A, "/", two)).text());
  assert.notEqual(c1, c2);
  assert.equal((await post(A, "/theme", { csrf: c1, theme: "dark", back: "/" }, two)).status, 403);
  assert.equal((await post(A, "/theme", { csrf: c2, theme: "dark", back: "/" }, two)).status, 303);
});

test("session: a notice after a form shows once, on either instance, and can't be forged", async () => {
  const { jar } = await signInByCode(A);
  const csrf = csrfOf(await (await get(A, "/connections", jar)).text());
  const r = await post(A, "/connections/new", { csrf, name: "x", scope: "some", access: "read", days: "7" }, jar);
  assert.equal(r.status, 303);
  assert.match(await (await get(B, "/connections", jar)).text(), /Tick at least one vault/);
  assert.doesNotMatch(await (await get(A, "/connections", jar)).text(), /Tick at least one vault/);
  const forged = Buffer.from("Your account is locked: call +1 555 0100").toString("base64url");
  jar.c.set("__Host-rlq_flash", `${forged}.${"0".repeat(64)}`);
  assert.doesNotMatch(await (await get(A, "/connections", jar)).text(), /locked/);
});

test("session: a notice keeps its tone on either instance, and the tone is signed with it", async () => {
  const { jar } = await signInByCode(A);
  const csrf = csrfOf(await (await get(A, "/settings", jar)).text());
  const tooLong = { csrf, display_name: "x".repeat(81) };
  const r = await post(A, "/settings/name", tooLong, jar);
  assert.equal(r.status, 303);
  assert.match(await (await get(B, r.headers.get("location"), jar)).text(),
    /<p class="callout danger flash" role="alert">A display name is at most 80 characters\. Nothing was saved\.<\/p>/);
  // The same message, its tone changed to success, under the old signature.
  await post(A, "/settings/name", tooLong, jar);
  const [body, sig] = jar.c.get("__Host-rlq_flash").split(".");
  const f = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  assert.equal(f.t, "danger");
  jar.c.set("__Host-rlq_flash", `${Buffer.from(JSON.stringify({ ...f, t: "success" })).toString("base64url")}.${sig}`);
  assert.doesNotMatch(await (await get(B, "/", jar)).text(), /display name is at most/);
});

test("session: an expired access token is refreshed once, with new cookies", async () => {
  const { jar } = await signInByCode(A);
  const oldRt = jar.c.get(RT);
  const exp = Math.floor(Date.now() / 1000) - 5;
  const expired = await mint({ sub: ANA, session_id: "expired-session", claims: { exp } });
  jar.c.set(AT, expired);
  const n = (await stats()).refresh;
  const r = await get(A, "/", jar);
  assert.equal(r.status, 200);
  assert.equal((await stats()).refresh, n + 1);
  assert.notEqual(jar.c.get(AT), expired);
  assert.notEqual(jar.c.get(RT), oldRt);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  // The new cookies work, on either instance, with no further refresh.
  assert.equal((await get(B, "/", jar)).status, 200);
  assert.equal((await stats()).refresh, n + 1);
  // No access cookie at all (the browser dropped it at Max-Age): refreshed too.
  jar.c.delete(AT);
  assert.equal((await get(A, "/inbox", jar)).status, 200);
  assert.equal((await stats()).refresh, n + 2);
});

test("session: a failed refresh signs out and clears both cookies", async () => {
  const { jar } = await signInByCode(A);
  const usedRt = jar.c.get(RT);
  jar.c.delete(AT);
  assert.equal((await get(A, "/", jar)).status, 200); // spends usedRt
  const stale = new Jar({ [RT]: usedRt, [AT]: await mint({ sub: ANA, session_id: "s", claims: { exp: 1 } }) });
  const r = await get(A, "/", stale);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin");
  const set = r.headers.getSetCookie();
  assert.ok(set.some((c) => c.startsWith(`${AT}=;`) && /Max-Age=0/.test(c)));
  assert.ok(set.some((c) => c.startsWith(`${RT}=;`) && /Max-Age=0/.test(c)));
  // Reuse revoked the whole session (as Supabase does): the rotated token is dead too.
  jar.c.delete(AT);
  assert.equal((await get(A, "/", jar)).status, 303);
});

test("session: sign out ends the Supabase session and clears the cookies", async () => {
  const { jar } = await signInByCode(A);
  const rt = jar.c.get(RT);
  const csrf = csrfOf(await (await get(A, "/", jar)).text());
  const n = (await stats()).logout;
  const r = await post(A, "/signout", { csrf }, jar);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin");
  assert.equal((await stats()).logout, n + 1);
  assert.ok(!jar.c.has(AT) && !jar.c.has(RT));
  assert.equal((await get(A, "/", new Jar({ [RT]: rt }))).status, 303, "the refresh token is revoked");
});

// Tokens that must be refused -------------------------------------------------

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const projectKey = async () => (await fake("/_jwks")).keys[0];
const kid = async () => (await projectKey()).kid;
const claimsFor = (over = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: `${FAKE}/auth/v1`, aud: "authenticated", sub: ANA, role: "authenticated", session_id: "hostile", iat: now, exp: now + 600, ...over };
};
const status = async (token) => {
  const r = await get(A, "/", new Jar({ [AT]: token }));
  return { status: r.status, cleared: r.headers.getSetCookie().some((c) => c.startsWith(`${AT}=;`) && /Max-Age=0/.test(c)) };
};

test("jwt: a token signed by the project's key is accepted (control for the refusals below)", async () => {
  assert.equal((await status(await mint({ sub: ANA, session_id: "control" }))).status, 200);
});

test("jwt: refused when signed by another key, even with the right key id", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const header = b64({ alg: "ES256", typ: "JWT", kid: await kid() });
  const payload = b64(claimsFor());
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  assert.deepEqual(await status(`${header}.${payload}.${sig}`), { status: 303, cleared: true });
});

test("jwt: refused with alg none, HS256 (the public key as a secret) or RS256", async () => {
  const k = await kid();
  const payload = b64(claimsFor());
  assert.equal((await status(`${b64({ alg: "none", typ: "JWT", kid: k })}.${payload}.`)).status, 303);
  assert.equal((await status(`${b64({ alg: "none", typ: "JWT" })}.${payload}.`)).status, 303);
  // The classic confusion: HMAC keyed with the public key, as PEM.
  const pem = createPublicKey({ key: await projectKey(), format: "jwk" }).export({ format: "pem", type: "spki" });
  const hsHeader = b64({ alg: "HS256", typ: "JWT", kid: k });
  const hs = createHmac("sha256", pem).update(`${hsHeader}.${payload}`).digest("base64url");
  assert.equal((await status(`${hsHeader}.${payload}.${hs}`)).status, 303);
  // Signed by the right key but relabelled: still refused (the algorithm is pinned).
  const good = await mint({ sub: ANA, session_id: "relabel" });
  const [, p, s] = good.split(".");
  assert.equal((await status(`${b64({ alg: "RS256", typ: "JWT", kid: k })}.${p}.${s}`)).status, 303);
});

test("jwt: refused with the wrong issuer, audience or role", async () => {
  for (const claims of [
    { iss: "https://other.supabase.co/auth/v1" },
    { iss: `${FAKE}/auth/v1/` },
    { aud: "anon" },
    { aud: ["authenticated", "https://mcp.example.test/mcp"] },
    { role: "service_role" },
    { role: "anon" },
  ]) {
    assert.deepEqual(await status(await mint({ sub: ANA, session_id: "c", claims })), { status: 303, cleared: true }, JSON.stringify(claims));
  }
});

test("jwt: refused when it carries client_id (a Supabase OAuth-server token)", async () => {
  assert.deepEqual(await status(await mint({ sub: ANA, session_id: "c", claims: { client_id: "9a2b-some-app" } })), { status: 303, cleared: true });
});

test("jwt: refused when tampered, from an unknown key id, anonymous, or without session or subject", async () => {
  const good = await mint({ sub: ANA, session_id: "t" });
  const [h, , s] = good.split(".");
  assert.equal((await status(`${h}.${b64(claimsFor({ sub: BEN }))}.${s}`)).status, 303, "payload swapped");
  assert.equal((await status(await mint({ sub: ANA, session_id: "t", header: { kid: "no-such-key" } }))).status, 303, "unknown kid");
  assert.equal((await status(await mint({ sub: ANA, session_id: "t", claims: { is_anonymous: true } }))).status, 303, "anonymous");
  assert.equal((await status(await mint({ sub: ANA }))).status, 303, "no session_id");
  assert.equal((await status(await mint({ sub: "not-a-uuid", session_id: "t" }))).status, 303, "bad sub");
  assert.equal((await status(await mint({ sub: ANA, session_id: "t", header: { crit: ["exp"] } }))).status, 303, "crit");
  assert.equal((await status("not.a.jwt")).status, 303);
});

// Claims in the database -------------------------------------------------------

test("claims: the database gets only sub, role and the session's iat, so an act claim in the JWT doesn't make the session an agent", async () => {
  // Agents may not mint tokens (supabase/tests/access_tokens_test.sql). If the
  // JWT's act claim reached the database, this would be refused.
  const jar = new Jar({ [AT]: await mint({ sub: EVE, session_id: "eve-1", claims: { act: { sub: "tok", name: "Sneaky agent" }, app_metadata: { role: "owner" } } }) });
  const page = await (await get(A, "/connections", jar)).text();
  assert.match(page, /Signed in as <strong>00000000<\/strong>/);
  const r = await post(A, "/connections/new", { csrf: csrfOf(page), name: "auth test", scope: "all", access: "read", days: "7" }, jar);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /rlq_[A-Za-z0-9_-]{20,}/);
});

// Pure verification (dist/auth.js), both algorithms -----------------------------

test("jwt: verifyJwt pins the configured algorithm, for RS256 as for ES256", async () => {
  const { verifyJwt } = await import("../dist/auth.js");
  const issuer = "https://ref.supabase.co/auth/v1";
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: "authenticated", sub: ANA, role: "authenticated", session_id: "s", exp: now + 60 };
  const make = (alg, key, kid, c = claims) => {
    const data = `${b64({ alg, typ: "JWT", kid })}.${b64(c)}`;
    const opts = alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key;
    return `${data}.${sign("sha256", Buffer.from(data), opts).toString("base64url")}`;
  };
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keys = [
    { ...rsa.publicKey.export({ format: "jwk" }), kid: "r", alg: "RS256" },
    { ...ec.publicKey.export({ format: "jwk" }), kid: "e", alg: "ES256" },
  ];
  assert.equal(verifyJwt(make("RS256", rsa.privateKey, "r"), { keys, alg: "RS256", issuer }).ok, true);
  assert.equal(verifyJwt(make("ES256", ec.privateKey, "e"), { keys, alg: "ES256", issuer }).ok, true);
  assert.equal(verifyJwt(make("RS256", rsa.privateKey, "r"), { keys, alg: "ES256", issuer }).reason, "algorithm");
  assert.equal(verifyJwt(make("ES256", ec.privateKey, "e"), { keys, alg: "RS256", issuer }).reason, "algorithm");
  // An RS256 token pointing at the EC key (or the reverse) can't be verified.
  assert.equal(verifyJwt(make("RS256", rsa.privateKey, "e"), { keys, alg: "RS256", issuer }).ok, false);
  const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const weak = [{ ...small.publicKey.export({ format: "jwk" }), kid: "w" }];
  assert.equal(verifyJwt(make("RS256", small.privateKey, "w"), { keys: weak, alg: "RS256", issuer }).reason, "unusable key");
  const expired = verifyJwt(make("ES256", ec.privateKey, "e", { ...claims, exp: now - 1 }), { keys, alg: "ES256", issuer });
  assert.deepEqual([expired.ok, expired.expired], [false, true]);
  // Expiry is judged last: an expired token with a bad signature is not "expired".
  const t = make("ES256", ec.privateKey, "e", { ...claims, exp: now - 1 }).split(".");
  const forged = verifyJwt(`${t[0]}.${b64({ ...claims, exp: now - 1, sub: BEN })}.${t[2]}`, { keys, alg: "ES256", issuer });
  assert.deepEqual([forged.ok, forged.expired, forged.reason], [false, undefined, "signature"]);
});

// Configuration ---------------------------------------------------------------------

function start(env) {
  const base = {
    PATH: process.env.PATH,
    PORT: "1", // never reached: every case here must exit before listening
    DATABASE_URL: "postgres://nobody:secret-db-password@127.0.0.1:9/none",
    LOCAL_USER_ID: ANA,
    LOGIN_FILE: "/tmp/.login-refuse-test",
  };
  return spawnSync(process.execPath, ["dist/server.js"], { env: { ...base, ...env }, encoding: "utf8", timeout: 15_000 });
}
const supabaseEnv = {
  AUTH_MODE: "supabase",
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  JWT_ALG: "ES256",
  SESSION_SECRET: "s".repeat(40),
  PUBLIC_URL: "https://app.example.test",
};

test("config: AUTH_MODE=local refuses to start when VERCEL is set, explicit or by default", () => {
  for (const env of [{ AUTH_MODE: "local" }, {}]) {
    const r = start({ ...env, VERCEL: "1", DATABASE_CA_FILE: "supabase-ca.crt" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /AUTH_MODE is local .* VERCEL is set/);
  }
});

test("config: AUTH_MODE=supabase refuses to start without its settings, naming the variable and never a value", () => {
  const cases = [
    [{ SESSION_SECRET: "" }, /SESSION_SECRET/],
    [{ SESSION_SECRET: "short-secret-value" }, /SESSION_SECRET/],
    [{ JWT_ALG: "HS256" }, /JWT_ALG/],
    [{ JWT_ALG: "" }, /JWT_ALG/],
    [{ SUPABASE_URL: "" }, /SUPABASE_URL/],
    [{ SUPABASE_URL: "http://ref.supabase.co" }, /SUPABASE_URL must be https/],
    [{ SUPABASE_URL: "https://ref.supabase.co/auth/v1" }, /SUPABASE_URL/],
    [{ SUPABASE_PUBLISHABLE_KEY: "" }, /SUPABASE_PUBLISHABLE_KEY/],
    [{ AUTH_MODE: "none" }, /AUTH_MODE/],
    [{ VERCEL: "1", DATABASE_CA_FILE: "supabase-ca.crt", PUBLIC_URL: "http://app.example.test" }, /PUBLIC_URL must be https/],
    [{ VERCEL: "1", DATABASE_CA_FILE: "supabase-ca.crt", SUPABASE_URL: "http://127.0.0.1:9" }, /SUPABASE_URL must be https/],
  ];
  for (const [env, message] of cases) {
    const r = start({ ...supabaseEnv, ...env });
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.match(r.stderr, message, JSON.stringify(env));
    assert.doesNotMatch(r.stderr, /short-secret-value|secret-db-password|sb_publishable_x/);
  }
});

test("welcome: a brand-new account's sign-in leaves the fresh-sign-in cookie for the Welcome tour's first landing, for half an hour; an older account's leaves none", async () => {
  await fake("/_users", { method: "POST", body: JSON.stringify({ email: "new-wren@example.test" }) });
  const fresh = await signInByCode(A, "new-wren@example.test", "/");
  const c = fresh.done.headers.getSetCookie().find((x) => x.startsWith("__Host-rlq_fresh="));
  assert.ok(c, "a new account's sign-in sets the cookie");
  assert.match(c, /^__Host-rlq_fresh=1; HttpOnly; SameSite=Lax; Path=\/; Max-Age=1800; Secure$/);
  const old = await signInByCode(A, "ana@example.test", "/");
  assert.equal(old.done.headers.getSetCookie().some((x) => x.startsWith("__Host-rlq_fresh=")), false, "an existing account's sign-in sets none");
});
