// Reliquary's remote MCP endpoint: Streamable HTTP, stateless, one MCP
// server per request, authenticated by a personal access token.
//
//   POST /mcp      MCP (Authorization: Bearer rlq_...)
//   GET  /healthz  liveness
//
// Logs carry method, status and an identity prefix. Never tokens, arguments,
// or file text.

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { recordClient, resolveToken } from "./db.js";
import { registerTools } from "./tools.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 1024 * 1024;

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

const httpServer = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (path !== "/mcp") {
    send(res, 404, { error: "not_found" });
    return;
  }

  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const identity = bearer ? await resolveToken(bearer[1]).catch(() => null) : null;
  if (!identity) {
    send(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": 'Bearer realm="reliquary"' });
    console.info("mcp 401");
    return;
  }

  // Stateless: no server-initiated streams or sessions to resume.
  if (req.method !== "POST") {
    send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
    return;
  }

  // The client's self-reported name, for the Tokens page. Never logged.
  const init = body as { method?: unknown; params?: { clientInfo?: { name?: unknown } } } | null;
  if (bearer && init?.method === "initialize" && typeof init.params?.clientInfo?.name === "string") {
    await recordClient(bearer[1], init.params.clientInfo.name);
  }

  const mcp = new McpServer({ name: "reliquary", version: "0.1.0" });
  registerTools(mcp, identity);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    console.info(`mcp ${res.statusCode} user=${identity.userId.slice(0, 8)}`);
  } catch (err) {
    console.error("mcp error", (err as Error).name);
    if (!res.headersSent) send(res, 500, { error: "server_error" });
  }
});

// On Vercel (zero-config Node server) the platform supplies PORT and owns the
// socket, so bind no host; locally stay on loopback.
const onVercel = !!process.env.VERCEL;
httpServer.listen(PORT, onVercel ? undefined : HOST, () => {
  console.info(onVercel ? `reliquary mcp listening on port ${PORT}` : `reliquary mcp listening on http://${HOST}:${PORT}/mcp`);
});
