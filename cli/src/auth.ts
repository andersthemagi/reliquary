// Sign-in against Reliquary's own authorization server (docs/variables.md,
// "The CLI's sign-in"): the authorization code grant with PKCE S256, a
// loopback redirect on 127.0.0.1 on a free port (RFC 8252), `resource` =
// `<issuer>/api/env`, and rotating refresh tokens.
//
// No token, code or verifier is ever printed, logged, put in a URL we
// print, an argument or a child's environment.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Server, getJson } from "./config.js";
import { type Credential, getCredential, setCredential, withLock } from "./credentials.js";
import { CliError, NotSignedIn, serverSays } from "./errors.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EARLY_MS = 60_000; // refresh a minute before expiry
const ACCESS = /^rle_[0-9a-f]{64}$/;
const REFRESH = /^rlr_[0-9a-f]{64}$/;

const b64url = (b: Buffer) => b.toString("base64url");

// ---------------------------------------------------------------------------
// The token endpoint

type TokenResult = { ok: true; credential: Credential } | { ok: false; error: string; status: number; says: string };

async function tokenRequest(server: Server, fields: Record<string, string>): Promise<TokenResult> {
  const { status, body } = await getJson(server.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200 && typeof b.access_token === "string" && ACCESS.test(b.access_token) && typeof b.refresh_token === "string" && REFRESH.test(b.refresh_token)) {
    const expiresIn = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 3600;
    return { ok: true, credential: { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: Date.now() + expiresIn * 1000 } };
  }
  return { ok: false, status, says: serverSays(body), error: typeof b.error === "string" && /^[a-z_]{1,40}$/.test(b.error) ? b.error : `no error code, HTTP ${status}` };
}

// ---------------------------------------------------------------------------
// Login

export type LoginOptions = { openBrowser: boolean; print: (line: string) => void };

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener: the printed link is enough
    child.unref();
  } catch {
    // same
  }
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p>`;

const DENIED: Record<string, string> = {
  access_denied: "The sign-in was denied in the browser.",
  invalid_target: "The server refused the CLI's resource. Is this a Reliquary server, and is the CLI up to date?",
  invalid_request: "The server refused the sign-in request.",
  unsupported_response_type: "The server refused the sign-in request.",
};

// Waits for the browser to come back to http://127.0.0.1:<port>/callback.
// Resolves with the code; rejects on a mismatched state or issuer, an OAuth
// error, or after five minutes.
function listen(): Promise<{ port: number; code: Promise<string>; close: () => void; expect: (state: string, issuer: string) => void }> {
  return new Promise((resolveListen, rejectListen) => {
    let expected: { state: string; issuer: string } | null = null;
    let settle!: { resolve: (c: string) => void; reject: (e: Error) => void };
    const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    code.catch(() => {}); // awaited by login(); never an unhandled rejection
    let done = false;
    const finish = (err: Error | null, value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) settle.reject(err);
      else settle.resolve(value!);
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || u.pathname !== "/callback" || !expected) {
        res.writeHead(404, PAGE_HEADERS).end(page("Not found", "This is the Reliquary CLI waiting for a sign-in."));
        return;
      }
      if (done) {
        res.writeHead(410, PAGE_HEADERS).end(page("Already used", "This sign-in has finished. Go back to the terminal."));
        return;
      }
      const q = u.searchParams;
      const fail = (status: number, message: string) => {
        res.writeHead(status, PAGE_HEADERS).end(page("Sign-in failed", `${message} Go back to the terminal.`));
        finish(new CliError(message));
      };
      if (q.get("state") !== expected.state) return fail(400, "The sign-in answer doesn't match this login (wrong state), so it was ignored.");
      if (q.get("iss") !== expected.issuer) return fail(400, "The sign-in answer came from a different server (wrong iss), so it was ignored.");
      const error = q.get("error");
      if (error) return fail(400, DENIED[error] ?? "The server refused the sign-in.");
      const c = q.get("code");
      if (!c) return fail(400, "The sign-in answer had no code.");
      res.writeHead(200, PAGE_HEADERS).end(page("Signed in", "The Reliquary CLI is signed in. You can close this tab and go back to the terminal."));
      finish(null, c);
    });
    const timer = setTimeout(() => finish(new CliError("Timed out after 5 minutes waiting for the browser. Run `reliquary login` again.")), LOGIN_TIMEOUT_MS);
    timer.unref();
    server.on("error", (err) => {
      rejectListen(new CliError(`Couldn't listen on 127.0.0.1 for the sign-in (${(err as NodeJS.ErrnoException).code ?? "error"}).`));
    });
    server.listen(0, "127.0.0.1", () => {
      resolveListen({
        port: (server.address() as AddressInfo).port,
        code,
        expect: (state, issuer) => (expected = { state, issuer }),
        close: () => {
          clearTimeout(timer);
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

export async function login(server: Server, opts: LoginOptions): Promise<void> {
  const verifier = b64url(randomBytes(48)); // 64 characters of [A-Za-z0-9_-]
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const cb = await listen();
  try {
    cb.expect(state, server.issuer);
    const redirectUri = `http://127.0.0.1:${cb.port}/callback`;
    const url = new URL(server.authorizationEndpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: server.clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: server.resource,
    })) {
      url.searchParams.set(k, v);
    }
    opts.print(`Sign in to ${server.issuer} in your browser${opts.openBrowser ? " (opening it now)" : ""}. If it doesn't open, visit:`);
    opts.print(`  ${url.href}`);
    opts.print("Waiting for you to allow it (5 minutes)...");
    if (opts.openBrowser) openUrl(url.href);
    const code = await cb.code;
    const r = await tokenRequest(server, {
      grant_type: "authorization_code",
      code,
      client_id: server.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: server.resource,
    });
    if (!r.ok) throw new CliError(`The server refused the sign-in code (${r.error}). Run \`reliquary login\` again.${r.says}`);
    const previous = await withLock(async () => {
      const old = getCredential(server.issuer);
      setCredential(server.issuer, r.credential);
      return old;
    });
    // A sign-in replaces the last one on this computer: revoke the old grant.
    if (previous && previous.refreshToken !== r.credential.refreshToken) await revoke(server, previous.refreshToken).catch(() => {});
  } finally {
    cb.close();
  }
}

// ---------------------------------------------------------------------------
// Tokens for requests

async function revoke(server: Server, token: string): Promise<boolean> {
  if (!server.revocationEndpoint) return false;
  const { status } = await getJson(server.revocationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: server.clientId }).toString(),
  });
  return status === 200;
}

// Signs out: revokes the grant, then forgets it. Returns false if there was
// no sign-in for this server.
export async function logout(server: Server): Promise<{ had: boolean; revoked: boolean }> {
  return withLock(async () => {
    const c = getCredential(server.issuer);
    if (!c) return { had: false, revoked: false };
    let revoked = false;
    try {
      revoked = await revoke(server, c.refreshToken);
    } finally {
      setCredential(server.issuer, null);
    }
    return { had: true, revoked };
  });
}

// A usable access token: the stored one if it has a minute left, else a
// refreshed one. `stale` is a token the API just refused: refresh unless
// another process already has.
export async function accessToken(server: Server, stale?: string): Promise<string> {
  const now = getCredential(server.issuer);
  if (!now) throw new NotSignedIn(server.issuer);
  if (!stale && now.expiresAt - EARLY_MS > Date.now()) return now.accessToken;
  return withLock(async () => {
    const c = getCredential(server.issuer); // re-read under the lock
    if (!c) throw new NotSignedIn(server.issuer);
    if (c.accessToken !== stale && c.expiresAt - EARLY_MS > Date.now()) return c.accessToken;
    const r = await tokenRequest(server, {
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: server.clientId,
      resource: server.resource,
    });
    if (r.ok) {
      // Store the new refresh token before using the new access token.
      setCredential(server.issuer, r.credential);
      return r.credential.accessToken;
    }
    if (r.error === "invalid_grant") {
      setCredential(server.issuer, null);
      throw new NotSignedIn(server.issuer, "Your sign-in was revoked or has expired");
    }
    throw new CliError(`Refreshing your sign-in failed: the server refused it (${r.error}).${r.says || " It sent no reason."} If it keeps failing, run \`reliquary login\`.`);
  });
}

export async function forget(server: Server): Promise<void> {
  await withLock(async () => setCredential(server.issuer, null));
}
