// A fake Supabase Auth (GoTrue) for the web tests: just the REST calls the
// web server makes (docs/research/hosting.md, section 7). Not a test file;
// web/test.sh runs it next to the servers.
//
//   POST /auth/v1/otp                            records a code and a token hash
//   POST /auth/v1/verify                         { type: "email", email, token } or { type: "email", token_hash }
//   POST /auth/v1/token?grant_type=refresh_token rotates; reusing a used refresh token revokes the session
//   POST /auth/v1/logout                         revokes the bearer's session
//   GET  /auth/v1/.well-known/jwks.json          the public key (ES256, generated at start)
//
// Test-only (never in Supabase):
//   GET  /_last_email?email=...   the code and token hash last "emailed" to that address
//   POST /_mint                   a JWT signed with the real key, claims and header overridden
//   GET  /_stats                  call counts and the last /otp body's create_user
//   GET  /_jwks                   the JWKS without the apikey
//
// Env: FAKE_AUTH_PORT, FAKE_AUTH_URL (its own base URL: the issuer is
// FAKE_AUTH_URL/auth/v1), FAKE_AUTH_APIKEY (required as `apikey` on every
// /auth/v1 call), FAKE_AUTH_USERS ("email=uuid,email=uuid").
// Synthetic data only. Logs nothing.

import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
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
const lastEmail = new Map();
const refreshTokens = new Map(); // token -> { sessionId, sub, email, used }
const revoked = new Set(); // session ids
const stats = { otp: 0, verify: 0, refresh: 0, logout: 0, jwks: 0, lastCreateUser: undefined };
const TTL = 3600;

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
  return { access_token: accessToken(sub, email, sessionId), token_type: "bearer", expires_in: TTL, expires_at: Math.floor(Date.now() / 1000) + TTL, refresh_token: refresh, user: { id: sub, email } };
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
    if (req.method !== "POST") return json(res, 405, { msg: "method" });
    const body = await readJson(req);

    if (p === "/auth/v1/otp") {
      stats.otp++;
      stats.lastCreateUser = body.create_user;
      const email = String(body.email ?? "").toLowerCase();
      if (body.create_user !== false || !USERS.has(email)) {
        // What Supabase says with signups off: the web server must not let
        // this difference show.
        return json(res, 422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
      }
      const code = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
      const hash = randomBytes(28).toString("hex");
      pending.push({ email, code, hash, used: false });
      lastEmail.set(email, { code, token_hash: hash });
      return json(res, 200, {});
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
      try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        revoked.add(claims.session_id);
      } catch {
        return json(res, 401, { msg: "bad token" });
      }
      return json(res, 204);
    }
    return json(res, 404, { msg: "not found" });
  })
  .listen(PORT, "127.0.0.1");
