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
// Required (refuses to start without it) whenever NETLIFY or SELF_HOSTED
// is set, matching every other required-secret startup check in this app.
//
//   POST /internal/link-call   Authorization: Bearer <LINK_PROXY_SECRET>
//     {vault_id, url, key_id, nonce, ciphertext, tool_name, args}
//     -> {ok: true, result: {content, isError}}
//      | {ok: false, error, message, why, where, ref}   every refusal and failure past the secret check
//      | {ok: false, error}                              401 and 405: nothing was attempted, so no reference
//
// The second shape is read by mcp/src/linkproxy.ts, a separate deployable
// with its own copy of this contract: mcp/test/link_proxy.test.mjs fails
// if the two stop agreeing. `error` is the endpoint's own code, `why` the
// reason written for people (`message` is "what failed: why"), `where` the
// component and `ref` the reference that finds the detail in this app's log.

import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { callUpstreamTool, UpstreamError } from "./linkcall.js";
import { discoveryAllowsLoopback } from "./discovery.js";
import { openLink, SecretsError, type Sealed } from "./secrets.js";
import { apiBody, doing, fail, failure, type Failure } from "./failure.js";
import { BadRequest, readJson } from "./jsonbody.js";

const MAX_BODY = 256 * 1024;
const PATH = "/internal/link-call";

// A BadRequest carries only a code; the reasons are fixed text, never the
// request's.
const REQUEST_REASONS: Record<string, string> = {
  invalid_request: "The call’s body wasn’t JSON holding a vault id, a url, a tool name and a sealed credential",
  too_large: `The call’s body is over ${MAX_BODY / 1024} KiB, so the arguments are too large to send`,
};

let SECRET = "";
export function configureLinkProxy(env: NodeJS.ProcessEnv = process.env): void {
  const strict = env.NETLIFY ? "NETLIFY" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  SECRET = env.LINK_PROXY_SECRET ?? "";
  if (strict && !SECRET) throw new Error(`Refusing to start: ${strict} is set but LINK_PROXY_SECRET is not`);
}

function send(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function sendFailure(res: http.ServerResponse, f: Failure, code: string): void {
  send(res, f.status, { ok: false, ...apiBody(f, code), why: f.why });
}

function authorized(header: string | string[] | undefined): boolean {
  if (!SECRET) return false;
  const m = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
  if (!m) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(SECRET));
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
  doing("Calling a link’s tool");
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
      sendFailure(res, f, "decrypt_failed");
      outcome = "decrypt_failed";
      return true;
    }
    const result = await callUpstreamTool(body.url, credential, body.tool_name, body.args, { allowLoopback: discoveryAllowsLoopback() });
    send(res, 200, { ok: true, result });
  } catch (err) {
    if (err instanceof BadRequest) {
      const f = failure({ status: err.status, where: "link proxy (request)", why: REQUEST_REASONS[err.code] ?? err.code, code: err.code });
      sendFailure(res, f, err.code);
      outcome = err.code;
    } else if (err instanceof UpstreamError) {
      const f = failure({ status: 502, where: "link proxy (upstream)", why: err.message });
      sendFailure(res, f, "upstream_failed");
      outcome = "upstream_failed";
    } else {
      const f = fail(err, { where: "link proxy" });
      if (!res.headersSent) sendFailure(res, f, "server_error");
      outcome = `server_error ref=${f.ref}`;
    }
  }
  // The route and outcome only: never the url, credential, tool name or args.
  console.info(`POST ${PATH} ${res.statusCode} ${outcome}`);
  return true;
}
