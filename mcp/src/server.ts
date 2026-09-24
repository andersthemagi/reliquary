// Reliquary's remote MCP endpoint: Streamable HTTP, stateless, one MCP
// server per request, authenticated by a personal access token or an OAuth
// access token from the web app's authorization server.
//
//   POST /mcp      MCP (Authorization: Bearer rlq_... or rlo_...)
//   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata
//   GET  /healthz  liveness
//   GET  /healthz?db=1  keepalive: `select 1`, then `ok` or 503 `unavailable`
//
// A 401 names the protected resource metadata (WWW-Authenticate:
// resource_metadata=...), which is how an MCP client finds where to sign in.
//
// Logs carry method, status and an identity prefix. Never tokens, arguments,
// or file text.

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { pool, recordClient, resolveOAuthToken, resolveToken, Session, tokenRef, type Identity } from "./db.js";
import { registerTools } from "./tools.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 1024 * 1024;
// A JSON-RPC batch runs one transaction per message: without a ceiling, one
// 1 MB POST could queue thousands of database calls.
const MAX_BATCH = 10;

// OAuth (docs/research/hosting.md, section 4). MCP_RESOURCE is this server's
// canonical URL, byte for byte what the authorization server binds tokens to
// (the web app reads the same value); AUTH_ISSUER is the web app. Both are
// required on Vercel; locally they default to the dev.sh addresses.
function oauthConfig() {
  const onVercel = !!process.env.VERCEL;
  if (onVercel && (!process.env.MCP_RESOURCE || !process.env.AUTH_ISSUER)) {
    console.error("Refusing to start: VERCEL is set but MCP_RESOURCE or AUTH_ISSUER is not");
    process.exit(1);
  }
  const resource = process.env.MCP_RESOURCE ?? `http://${HOST}:${PORT}/mcp`;
  const issuer = process.env.AUTH_ISSUER ?? "http://127.0.0.1:8790";
  let r: URL;
  try {
    r = new URL(resource);
    const i = new URL(issuer);
    if (!/^https?:$/.test(r.protocol) || r.hash || !/^https?:$/.test(i.protocol) || i.search || i.hash) throw new Error();
  } catch {
    console.error("MCP_RESOURCE and AUTH_ISSUER must be http(s) URLs without fragments");
    process.exit(1);
  }
  // RFC 9728, 3.1: the well-known segment goes between host and path.
  const prmPath = "/.well-known/oauth-protected-resource" + (r.pathname === "/" ? "" : r.pathname);
  return { resource, issuer, prmPath, prmUrl: r.origin + prmPath };
}
const OAUTH = oauthConfig();

// The key that decrypts variable values belongs to the web app alone
// (docs/variables.md). This app never decrypts anything, so holding it could
// only leak it.
if (process.env.VARIABLES_KEY !== undefined) {
  console.error("Refusing to start: VARIABLES_KEY is set, and only the web app may hold it");
  process.exit(1);
}

const prm = () => ({
  resource: OAUTH.resource,
  authorization_servers: [OAUTH.issuer],
  bearer_methods_supported: ["header"],
  scopes_supported: [],
  resource_name: "Reliquary",
});

// Personal tokens (rlq_) and OAuth access tokens (rlo_) resolve to the same
// kind of identity. Nothing else is accepted, and no token is passed on.
async function identify(token: string) {
  if (token.startsWith("rlo_")) return resolveOAuthToken(token, OAUTH.resource);
  return resolveToken(token);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// With KEEPALIVE_TOKEN set, /healthz?db=1 needs `x-keepalive: <token>`, so it
// can't be used to hammer the pooler. Compared as digests: constant time,
// whatever the lengths.
function keepaliveAllowed(header: string | string[] | undefined): boolean {
  const want = process.env.KEEPALIVE_TOKEN;
  if (!want) return true;
  if (typeof header !== "string") return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(want));
}

const httpServer = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    const plain = { "content-type": "text/plain", "cache-control": "no-store" };
    if (new URL(req.url ?? "/", "http://localhost").searchParams.get("db") !== "1") {
      res.writeHead(200, plain).end("ok");
      return;
    }
    // Keepalive (docs/research/hosting.md, section 6): one `select 1` as this
    // role, touching no table. Only `ok` or `unavailable`, never error text.
    if (!keepaliveAllowed(req.headers["x-keepalive"])) {
      res.writeHead(401, plain).end("unauthorized");
      return;
    }
    const up = await Promise.race([
      pool.query("select 1").then(() => true, () => false),
      new Promise<boolean>((r) => setTimeout(r, 5000, false).unref()),
    ]);
    res.writeHead(up ? 200 : 503, plain).end(up ? "ok" : "unavailable");
    return;
  }
  if (path === OAUTH.prmPath || path === "/.well-known/oauth-protected-resource") {
    if (req.method !== "GET" && req.method !== "OPTIONS") {
      send(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      return;
    }
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "mcp-protocol-version" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    send(res, 200, prm(), { ...cors, "cache-control": "public, max-age=300" });
    return;
  }
  if (path !== "/mcp") {
    send(res, 404, { error: "not_found" });
    return;
  }

  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const ref = bearer ? tokenRef(bearer[1], OAUTH.resource) : null;
  const unauthorized = () => {
    // RFC 6750: no error code when no credentials were sent.
    const challenge = `Bearer realm="reliquary", resource_metadata="${OAUTH.prmUrl}"${bearer ? ', error="invalid_token"' : ""}`;
    send(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": challenge });
    console.info("mcp 401");
  };
  // A request that fails before any tool could run answers 401 for a bad
  // token first, as before, then its own error.
  const knownOr401 = async () => {
    const id = ref ? await identify(bearer![1]).catch(() => null) : null;
    if (!id) unauthorized();
    return id;
  };
  if (!ref) {
    unauthorized();
    return;
  }

  // Stateless: no server-initiated streams or sessions to resume.
  if (req.method !== "POST") {
    if (await knownOr401()) send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    if (await knownOr401()) send(res, 400, { error: (err as Error).message });
    return;
  }
  if (Array.isArray(body) && body.length > MAX_BATCH) {
    if (await knownOr401()) {
      send(res, 400, { error: `batch too large: at most ${MAX_BATCH} messages per request` });
      console.info("mcp 400 batch");
    }
    return;
  }

  // A request that calls a tool resolves its token inside the first call's
  // transaction, on the one connection the whole request uses (Session).
  // Anything else (initialize, tools/list, notifications) needs no
  // transaction: one autocommit resolve, as before.
  const messages = Array.isArray(body) ? body : [body];
  const callsTools = messages.some((m) => (m as { method?: unknown } | null)?.method === "tools/call");
  let session: Session | null = null;
  let identity: Identity | null;
  if (callsTools) {
    session = new Session(ref);
    identity = await session.open().catch(() => null);
  } else {
    identity = await identify(bearer![1]).catch(() => null);
  }
  if (!identity) {
    unauthorized();
    return;
  }

  // The client's self-reported name, for the Tokens page. Never logged.
  const init = body as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
  if (bearer && init?.method === "initialize" && typeof init.params?.clientInfo?.name === "string") {
    await recordClient(bearer[1], init.params.clientInfo.name);
  }

  const mcp = new McpServer({ name: "reliquary", version: "0.1.0" });
  const runner = session;
  registerTools(mcp, identity, runner ? (fn) => runner.run(fn) : undefined);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
    void session?.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    console.info(`mcp ${res.statusCode} user=${identity.userId.slice(0, 8)}`);
  } catch (err) {
    console.error("mcp error", (err as Error).name);
    if (!res.headersSent) send(res, 500, { error: "server_error" });
  } finally {
    await session?.close();
  }
});

// On Vercel the app runs as one function (api/index.js) that hands every
// request to this handler; the platform owns the socket. Locally, listen on
// loopback as before.
export const handle: http.RequestListener = (req, res) => {
  httpServer.emit("request", req, res);
};
// Locally, a client that trickles its headers or body can't hold a socket
// for Node's default five minutes. (On Vercel the platform owns the socket,
// and maxDuration in vercel.json bounds a request.)
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
if (!process.env.VERCEL) {
  httpServer.listen(PORT, HOST, () => console.info(`reliquary mcp on http://${HOST}:${PORT}/mcp`));
}
