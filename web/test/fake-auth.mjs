// A fake Supabase Auth (GoTrue) for the web tests: just the REST calls the
// web server makes (docs/research/hosting.md, section 7). Not a test file;
// web/test.sh runs it next to the servers.
//
//   POST /auth/v1/otp                            records a code and a token hash
//   POST /auth/v1/verify                         { type: "email", email, token } or { type: "email", token_hash },
//                                                or { type: "email_change", token_hash }
//   POST /auth/v1/token?grant_type=refresh_token rotates; reusing a used refresh token revokes the session
//   GET  /auth/v1/user                           the bearer's account, with new_email and
//                                                email_change_sent_at while a change waits
//   PUT  /auth/v1/user                           { email }: asks to change the address; the token
//                                                hashes go to /_last_email of the new address and,
//                                                with secure email change on (the default), the
//                                                current one; another account's address is refused
//                                                (422 email_exists)
//   POST /auth/v1/logout                         revokes the bearer's session; ?scope=global every
//                                                session of the bearer's account
//   GET  /auth/v1/.well-known/jwks.json          the public key (ES256, generated at start)
//
// Test-only (never in Supabase):
//   GET  /_last_email?email=...   the code and token hash last "emailed" to that address
//   POST /_mint                   a JWT signed with the real key, claims and header overridden
//   GET  /_stats                  call counts and the last /otp body's create_user
//   GET  /_jwks                   the JWKS without the apikey
//   POST /_signups                { on: true|false }: whether /otp with create_user: true
//                                 makes an account for an unknown address (off at start,
//                                 as in the hosted project)
//   POST /_otp_race               { on }: a double-tapped sign-up: /otp with create_user: true
//                                 makes the account and emails the code, then answers 500
//                                 (the losing request); a repeat with create_user: false
//                                 within the throttle answers 429 and sends nothing
//   POST /_fail_otp                { status }: answer every /otp with that status, no account
//                                 made and no email sent (0: as normal). For when Auth is down
//                                 outright, including for sendSigninEmail's own retry.
//   GET  /_user?email=...         { id } of that account, or null
//   POST /_users                  { email }: makes that account if it has none; { id }
//   POST /_fail_global_logout     { status }: answer global logouts with that status
//                                 (0: as normal)
//   POST /_secure_email_change    { on }: whether PUT /user emails both addresses (on at start)
//   POST /_fail_user_update       { status, body }: answer PUT /user with that (0: as normal)
//   POST /_email_change           { email, new_email, both }: as if that account asked to
//                                 change its address; the token hashes "emailed" to the
//                                 new address and, with both (secure email change), the
//                                 current one (an unknown address gets an account first).
//                                 Verifying one of two answers a message only.
//
// /otp with create_user: true (sent only for an invited address) signs in an
// existing account, or with sign-ups on makes one; otherwise it refuses as
// Supabase does with sign-ups off.
//
// Env: FAKE_AUTH_PORT, FAKE_AUTH_URL (its own base URL: the issuer is
// FAKE_AUTH_URL/auth/v1), FAKE_AUTH_APIKEY (required as `apikey` on every
// /auth/v1 call), FAKE_AUTH_USERS ("email=uuid,email=uuid").
// Synthetic data only. Logs nothing.

import { generateKeyPairSync, randomBytes, randomInt, randomUUID, sign } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.FAKE_AUTH_PORT ?? 9999);
const BASE = process.env.FAKE_AUTH_URL ?? `http://127.0.0.1:${PORT}`;
const ISSUER = `${BASE}/auth/v1`;
const APIKEY = process.env.FAKE_AUTH_APIKEY ?? "sb_publishable_fake";
const USERS = new Map(
  (process.env.FAKE_AUTH_USERS ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = randomBytes(8).toString("hex");
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function signJwt(header, claims) {
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

const pending = []; // { email, code, hash, used }
const changes = []; // { pair, email, newEmail, hash, used }
const lastEmail = new Map();
const refreshTokens = new Map(); // token -> { sessionId, sub, email, used }
const revoked = new Set(); // session ids
const stats = { otp: 0, verify: 0, refresh: 0, logout: 0, logoutGlobal: 0, userUpdate: 0, jwks: 0, lastCreateUser: undefined };
const pendingChanges = new Map(); // account id -> { newEmail, sentAt }, from PUT /user
const secureEmailChange = { on: true }; // /_secure_email_change: both addresses confirm (Supabase's default)
const failUserUpdate = { status: 0, body: {} }; // /_fail_user_update: answer PUT /user with this instead
const failGlobal = { status: 0 }; // /_fail_global_logout: answer global logouts with this status instead
const TTL = 3600;
const signups = { on: false };
const otpRace = { on: false }; // /_otp_race
const failOtp = { status: 0 }; // /_fail_otp: answer every /otp with this status instead

function accessToken(sub, email, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: "ES256", typ: "JWT", kid: KID },
    { iss: ISSUER, aud: "authenticated", sub, email, role: "authenticated", aal: "aal1", session_id: sessionId, is_anonymous: false, iat: now, exp: now + TTL },
  );
}
function session(sub, email, sessionId = randomUUID()) {
  const refresh = `rt${randomBytes(9).toString("hex")}`;
  refreshTokens.set(refresh, { sessionId, sub, email, used: false });
  return { access_token: accessToken(sub, email, sessionId), token_type: "bearer", expires_in: TTL, expires_at: Math.floor(Date.now() / 1000) + TTL, refresh_token: refresh, user: { id: sub, email, ...(email.startsWith("new-") ? { created_at: new Date().toISOString() } : {}) } };
}

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
const readJson = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const p = url.pathname;

    if (p === "/_last_email") return json(res, 200, lastEmail.get(url.searchParams.get("email")) ?? null);
    if (p === "/_stats") return json(res, 200, stats);
    if (p === "/_jwks") return json(res, 200, { keys: [JWK] });
    if (p === "/_signups" && req.method === "POST") {
      signups.on = (await readJson(req)).on === true;
      return json(res, 200, signups);
    }
    if (p === "/_otp_race" && req.method === "POST") {
      otpRace.on = (await readJson(req)).on === true;
      return json(res, 200, otpRace);
    }
    if (p === "/_fail_otp" && req.method === "POST") {
      failOtp.status = Number((await readJson(req)).status) || 0;
      return json(res, 200, failOtp);
    }
    if (p === "/_user") {
      const id = USERS.get(String(url.searchParams.get("email") ?? "").toLowerCase());
      return json(res, 200, id ? { id } : null);
    }
    if (p === "/_users" && req.method === "POST") {
      const email = String((await readJson(req)).email ?? "").toLowerCase();
      if (!USERS.has(email)) USERS.set(email, randomUUID());
      return json(res, 200, { id: USERS.get(email) });
    }
    if (p === "/_secure_email_change" && req.method === "POST") {
      secureEmailChange.on = (await readJson(req)).on !== false;
      return json(res, 200, secureEmailChange);
    }
    if (p === "/_fail_user_update" && req.method === "POST") {
      const b = await readJson(req);
      failUserUpdate.status = Number(b.status) || 0;
      failUserUpdate.body = b.body ?? {};
      return json(res, 200, { status: failUserUpdate.status });
    }
    if (p === "/_fail_global_logout" && req.method === "POST") {
      failGlobal.status = Number((await readJson(req)).status) || 0;
      return json(res, 200, failGlobal);
    }
    if (p === "/_email_change" && req.method === "POST") {
      const { email, new_email, both } = await readJson(req);
      if (!USERS.has(email)) USERS.set(email, randomUUID()); // a fresh account, so tests don't touch others
      const pair = randomUUID();
      const out = { token_hash_new: randomBytes(28).toString("hex") };
      changes.push({ pair, email, newEmail: new_email, hash: out.token_hash_new, used: false });
      if (both) {
        out.token_hash_current = randomBytes(28).toString("hex");
        changes.push({ pair, email, newEmail: new_email, hash: out.token_hash_current, used: false });
      }
      return json(res, 200, out);
    }
    if (p === "/_mint" && req.method === "POST") {
      const { header = {}, claims = {}, sub, session_id } = await readJson(req);
      const now = Math.floor(Date.now() / 1000);
      const base = { iss: ISSUER, aud: "authenticated", sub, email: "x@example.test", role: "authenticated", aal: "aal1", session_id, is_anonymous: false, iat: now - 10, exp: now + TTL };
      return json(res, 200, { token: signJwt({ alg: "ES256", typ: "JWT", kid: KID, ...header }, { ...base, ...claims }) });
    }

    if (!p.startsWith("/auth/v1/")) return json(res, 404, { msg: "not found" });
    if (req.headers.apikey !== APIKEY) return json(res, 401, { msg: "no apikey" });

    if (p === "/auth/v1/.well-known/jwks.json" && req.method === "GET") {
      stats.jwks++;
      return json(res, 200, { keys: [JWK] });
    }
    if (p === "/auth/v1/user" && (req.method === "GET" || req.method === "PUT")) {
      // The bearer's account; a revoked session, or no account, is refused as Auth does.
      let claims;
      try {
        claims = JSON.parse(Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, "").split(".")[1], "base64url").toString("utf8"));
      } catch {
        return json(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      const email = [...USERS].find(([, id]) => id === claims.sub)?.[0];
      if (!email || revoked.has(claims.session_id)) return json(res, 403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" });
      const user = () => {
        const w = pendingChanges.get(claims.sub);
        return { id: claims.sub, email, ...(w ? { new_email: w.newEmail, email_change_sent_at: w.sentAt } : {}) };
      };
      if (req.method === "GET") return json(res, 200, user());
      stats.userUpdate++;
      if (failUserUpdate.status) return json(res, failUserUpdate.status, failUserUpdate.body);
      const newEmail = String((await readJson(req)).email ?? "").toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return json(res, 400, { code: 400, error_code: "validation_failed", msg: "Unable to validate email address: invalid format" });
      if (USERS.has(newEmail) && USERS.get(newEmail) !== claims.sub) {
        return json(res, 422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      }
      // Asking again replaces the links waiting, as Auth does.
      for (const c of changes) if (c.email === email && !c.used) c.used = true;
      const pair = randomUUID();
      const hashNew = randomBytes(28).toString("hex");
      changes.push({ pair, email, newEmail, hash: hashNew, used: false });
      lastEmail.set(newEmail, { token_hash: hashNew, type: "email_change" });
      if (secureEmailChange.on) {
        const hashCurrent = randomBytes(28).toString("hex");
        changes.push({ pair, email, newEmail, hash: hashCurrent, used: false });
        lastEmail.set(email, { token_hash: hashCurrent, type: "email_change" });
      }
      pendingChanges.set(claims.sub, { newEmail, sentAt: new Date().toISOString() });
      return json(res, 200, user());
    }

    if (req.method !== "POST") return json(res, 405, { msg: "method" });
    const body = await readJson(req);

    if (p === "/auth/v1/otp") {
      stats.otp++;
      stats.lastCreateUser = body.create_user;
      if (failOtp.status) return json(res, failOtp.status, { code: failOtp.status, error_code: "unexpected_failure", msg: "fake outage" });
      const email = String(body.email ?? "").toLowerCase();
      if (otpRace.on && body.create_user === false && lastEmail.has(email)) {
        return json(res, 429, { code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 60 seconds." });
      }
      if (body.create_user === true && (USERS.has(email) || signups.on)) {
        if (!USERS.has(email)) USERS.set(email, randomUUID());
        const code = String(randomInt(100000, 1000000));
        const hash = randomBytes(28).toString("hex");
        pending.push({ email, code, hash, used: false });
        lastEmail.set(email, { code, token_hash: hash });
        if (otpRace.on) return json(res, 500, { code: 500, error_code: "unexpected_failure", msg: "Database error saving new user" });
        return json(res, 200, {});
      }
      if (body.create_user !== false || !USERS.has(email)) {
        // What Supabase says with signups off: the web server must not let
        // this difference show.
        return json(res, 422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
      }
      const code = String(randomInt(100000, 1000000));
      const hash = randomBytes(28).toString("hex");
      pending.push({ email, code, hash, used: false });
      lastEmail.set(email, { code, token_hash: hash });
      return json(res, 200, {});
    }

    if (p === "/auth/v1/verify" && body.type === "email_change") {
      stats.verify++;
      const hit = changes.find((c) => !c.used && c.hash === body.token_hash);
      if (!hit) return json(res, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      hit.used = true;
      if (changes.some((c) => c.pair === hit.pair && !c.used)) {
        return json(res, 200, { msg: "Confirmation link accepted. Please proceed to confirm link sent to the other email", code: 200 });
      }
      const id = USERS.get(hit.email);
      USERS.delete(hit.email);
      USERS.set(hit.newEmail, id);
      pendingChanges.delete(id);
      return json(res, 200, session(id, hit.newEmail));
    }
    if (p === "/auth/v1/verify") {
      stats.verify++;
      const hit = pending.find((o) =>
        !o.used && body.type === "email" &&
        (body.token_hash ? o.hash === body.token_hash : o.email === String(body.email ?? "").toLowerCase() && o.code === body.token),
      );
      if (!hit) return json(res, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      hit.used = true;
      return json(res, 200, session(USERS.get(hit.email), hit.email));
    }

    if (p === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      stats.refresh++;
      const rt = refreshTokens.get(body.refresh_token);
      if (!rt || revoked.has(rt.sessionId)) return json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      if (rt.used) {
        revoked.add(rt.sessionId);
        return json(res, 400, { code: 400, error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
      }
      rt.used = true;
      return json(res, 200, session(rt.sub, rt.email, rt.sessionId));
    }

    if (p === "/auth/v1/logout") {
      stats.logout++;
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      let claims;
      try {
        claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      } catch {
        return json(res, 401, { msg: "bad token" });
      }
      if (url.searchParams.get("scope") === "global") {
        stats.logoutGlobal++;
        if (failGlobal.status) return json(res, failGlobal.status, { msg: "fake refusal" });
        // Every session of the account: all its refresh tokens stop working.
        for (const rt of refreshTokens.values()) if (rt.sub === claims.sub) revoked.add(rt.sessionId);
      }
      revoked.add(claims.session_id);
      return json(res, 204);
    }
    return json(res, 404, { msg: "not found" });
  })
  .listen(PORT, "127.0.0.1");
