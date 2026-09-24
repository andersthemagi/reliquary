// Who is signed in. Two modes, chosen by AUTH_MODE:
//
//  - local (default): the dev.sh stand-in. The server acts only as
//    LOCAL_USER_ID; a one-time login link in LOGIN_FILE opens an in-memory
//    session. Refuses to start on Vercel (VERCEL set).
//  - supabase: Supabase Auth email sign-in, handled here on the server (the
//    CSP forbids client script). The session is two cookies: the Supabase
//    access JWT (verified on every request against the project's JWKS, with
//    the algorithm pinned by JWT_ALG) and its refresh token. Nothing is kept
//    in server memory, so any instance accepts any other's cookies. CSRF is
//    HMAC(SESSION_SECRET, session_id). docs/research/hosting.md, section 3.
//
// Either way the database learns only { sub, role: "authenticated" } (see
// asPerson in db.ts): never an `act`, never any other claim from the JWT.
//
// Never log a JWT, refresh token, code, token hash or email. Log lines here
// name a fixed reason, nothing from the request.

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { writeFileSync } from "node:fs";
import type http from "node:http";

export type AuthMode = "local" | "supabase";
export type Alg = "ES256" | "RS256";

type Config = {
  mode: AuthMode;
  cookiePrefix: string; // "__Host-" under an https PUBLIC_URL
  cookieSecure: string; // "; Secure" or ""
  // local
  localUser: string;
  loginFile: string;
  loginBase: string;
  // supabase
  supabaseUrl: string;
  issuer: string;
  apiKey: string;
  alg: Alg;
  secret: Buffer;
};

let cfg: Config | undefined;
const conf = (): Config => {
  if (!cfg) throw new Error("auth not configured");
  return cfg;
};
export const authMode = (): AuthMode => conf().mode;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Reads and checks the configuration once, at start. Throws an Error whose
// message names the variable, never its value; the server prints it and exits.
export function configureAuth(
  env: NodeJS.ProcessEnv,
  site: { secure: boolean; host: string; port: number },
): AuthMode {
  const mode = env.AUTH_MODE ?? "local";
  const base = {
    cookiePrefix: site.secure ? "__Host-" : "",
    cookieSecure: site.secure ? "; Secure" : "",
    localUser: "",
    loginFile: "",
    loginBase: "",
    supabaseUrl: "",
    issuer: "",
    apiKey: "",
    alg: "ES256" as Alg,
    secret: Buffer.alloc(0),
  };
  if (mode === "local") {
    if (env.VERCEL) {
      throw new Error("Refusing to start: AUTH_MODE is local (the dev.sh stand-in) but VERCEL is set. Hosted, use AUTH_MODE=supabase");
    }
    const user = env.LOCAL_USER_ID ?? "";
    if (!/^[0-9a-f-]{36}$/.test(user)) throw new Error("LOCAL_USER_ID must be a UUID");
    cfg = { ...base, mode, localUser: user, loginFile: env.LOGIN_FILE ?? ".login", loginBase: `http://${site.host}:${site.port}` };
    return mode;
  }
  if (mode !== "supabase") throw new Error("AUTH_MODE must be local or supabase");

  let url: URL;
  try {
    url = new URL(env.SUPABASE_URL ?? "");
  } catch {
    throw new Error("SUPABASE_URL must be the project URL, https://<project-ref>.supabase.co");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && !env.VERCEL)) {
    throw new Error("SUPABASE_URL must be https");
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("SUPABASE_URL must be the bare project URL, with no path");
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new Error("SUPABASE_PUBLISHABLE_KEY must be set");
  const alg = env.JWT_ALG;
  if (alg !== "ES256" && alg !== "RS256") throw new Error("JWT_ALG must be ES256 or RS256, as the project's JWKS says");
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters (32 random bytes, base64url)");
  if (env.VERCEL && !site.secure) throw new Error("Refusing to start: on Vercel, PUBLIC_URL must be https");
  const supabaseUrl = url.origin;
  cfg = { ...base, mode, supabaseUrl, issuer: `${supabaseUrl}/auth/v1`, apiKey, alg, secret: Buffer.from(secret, "utf8") };
  return mode;
}

// ---------------------------------------------------------------------------
// Cookies

export function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export const cookieName = (name: string) => conf().cookiePrefix + name;

// Auth cookies: HttpOnly, Path=/, SameSite=Lax (the OAuth consent page is
// reached by a top-level redirect from another site; Strict would look
// signed out there), Secure and __Host- under https.
export function setCookie(name: string, value: string, maxAge: number): string {
  return `${cookieName(name)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${conf().cookieSecure}`;
}
export const clearCookie = (name: string) => setCookie(name, "", 0);

const AT = "rlq_at";
const RT = "rlq_rt";
const FLASH = "rlq_flash";
const REFRESH_DAYS = 30;
const SESSION_COOKIES = [AT, RT];

export const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const mac = (purpose: string, value: string) =>
  createHmac("sha256", conf().secret).update(`${purpose}\0${value}`).digest("hex");

// ---------------------------------------------------------------------------
// Sessions

export type Session = {
  userId: string;
  csrf: string;
  takeFlash(): string | undefined;
  setFlash(message: string): void;
  // Ends the session: Supabase logout (this session only) and cleared cookies.
  signOut(): Promise<void>;
};

// What a request carries. `cookies` are Set-Cookie values the response must
// send (a refreshed session, cleared cookies, a flash): send them even when
// there is no session. `unavailable`: Supabase couldn't be reached to check
// or refresh the session; answer 503 and keep the cookies.
export type Lookup = { session: Session | null; cookies: string[]; unavailable: boolean };

export async function getSession(req: http.IncomingMessage): Promise<Lookup> {
  return conf().mode === "local" ? localSession(req) : supabaseSession(req);
}

// Local stand-in --------------------------------------------------------------

type LocalSession = { userId: string; csrf: string; expires: number; flash?: string };
const localSessions = new Map<string, LocalSession>();
const LOCAL_SESSION_HOURS = 12;
let loginCode = "";

export function rotateLoginCode(): void {
  const c = conf();
  loginCode = randomBytes(24).toString("hex");
  writeFileSync(c.loginFile, `${c.loginBase}/login?code=${loginCode}\n`, { mode: 0o600 });
}

// GET /login?code=... (local mode only): a Set-Cookie for a fresh session, or
// undefined when the code is wrong or used.
export function localLogin(code: string): string | undefined {
  const c = conf();
  if (c.mode !== "local" || !loginCode || !sameSecret(code, loginCode)) return undefined;
  rotateLoginCode();
  const sid = randomBytes(32).toString("hex");
  localSessions.set(sid, {
    userId: c.localUser,
    csrf: randomBytes(24).toString("hex"),
    expires: Date.now() + LOCAL_SESSION_HOURS * 3600_000,
  });
  return `${cookieName("rlq_session")}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LOCAL_SESSION_HOURS * 3600}${c.cookieSecure}`;
}

function localSession(req: http.IncomingMessage): Lookup {
  const sid = readCookie(req, cookieName("rlq_session"));
  const s = sid ? localSessions.get(sid) : undefined;
  if (!s || s.expires < Date.now()) {
    if (sid) localSessions.delete(sid);
    return { session: null, cookies: [], unavailable: false };
  }
  return {
    session: {
      userId: s.userId,
      csrf: s.csrf,
      takeFlash: () => {
        const f = s.flash;
        s.flash = undefined;
        return f;
      },
      setFlash: (m) => {
        s.flash = m;
      },
      signOut: async () => {
        localSessions.delete(sid!);
      },
    },
    cookies: [],
    unavailable: false,
  };
}

// Supabase ------------------------------------------------------------------

class Unavailable extends Error {}

async function supabaseSession(req: http.IncomingMessage): Promise<Lookup> {
  const cookies: string[] = [];
  const none = (clear: boolean): Lookup => {
    if (clear) cookies.push(...SESSION_COOKIES.map(clearCookie));
    return { session: null, cookies, unavailable: false };
  };
  const at = readCookie(req, cookieName(AT));
  const rt = readCookie(req, cookieName(RT));
  try {
    let claims: Claims | undefined;
    let accessToken = at ?? "";
    if (at) {
      const r = await verifyAccessToken(at);
      if (r.ok) claims = r.claims;
      else if (!r.expired) {
        console.info(`auth: access token refused (${r.reason})`);
        return none(true);
      }
    }
    if (!claims) {
      if (!rt) return none(!!at);
      // Expired or missing access token: refresh once. Supabase rotates the
      // refresh token; reusing an old one outside its 10 s window revokes
      // the session, which lands here as a failure: signed out.
      const t = await tokenRequest("/token?grant_type=refresh_token", { refresh_token: rt });
      if (!t) {
        console.info("auth: refresh refused");
        return none(true);
      }
      const r = await verifyAccessToken(t.accessToken);
      if (!r.ok) {
        console.info(`auth: refreshed access token refused (${r.reason})`);
        return none(true);
      }
      claims = r.claims;
      accessToken = t.accessToken;
      cookies.push(...sessionCookies(t));
    }
    return { session: supabaseSessionFor(req, claims, accessToken, cookies), cookies, unavailable: false };
  } catch (err) {
    if (err instanceof Unavailable) {
      console.error("auth: Supabase Auth unreachable");
      return { session: null, cookies: [], unavailable: true };
    }
    throw err;
  }
}

function supabaseSessionFor(req: http.IncomingMessage, claims: Claims, accessToken: string, cookies: string[]): Session {
  return {
    userId: claims.sub,
    csrf: mac("csrf", claims.session_id),
    takeFlash: () => {
      const raw = readCookie(req, cookieName(FLASH));
      if (raw === undefined) return undefined;
      cookies.push(clearCookie(FLASH));
      const [body = "", sig = ""] = raw.split(".");
      if (!sameSecret(sig, mac("flash", body))) return undefined;
      return Buffer.from(body, "base64url").toString("utf8");
    },
    setFlash: (m) => {
      const body = Buffer.from(m, "utf8").toString("base64url");
      cookies.push(setCookie(FLASH, `${body}.${mac("flash", body)}`, 300));
    },
    signOut: async () => {
      // Best effort: the JWT stays valid until it expires (at most an hour)
      // even if this call fails, but our cookies go either way.
      await gotrue("/logout?scope=local", {}, { authorization: `Bearer ${accessToken}` }).catch(() => undefined);
      cookies.push(...SESSION_COOKIES.map(clearCookie));
    },
  };
}

export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number };

export function sessionCookies(t: Tokens): string[] {
  return [setCookie(AT, t.accessToken, t.expiresIn), setCookie(RT, t.refreshToken, REFRESH_DAYS * 86400)];
}

// ---------------------------------------------------------------------------
// Supabase Auth REST (server to server, with the publishable key)

const TIMEOUT_MS = 8000;

async function gotrue(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const c = conf();
  let res: Response;
  try {
    res = await fetch(`${c.issuer}${path}`, {
      method: "POST",
      headers: { apikey: c.apiKey, "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Unavailable();
  }
  if (res.status >= 500) throw new Unavailable();
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const REFRESH_TOKEN = /^[\x21-\x7e]{1,512}$/;

// A session from Supabase, or undefined if it refused (4xx). Throws
// Unavailable on network failure or 5xx.
async function tokenRequest(path: string, body: unknown): Promise<Tokens | undefined> {
  const { status, json } = await gotrue(path, body);
  if (status !== 200) return undefined;
  const accessToken = typeof json?.access_token === "string" ? json.access_token : "";
  const refreshToken = typeof json?.refresh_token === "string" ? json.refresh_token : "";
  // Both go into cookies: only cookie-safe characters.
  if (!/^[A-Za-z0-9_.-]{1,8192}$/.test(accessToken) || !REFRESH_TOKEN.test(refreshToken) || /[;,\s"\\]/.test(refreshToken)) {
    return undefined;
  }
  const e = Number(json?.expires_in);
  const expiresIn = Number.isInteger(e) && e >= 60 && e <= 86400 ? e : 3600;
  return { accessToken, refreshToken, expiresIn };
}

export type SigninResult = { ok: true; cookies: string[] } | { ok: false; unavailable: boolean };

// Step 1: ask Supabase to email a code and link. Never tells the caller
// whether the address has an account: any 4xx (no such user, signups off,
// rate limited) is the same as success. Only an outage is reported.
//
// createUser: only for the address a live invite was sent to (signin.ts
// checks that with the database first). Supabase then makes the account if
// there is none, provided the project allows sign-ups; if it doesn't,
// `signupsOff` says so, so the invitee gets a clear answer. That tells the
// holder of the invite link whether its address has an account, and nobody
// else anything.
export async function sendSigninEmail(email: string, createUser = false): Promise<{ unavailable: boolean; signupsOff?: boolean }> {
  try {
    const r = await gotrue("/otp", { email, create_user: createUser });
    if (createUser && r.status === 422) {
      const code = String(r.json?.error_code ?? "");
      const msg = String(r.json?.msg ?? r.json?.message ?? "");
      if (code === "otp_disabled" || code === "signup_disabled" || /signups? not allowed/i.test(msg)) {
        return { unavailable: false, signupsOff: true };
      }
    }
    return { unavailable: false };
  } catch (err) {
    if (err instanceof Unavailable) return { unavailable: true };
    throw err;
  }
}

// Step 3: a 6-digit code (with its email) or a link's token hash. On success,
// the session cookies to set.
export async function verifySignin(p: { email: string; code: string } | { tokenHash: string }): Promise<SigninResult> {
  const body = "tokenHash" in p ? { type: "email", token_hash: p.tokenHash } : { type: "email", email: p.email, token: p.code };
  try {
    const t = await tokenRequest("/verify", body);
    if (!t) return { ok: false, unavailable: false };
    const r = await verifyAccessToken(t.accessToken);
    if (!r.ok) {
      console.info(`auth: new access token refused (${r.reason})`);
      return { ok: false, unavailable: false };
    }
    return { ok: true, cookies: sessionCookies(t) };
  } catch (err) {
    if (err instanceof Unavailable) return { ok: false, unavailable: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JWT verification. No library: one pinned algorithm, keys only from the
// project's JWKS, every claim checked. Exported for unit tests.

export type Jwk = { kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string; kid?: string; alg?: string; use?: string };
export type Claims = { sub: string; role: "authenticated"; session_id: string; exp: number; [k: string]: unknown };
export type Verified =
  | { ok: true; claims: Claims }
  | { ok: false; reason: string; expired?: boolean; unknownKey?: boolean };

const B64URL = /^[A-Za-z0-9_-]+$/;
const LEEWAY_S = 60;

function part(s: string): any {
  if (!B64URL.test(s)) throw new Error();
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

// Parsed keys, per JWK object and algorithm: building a KeyObject on every
// request is the costliest step of a verification. A refetched JWKS is new
// objects, so a rotated key is never served from here.
const importedKeys = new WeakMap<Jwk, { alg: Alg; key: ReturnType<typeof parseKey> }>();
function importKey(jwk: Jwk, alg: Alg) {
  const hit = importedKeys.get(jwk);
  if (hit && hit.alg === alg) return hit.key;
  const key = parseKey(jwk, alg);
  importedKeys.set(jwk, { alg, key });
  return key;
}

function parseKey(jwk: Jwk, alg: Alg) {
  if (jwk.alg !== undefined && jwk.alg !== alg) return undefined;
  if (jwk.use !== undefined && jwk.use !== "sig") return undefined;
  try {
    if (alg === "ES256") {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256") return undefined;
      return createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    }
    if (jwk.kty !== "RSA") return undefined;
    const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    return (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function verifyJwt(
  token: string,
  o: { keys: Jwk[]; alg: Alg; issuer: string; audience?: string; now?: number },
): Verified {
  const fail = (reason: string, extra: { expired?: boolean; unknownKey?: boolean } = {}): Verified => ({ ok: false, reason, ...extra });
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  let header: any;
  let payload: any;
  try {
    header = part(parts[0]);
    payload = part(parts[1]);
  } catch {
    return fail("malformed");
  }
  if (typeof header !== "object" || header === null || typeof payload !== "object" || payload === null) return fail("malformed");
  // The algorithm is ours, not the token's: `none`, HS256 and anything else
  // are refused before a key is even looked up.
  if (header.alg !== o.alg) return fail("algorithm");
  if (header.crit !== undefined) return fail("crit header");
  if (typeof header.kid !== "string") return fail("no key id");
  const jwk = o.keys.find((k) => k.kid === header.kid);
  if (!jwk) return fail("unknown key", { unknownKey: true });
  const key = importKey(jwk, o.alg);
  if (!key) return fail("unusable key");
  if (!B64URL.test(parts[2])) return fail("malformed");
  const sig = Buffer.from(parts[2], "base64url");
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const good =
    o.alg === "ES256"
      ? sig.length === 64 && verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)
      : verifySignature("sha256", data, key, sig);
  if (!good) return fail("signature");

  const now = o.now ?? Math.floor(Date.now() / 1000);
  const audience = o.audience ?? "authenticated";
  if (payload.iss !== o.issuer) return fail("issuer");
  const aud = payload.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === audience))) return fail("audience");
  if (payload.role !== "authenticated") return fail("role");
  // Tokens from Supabase's OAuth server carry client_id: they belong to a
  // third-party app, not to a person at this site (hosting.md, section 4).
  if ("client_id" in payload) return fail("client_id");
  if (payload.is_anonymous === true) return fail("anonymous");
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) return fail("subject");
  if (typeof payload.session_id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(payload.session_id)) return fail("session");
  if (typeof payload.exp !== "number") return fail("no expiry");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + LEEWAY_S)) return fail("not yet valid");
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > now + LEEWAY_S)) return fail("issued in the future");
  if (payload.exp <= now) return fail("expired", { expired: true });
  return { ok: true, claims: payload as Claims };
}

// JWKS: cached for 10 minutes; an unknown key id refetches, at most every 30 s
// (key rotation), so a stream of forged key ids can't hammer Supabase.
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 30_000;
let jwks: { keys: Jwk[]; at: number } | undefined;

// One fetch at a time: requests that find the cache stale together share it.
let jwksInFlight: Promise<Jwk[]> | undefined;
function fetchJwks(): Promise<Jwk[]> {
  jwksInFlight ??= fetchJwksOnce().finally(() => {
    jwksInFlight = undefined;
  });
  return jwksInFlight;
}

async function fetchJwksOnce(): Promise<Jwk[]> {
  const c = conf();
  let res: Response;
  try {
    res = await fetch(`${c.issuer}/.well-known/jwks.json`, {
      headers: { apikey: c.apiKey, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Unavailable();
  }
  if (res.status !== 200) throw new Unavailable();
  const body = (await res.json().catch(() => undefined)) as { keys?: unknown } | undefined;
  if (!body || !Array.isArray(body.keys)) throw new Unavailable();
  const keys = body.keys.filter((k): k is Jwk => typeof k === "object" && k !== null);
  jwks = { keys, at: Date.now() };
  return keys;
}

async function verifyAccessToken(token: string): Promise<Verified> {
  const c = conf();
  const opts = { alg: c.alg, issuer: c.issuer };
  if (!jwks || Date.now() - jwks.at > JWKS_TTL_MS) await fetchJwks();
  let r = verifyJwt(token, { ...opts, keys: jwks!.keys });
  if (!r.ok && r.unknownKey && Date.now() - jwks!.at > JWKS_MIN_REFETCH_MS) {
    r = verifyJwt(token, { ...opts, keys: await fetchJwks() });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Before sign-in there is no session to bind a CSRF token to, so the sign-in
// forms use a double-submit token: a random value in an HttpOnly cookie that
// the form must echo. With the Origin check, a cross-site page can neither
// post the forms nor sign someone into another account.

const PRE = "rlq_pre";
export function preToken(req: http.IncomingMessage): { token: string; cookie?: string } {
  const have = readCookie(req, cookieName(PRE));
  if (have && /^[0-9a-f]{48}$/.test(have)) return { token: have };
  const token = randomBytes(24).toString("hex");
  return { token, cookie: setCookie(PRE, token, 3600) };
}
export function preTokenOk(req: http.IncomingMessage, form: URLSearchParams): boolean {
  const have = readCookie(req, cookieName(PRE)) ?? "";
  return /^[0-9a-f]{48}$/.test(have) && sameSecret(form.get("csrf") ?? "", have);
}
export const clearPreToken = () => clearCookie(PRE);
