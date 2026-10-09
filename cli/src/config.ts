// Which server, and what it says about itself.
//
// The server is `--server`, else RELIQUARY_URL, else `server` in the nearest
// `.reliquary.json`, else the hosted app. Its authorization server metadata
// (RFC 8414) names the issuer; the CLI's client id and the env API's
// resource derive from it (docs/variables.md, "The CLI's sign-in").
//
// `.reliquary.json` may be committed: it holds a server, a vault (id or
// name) and an environment, never a value.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliError, fsFailure, UsageError } from "./errors.js";

export const DEFAULT_SERVER = "https://app.reliquary.redmage.cc";
export const PROJECT_FILE = ".reliquary.json";
export const TIMEOUT_MS = 30_000;

export type ProjectConfig = { file: string; server?: string; vault?: string; environment?: string };

export type Server = {
  issuer: string; // the origin, no trailing slash
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  resource: string; // `<issuer>/api/env`
};

// The nearest .reliquary.json from `dir` up. Unknown keys are ignored; the
// known ones must be strings.
export function projectConfig(dir = process.cwd()): ProjectConfig | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, PROJECT_FILE);
    if (existsSync(file)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        throw fsFailure("read", file, err);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new CliError(`${file} isn't valid JSON.`);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CliError(`${file} must hold a JSON object.`);
      const o = raw as Record<string, unknown>;
      const out: ProjectConfig = { file };
      for (const k of ["server", "vault", "environment"] as const) {
        if (o[k] === undefined) continue;
        if (typeof o[k] !== "string" || !o[k]) throw new CliError(`${file}: "${k}" must be a non-empty string.`);
        out[k] = o[k] as string;
      }
      return out;
    }
    if (path.dirname(d) === d) return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

// An origin we may send tokens to: https, or http on this computer only.
export function serverOrigin(flag: string | undefined, project: ProjectConfig | null): string {
  // An exported empty variable is a mistake to name, not a reason to quietly
  // use another server: tokens go wherever this points.
  if (flag === undefined && process.env.RELIQUARY_URL === "") {
    throw new UsageError(`RELIQUARY_URL is set but empty. Unset it, or set it to a server like ${DEFAULT_SERVER}.`);
  }
  const raw = flag ?? process.env.RELIQUARY_URL ?? project?.server ?? DEFAULT_SERVER;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`The server must be a URL like ${DEFAULT_SERVER}.`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new UsageError("The server must use https (plain http only for 127.0.0.1, [::1] or localhost).");
  }
  if (u.username || u.password) throw new UsageError("The server URL must not contain a user name or password.");
  return u.origin;
}

// Why a request never got an answer, from the error or its cause: DNS, TLS,
// a refused or reset connection, or no answer in time. Codes only, never a
// message (which could carry what was sent).
const NET: Record<string, string> = {
  ENOTFOUND: "the DNS lookup found no such host (ENOTFOUND)",
  EAI_AGAIN: "the DNS lookup failed for now (EAI_AGAIN)",
  ECONNREFUSED: "the connection was refused (ECONNREFUSED): nothing is listening there",
  ECONNRESET: "the connection was reset (ECONNRESET)",
  ETIMEDOUT: "the connection timed out (ETIMEDOUT)",
  EHOSTUNREACH: "the host is unreachable (EHOSTUNREACH)",
  ENETUNREACH: "the network is unreachable (ENETUNREACH)",
  EPIPE: "the connection closed while sending (EPIPE)",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out (UND_ERR_CONNECT_TIMEOUT)",
  UND_ERR_SOCKET: "the connection closed unexpectedly (UND_ERR_SOCKET)",
  UND_ERR_HEADERS_TIMEOUT: "the server sent no answer in time (UND_ERR_HEADERS_TIMEOUT)",
};
const TLS = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;

export function networkReason(err: unknown, timeoutMs = TIMEOUT_MS): string {
  for (let e = err as { code?: unknown; cause?: unknown; name?: unknown } | undefined, i = 0; e && i < 4; e = e.cause as typeof e, i++) {
    if (e.name === "TimeoutError") return `no answer within ${Math.round(timeoutMs / 1000)} seconds (timeout)`;
    const code = typeof e.code === "string" ? e.code : "";
    if (NET[code]) return NET[code];
    if (TLS.test(code)) return `the TLS certificate check failed (${code})`;
    if (code) return `the request failed (${code})`;
  }
  return `the request failed (${(err as Error)?.name ?? "error"}, no error code)`;
}

export async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  let res: Response;
  const u = new URL(url);
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new CliError(`Couldn't reach ${u.host} (${init.method ?? "GET"} ${u.pathname}): ${networkReason(err)}. Check the server address and your connection.`);
  }
  let body: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    // Never shown: only read for known fields.
    body = await res.json().catch(() => null);
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return { status: res.status, body, headers: res.headers };
}

const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);

// RFC 8414: the metadata's issuer must be the origin we asked, and the CLI
// only talks to endpoints on that origin.
export async function discover(origin: string): Promise<Server> {
  const { status, body } = await getJson(`${origin}/.well-known/oauth-authorization-server`);
  if (status !== 200 || typeof body !== "object" || body === null) {
    throw new CliError(`${origin} doesn't look like a Reliquary server (no sign-in metadata; it answered ${status}).`);
  }
  const m = body as Record<string, unknown>;
  const issuer = str(m, "issuer");
  if (issuer !== origin) throw new CliError(`${origin} names a different issuer in its metadata; refusing to sign in there.`);
  const same = (k: string, required: boolean) => {
    const v = str(m, k);
    if (v === null) {
      if (required) throw new CliError(`${origin}'s sign-in metadata has no ${k}.`);
      return null;
    }
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new CliError(`${origin}'s sign-in metadata has a bad ${k}.`);
    }
    if (u.origin !== origin) throw new CliError(`${origin}'s ${k} is on another server; refusing.`);
    return u.href;
  };
  const methods = Array.isArray(m.code_challenge_methods_supported) ? m.code_challenge_methods_supported : [];
  if (!methods.includes("S256")) throw new CliError(`${origin} doesn't support PKCE with S256; refusing to sign in.`);
  return {
    issuer,
    authorizationEndpoint: same("authorization_endpoint", true)!,
    tokenEndpoint: same("token_endpoint", true)!,
    revocationEndpoint: same("revocation_endpoint", false),
    clientId: `${issuer}/cli/oauth-client.json`,
    resource: `${issuer}/api/env`,
  };
}
