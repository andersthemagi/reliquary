// The internal endpoint mcp/ calls to make one already-authorized
// <link>.<tool> call (docs/design.md, "Links"). mcp/ decides whether the
// call is allowed at all (begin_link_call, the database chokepoint) and
// holds only its output: the sealed credential, never key material,
// which stays web-app-only (mcp/src/server.ts refuses to start with
// VARIABLES_KEY(S) set). This opens that one ciphertext (secrets.ts) and
// makes the SSRF-safe outbound call (linkcall.ts, discovery.ts's own
// machinery); the result, or a reason written for people, goes back to
// mcp/, which logs the outcome itself (record_link_call) and returns the
// result to the agent, quoted as data like any other proxied text.
//
// Authenticated by a shared secret (LINK_PROXY_SECRET), not a person's
// session or any kind of access token: this is Reliquary's own two
// servers talking, the same shape as /healthz?db=1's KEEPALIVE_TOKEN.
// Required (refuses to start without it) whenever VERCEL or SELF_HOSTED
// is set, matching every other required-secret startup check in this app.
//
//   POST /internal/link-call   Authorization: Bearer <LINK_PROXY_SECRET>
//     {vault_id, url, key_id, nonce, ciphertext, tool_name, args}
//     -> {ok: true, result} | {ok: false, error, message?, where?, ref?}

import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { callUpstreamTool, UpstreamError } from "./linkcall.js";
import { discoveryAllowsLoopback } from "./discovery.js";
import { openLink, SecretsError, type Sealed } from "./secrets.js";
import { apiBody, fail, failure } from "./failure.js";

const MAX_BODY = 256 * 1024;
const PATH = "/internal/link-call";

let SECRET = "";
export function configureLinkProxy(env: NodeJS.ProcessEnv = process.env): void {
  const strict = env.VERCEL ? "VERCEL" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  SECRET = env.LINK_PROXY_SECRET ?? "";
  if (strict && !SECRET) throw new Error(`Refusing to start: ${strict} is set but LINK_PROXY_SECRET is not`);
}

class BadRequest extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function send(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function authorized(header: string | string[] | undefined): boolean {
  if (!SECRET) return false;
  const m = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
  if (!m) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(SECRET));
}

function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      reject(new BadRequest(413, "too_large"));
      return;
    }
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new BadRequest(413, "too_large"));
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadRequest(400, "invalid_request"));
      }
    });
    req.on("error", reject);
  });
}

type Body = {
  vault_id?: unknown;
  url?: unknown;
  key_id?: unknown;
  nonce?: unknown;
  ciphertext?: unknown;
  tool_name?: unknown;
  args?: unknown;
};

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function sealedOf(b: Body): Sealed {
  if (!isNonEmptyString(b.key_id) || !isNonEmptyString(b.nonce) || !isNonEmptyString(b.ciphertext)) throw new BadRequest(400, "invalid_request");
  let nonce: Buffer, ciphertext: Buffer;
  try {
    nonce = Buffer.from(b.nonce, "base64");
    ciphertext = Buffer.from(b.ciphertext, "base64");
  } catch {
    throw new BadRequest(400, "invalid_request");
  }
  return { keyId: b.key_id, nonce, ciphertext };
}

// Handles the request if it's this endpoint's; returns false (nothing
// sent) otherwise, so server.ts can fall through to ordinary routing --
// the same shape envapi.ts's envApi uses.
export async function linkProxyApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== PATH) return false;
  if (req.method !== "POST") {
    req.resume();
    send(res, 405, { ok: false, error: "method_not_allowed" });
    console.info(`${req.method} ${PATH} 405`);
    return true;
  }
  if (!authorized(req.headers.authorization)) {
    req.resume();
    send(res, 401, { ok: false, error: "unauthorized" });
    console.info(`POST ${PATH} 401`);
    return true;
  }

  let outcome = "ok";
  try {
    const body = (await readJson(req, MAX_BODY)) as Body;
    if (!isNonEmptyString(body.vault_id) || !isNonEmptyString(body.url) || !isNonEmptyString(body.tool_name)) {
      throw new BadRequest(400, "invalid_request");
    }
    const sealed = sealedOf(body);
    let credential: string;
    try {
      credential = openLink(sealed, body.vault_id);
    } catch (err) {
      const f = failure({ status: 502, where: "link proxy (credential)", why: err instanceof SecretsError ? err.message : "The credential couldn’t be decrypted." });
      send(res, f.status, { ok: false, ...apiBody(f, "decrypt_failed") });
      outcome = "decrypt_failed";
      return true;
    }
    const result = await callUpstreamTool(body.url, credential, body.tool_name, body.args, { allowLoopback: discoveryAllowsLoopback() });
    send(res, 200, { ok: true, result });
  } catch (err) {
    if (err instanceof BadRequest) {
      send(res, err.status, { ok: false, error: err.code });
      outcome = err.code;
    } else if (err instanceof UpstreamError) {
      const f = failure({ status: 502, where: "link proxy (upstream)", why: err.message });
      send(res, f.status, { ok: false, ...apiBody(f, "upstream_failed") });
      outcome = "upstream_failed";
    } else {
      const f = fail(err, { where: "link proxy" });
      if (!res.headersSent) send(res, f.status, { ok: false, ...apiBody(f, "server_error") });
      outcome = `server_error ref=${f.ref}`;
    }
  }
  // The route and outcome only: never the url, credential, tool name or args.
  console.info(`POST ${PATH} ${res.statusCode} ${outcome}`);
  return true;
}
