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
// Either way the database learns only { sub, role: "authenticated" } and,
// with Supabase, the JWT's `iat` (see asPerson in db.ts; the database uses
// it to end sessions its person signed out everywhere): never an `act`,
// never any other claim from the JWT.
//
// Never log a JWT, refresh token, code, token hash or email. Log lines here
// name a fixed reason, nothing from the request.

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { writeFileSync } from "node:fs";
import type http from "node:http";
import { limit } from "./ratelimit.js";
import { networkReason, noteUpstream } from "./failure.js";
import { decodeFlash, encodeFlash, type Flash } from "./flash.js";

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
    if (env.SELF_HOSTED === "1") {
      throw new Error("Refusing to start: AUTH_MODE is local (the dev.sh stand-in) but SELF_HOSTED is set. Self-hosted, use AUTH_MODE=supabase with AUTH_URL");
    }
    const user = env.LOCAL_USER_ID ?? "";
    if (!/^[0-9a-f-]{36}$/.test(user)) throw new Error("LOCAL_USER_ID must be a UUID");
    cfg = { ...base, mode, localUser: user, loginFile: env.LOGIN_FILE ?? ".login", loginBase: `http://${site.host}:${site.port}` };
    return mode;
  }
  if (mode !== "supabase") throw new Error("AUTH_MODE must be local or supabase");
  if (env.AUTH_URL !== undefined) return configureAuthUrl(env, site, base);

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

// Self-hosted Supabase Auth (deploy/compose): AUTH_URL is the Auth server's
// own base URL (the standalone supabase/auth image serves /otp, /verify,
// /token, /logout and /.well-known/jwks.json at its root, not under
// /auth/v1), and it is also the `iss` its tokens carry (GOTRUE_JWT_ISSUER is
// set to the same string). It may be plain http only on loopback or, with
// SELF_HOSTED=1, on the private network the containers share: Auth is never
// published there, and only this app talks to it. SUPABASE_PUBLISHABLE_KEY is
// optional (standalone Auth ignores `apikey`). Everything else is as with
// SUPABASE_URL: a pinned asymmetric JWT_ALG, keys only from the JWKS.
function configureAuthUrl(
  env: NodeJS.ProcessEnv,
  site: { secure: boolean },
  base: Omit<Config, "mode">,
): AuthMode {
  if (env.SUPABASE_URL) throw new Error("Set SUPABASE_URL (Supabase's hosted Auth) or AUTH_URL (a self-hosted Auth server), not both");
  let url: URL;
  try {
    url = new URL(env.AUTH_URL ?? "");
  } catch {
    throw new Error("AUTH_URL must be the Auth server's URL, like http://auth:9999");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const plainOk = !env.VERCEL && (loopback || env.SELF_HOSTED === "1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainOk)) {
    throw new Error("AUTH_URL must be https (plain http only on loopback, or on a private network with SELF_HOSTED=1)");
  }
  if (url.search || url.hash || url.username || url.password) throw new Error("AUTH_URL must have no query, fragment or credentials");
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY || "self-hosted";
  if (/[^\x21-\x7e]/.test(apiKey)) throw new Error("SUPABASE_PUBLISHABLE_KEY must be printable ASCII");
  const alg = env.JWT_ALG;
  if (alg !== "ES256" && alg !== "RS256") throw new Error("JWT_ALG must be ES256 or RS256, as the Auth server's JWKS says");
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters (32 random bytes, base64url)");
  if (env.VERCEL && !site.secure) throw new Error("Refusing to start: on Vercel, PUBLIC_URL must be https");
  const issuer = url.href.replace(/\/+$/, "");
  cfg = { ...base, mode: "supabase", supabaseUrl: url.origin, issuer, apiKey, alg, secret: Buffer.from(secret, "utf8") };
  return "supabase";
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
  // When the session's access JWT was issued (its `iat`, seconds), passed to
  // the database so it can refuse a session its person signed out
  // everywhere after (db.ts, private.check_session). None for the local
  // stand-in, which ends its sessions in memory.
  issuedAt?: number;
  takeFlash(): Flash | undefined;
  setFlash(flash: Flash): void;
  // Ends the session: Supabase logout (this session only) and cleared cookies.
  signOut(): Promise<void>;
  // Ends every session of the account at Supabase (logout with
  // scope=global: every refresh token revoked) and clears this browser's
  // cookies. "unavailable": Supabase couldn't be reached; "refused": it
  // answered with a refusal. Either way nothing was ended and the cookies
  // stay. The database's side (private.session_cutoffs) is the caller's.
  signOutEverywhere(): Promise<"ok" | "unavailable" | "refused">;
  // The account's change of address waiting for confirmation, as Supabase
  // Auth has it (GET /user): the new address and when its link was sent,
  // or null when none waits. "unavailable": Auth couldn't be asked. The
  // local stand-in has none.
  pendingEmail(): Promise<{ email: string; sentAt: Date | null } | null | "unavailable">;
  // Asks Supabase Auth to change the account's address (PUT /user). Auth
  // emails a link to the new address (and, with its secure email change,
  // one to the current address too); nothing changes until it is opened.
  // "taken": another account has that address; "invalid": Auth won't take
  // it as an address; "limited": Auth's email rate limit.
  changeEmail(email: string): Promise<"sent" | "taken" | "invalid" | "limited" | "refused" | "unavailable">;
};

// A signed notice for the next page, set where there is no session to
// carry it yet (a sign-in link that just made one). Supabase mode only.
export function flashCookie(f: Flash): string {
  const body = encodeFlash(f);
  return setCookie(FLASH, `${body}.${mac("flash", body)}`, 300);
}

// What a request carries. `cookies` are Set-Cookie values the response must
// send (a refreshed session, cleared cookies, a flash): send them even when
// there is no session. `unavailable`: Supabase couldn't be reached to check
// or refresh the session; answer 503 and keep the cookies. `limited`: the
// session was refreshed too often (ratelimit.ts); answer 429 with this
// Retry-After and keep the cookies.
export type Lookup = { session: Session | null; cookies: string[]; unavailable: boolean; limited?: number };

export async function getSession(req: http.IncomingMessage): Promise<Lookup> {
  return conf().mode === "local" ? localSession(req) : supabaseSession(req);
}

// Local stand-in --------------------------------------------------------------

type LocalSession = { userId: string; csrf: string; expires: number; flash?: Flash };
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
      signOutEverywhere: async () => {
        for (const [k, v] of localSessions) if (v.userId === s.userId) localSessions.delete(k);
        return "ok";
      },
      pendingEmail: async () => null,
      changeEmail: async () => "refused",
    },
    cookies: [],
    unavailable: false,
  };
}

// Supabase ------------------------------------------------------------------

// Supabase Auth could not answer. The reason (never a token or an address)
// goes to the request's error (failure.ts), for the "unavailable" page.
class Unavailable extends Error {
  constructor(why: string) {
    super(why);
    noteUpstream("sign-in (Supabase Auth)", why);
  }
}
const unreachable = (call: string, err: unknown) =>
  new Unavailable(`${call} failed: ${networkReason(err) ?? `${(err as Error)?.name ?? "error"} before an answer`}`);

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
    // The session an expired (but genuine) access token names, for the
    // refresh limit.
    let expiredSession: string | undefined;
    if (at) {
      const r = await verifyAccessToken(at);
      if (r.ok) claims = r.claims;
      else if (!r.expired) {
        console.info(`auth: access token refused (${r.reason})`);
        return none(true);
      } else expiredSession = r.sessionId;
    }
    if (!claims) {
      if (!rt) return none(!!at);
      // Refreshes per session; with no access token to name it, per
      // refresh token (which Supabase rotates, so that only stops reuse).
      // Fails open (ratelimit.ts).
      const wait = await limit([
        { name: "signin_refresh_session", kind: "session", value: expiredSession ?? `refresh:${rt}` },
      ]);
      if (wait) return { session: null, cookies, unavailable: false, limited: wait };
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
      console.error(`auth: Supabase Auth unreachable: ${err.message}`);
      return { session: null, cookies: [], unavailable: true };
    }
    throw err;
  }
}

function supabaseSessionFor(req: http.IncomingMessage, claims: Claims, accessToken: string, cookies: string[]): Session {
  return {
    userId: claims.sub,
    csrf: mac("csrf", claims.session_id),
    issuedAt: typeof claims.iat === "number" && Number.isFinite(claims.iat) ? claims.iat : undefined,
    takeFlash: () => {
      const raw = readCookie(req, cookieName(FLASH));
      if (raw === undefined) return undefined;
      cookies.push(clearCookie(FLASH));
      const [body = "", sig = ""] = raw.split(".");
      if (!sameSecret(sig, mac("flash", body))) return undefined;
      return decodeFlash(body);
    },
    setFlash: (f) => {
      cookies.push(flashCookie(f));
    },
    signOut: async () => {
      // Best effort: the JWT stays valid until it expires (at most an hour)
      // even if this call fails, but our cookies go either way.
      await gotrue("/logout?scope=local", {}, { authorization: `Bearer ${accessToken}` }).catch(() => undefined);
      cookies.push(...SESSION_COOKIES.map(clearCookie));
    },
    signOutEverywhere: async () => {
      try {
        const r = await gotrue("/logout?scope=global", {}, { authorization: `Bearer ${accessToken}` });
        if (r.status < 200 || r.status > 299) {
          noteUpstream("sign-out (Supabase Auth)", `POST /logout?scope=global answered ${r.status}: Supabase Auth refused to end the account's sessions`);
          return "refused";
        }
      } catch (err) {
        if (err instanceof Unavailable) return "unavailable";
        throw err;
      }
      cookies.push(...SESSION_COOKIES.map(clearCookie));
      return "ok";
    },
    pendingEmail: async () => {
      try {
        const r = await gotrue("/user", undefined, { authorization: `Bearer ${accessToken}` }, "GET");
        if (r.status !== 200) {
          noteUpstream("account (Supabase Auth)", `GET /user answered ${r.status}`);
          return "unavailable";
        }
        const email = typeof r.json?.new_email === "string" ? r.json.new_email.trim() : "";
        if (!email) return null;
        const at = typeof r.json?.email_change_sent_at === "string" ? new Date(r.json.email_change_sent_at) : null;
        return { email, sentAt: at && !Number.isNaN(+at) ? at : null };
      } catch (err) {
        if (err instanceof Unavailable) return "unavailable";
        throw err;
      }
    },
    changeEmail: async (email) => {
      try {
        const r = await gotrue("/user", { email }, { authorization: `Bearer ${accessToken}` }, "PUT");
        if (r.status === 200) return "sent";
        const code = String(r.json?.error_code ?? "");
        const msg = String(r.json?.msg ?? r.json?.message ?? "");
        // What Auth said, never the address, goes to the request's error.
        noteUpstream("change of email (Supabase Auth)", `PUT /user answered ${r.status}${code ? ` (${code})` : ""}`);
        if (code === "email_exists" || /already (been )?registered/i.test(msg)) return "taken";
        if (r.status === 429 || code.startsWith("over_email_send_rate_limit") || code === "over_request_rate_limit") return "limited";
        if (code === "validation_failed" || code === "email_address_invalid" || /invalid format|validate email/i.test(msg)) return "invalid";
        return "refused";
      } catch (err) {
        if (err instanceof Unavailable) return "unavailable";
        throw err;
      }
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

async function gotrue(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method: "POST" | "PUT" | "GET" = "POST",
): Promise<{ status: number; json: any }> {
  const c = conf();
  let res: Response;
  try {
    res = await fetch(`${c.issuer}${path}`, {
      method,
      headers: { apikey: c.apiKey, "content-type": "application/json", accept: "application/json", ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw unreachable(`${method} ${path}`, err);
  }
  if (res.status >= 500) throw new Unavailable(`${method} ${path} answered ${res.status}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const REFRESH_TOKEN = /^[\x21-\x7e]{1,512}$/;

// A session from Supabase, or undefined if it refused (4xx). Throws
// Unavailable on network failure or 5xx.
async function tokenRequest(path: string, body: unknown): Promise<Tokens | undefined> {
  const { status, json } = await gotrue(path, body);
  return tokensOf(status, json);
}

function tokensOf(status: number, json: any): Tokens | undefined {
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

// otherAddress: a change of address was confirmed at one address, and waits
// for the other (Supabase's secure email change); no session yet.
export type SigninResult = { ok: true; cookies: string[] } | { ok: false; unavailable: boolean; otherAddress?: boolean };

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

// Step 3: a 6-digit code (with its email) or a link's token hash (`type`
// email, or email_change for a new address). On success, the session
// cookies to set.
export async function verifySignin(
  p: { email: string; code: string } | { tokenHash: string; type?: "email" | "email_change" },
): Promise<SigninResult> {
  const body = "tokenHash" in p ? { type: p.type ?? "email", token_hash: p.tokenHash } : { type: "email", email: p.email, token: p.code };
  try {
    const { status, json } = await gotrue("/verify", body);
    // A change of address's first of two confirmations: 200, a message, no tokens.
    if (body.type === "email_change" && status === 200 && json?.access_token === undefined) {
      return { ok: false, unavailable: false, otherAddress: true };
    }
    const t = tokensOf(status, json);
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
  | { ok: false; reason: string; expired?: boolean; unknownKey?: boolean; sessionId?: string };

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
  // Expired but otherwise genuine: its session id can be trusted.
  if (payload.exp <= now) return { ok: false, reason: "expired", expired: true, sessionId: payload.session_id };
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
  } catch (err) {
    throw unreachable("GET /.well-known/jwks.json (signing keys)", err);
  }
  if (res.status !== 200) throw new Unavailable(`GET /.well-known/jwks.json (signing keys) answered ${res.status}`);
  const body = (await res.json().catch(() => undefined)) as { keys?: unknown } | undefined;
  if (!body || !Array.isArray(body.keys)) throw new Unavailable("GET /.well-known/jwks.json (signing keys) answered with no key list");
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
