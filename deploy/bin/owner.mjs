// Makes a person's account on a self-hosted Reliquary, through Supabase
// Auth's admin API: `node owner.mjs <email>`. deploy/setup.sh runs it once
// for the first owner (in the web image, on the compose network); run it
// again for anyone else who should have an account without an invite.
//
// The account is confirmed and has no password: the person signs in with the
// emailed code or link, like everyone else. Every account is on the
// self_hosted plan, with no limits (deploy/sql/10_self_hosted.sql).
//
// Environment: AUTH_URL (the Auth server, e.g. http://auth:9999) and
// GOTRUE_JWT_KEYS (the JSON array of private JWKs deploy/setup.sh made).
// A service_role token is signed here with the current key, lives 2 minutes,
// is sent to AUTH_URL only, and is never printed. Prints the outcome and the
// address, nothing else.

import { createPrivateKey, randomUUID, sign } from "node:crypto";

const email = (process.argv[2] ?? "").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error("usage: owner.mjs <email>  (an email address, like name@example.com)");
  process.exit(2);
}
const authUrl = (process.env.AUTH_URL ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(authUrl)) {
  console.error("AUTH_URL must be the Auth server's URL, like http://auth:9999");
  process.exit(2);
}
let key;
try {
  const keys = JSON.parse(process.env.GOTRUE_JWT_KEYS ?? "");
  key = keys.find((k) => Array.isArray(k.key_ops) && k.key_ops.includes("sign"));
  if (!key || key.alg !== "ES256" || typeof key.kid !== "string") throw new Error();
} catch {
  console.error("GOTRUE_JWT_KEYS must hold the ES256 signing key deploy/setup.sh made");
  process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: "ES256", typ: "JWT", kid: key.kid });
const body = b64({ role: "service_role", iss: authUrl, iat: now, exp: now + 120, jti: randomUUID() });
const privateKey = createPrivateKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d }, format: "jwk" });
const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
const token = `${head}.${body}.${sig}`;

let res;
try {
  res = await fetch(`${authUrl}/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, email_confirm: true, role: "authenticated" }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
} catch (err) {
  console.error(`Couldn't reach Supabase Auth at ${authUrl}: ${err?.cause?.code ?? err?.name ?? "no answer"}. Is the auth service running?`);
  process.exit(1);
}
const json = await res.json().catch(() => ({}));
if (res.ok) {
  console.log(`Made an account for ${email}. Sign in with that address to start.`);
} else if (res.status === 422 && /already|exists/i.test(`${json.error_code ?? ""} ${json.msg ?? json.message ?? ""}`)) {
  console.log(`${email} already has an account. Sign in with that address.`);
} else {
  console.error(`Supabase Auth refused to make the account (HTTP ${res.status}${json.error_code ? `, ${json.error_code}` : ""}).`);
  process.exit(1);
}
