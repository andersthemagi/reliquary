// Discovery (web/src/discovery.ts): the MCP handshake used to populate a
// link's tools, and the address safety it shares with cimd.ts (the
// blocklist itself is cimd.test.mjs's; this file proves discoverTools
// actually applies it). Runs the compiled module directly against a fixture
// MCP server on loopback; `resolve` stands in for DNS the same way
// cimd.test.mjs's does.

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { DiscoveryError, discoverTools } from "../dist/discovery.js";

let fixture;
let base = "";
let handler = null;

before(async () => {
  fixture = http.createServer(async (req, res) => {
    if (!handler) return res.writeHead(404).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return res.writeHead(400).end();
    }
    handler(body, req, res);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${fixture.address().port}/mcp`;
});
after(() => {
  fixture.closeAllConnections();
  fixture.close();
});
beforeEach(() => {
  handler = null;
});

const loopbackOk = { allowLoopback: true };
const refusedWith = (re) => (err) => err instanceof DiscoveryError && re.test(err.message);
const to = (...addresses) => ({ resolve: async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) });

const rpc = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const rpcErr = (id, message) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const sse = (id, result) => `event: message\ndata: ${rpc(id, result)}\n\n`;

// A standards-shaped fixture: initialize, the initialized notification, then
// tools/list (paged if `pages` has more than one entry). `format` picks
// plain JSON or a minimal SSE body for every response.
function standardMcp({ tools = [], pages, sessionId, protocolVersion, format = "json" } = {}) {
  const pageList = pages ?? [tools];
  const send = (res, id, result) => {
    if (format === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(id, result));
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(rpc(id, result));
    }
  };
  return (body, req, res) => {
    if (body.method === "initialize") {
      const headers = sessionId ? { "mcp-session-id": sessionId } : {};
      res.writeHead(200, { "content-type": "application/json", ...headers }).end(
        rpc(body.id, { protocolVersion: protocolVersion ?? body.params.protocolVersion, capabilities: {}, serverInfo: { name: "Fixture", version: "0" } }),
      );
    } else if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (body.method === "tools/list") {
      const cursor = body.params?.cursor;
      const index = cursor ? Number(cursor) : 0;
      const page = pageList[index] ?? [];
      const nextCursor = index + 1 < pageList.length ? String(index + 1) : undefined;
      send(res, body.id, { tools: page, ...(nextCursor ? { nextCursor } : {}) });
    } else {
      res.writeHead(404).end();
    }
  };
}

// ---------------------------------------------------------------------------
// Address safety (the blocklist itself is cimd.test.mjs's; this proves
// discoverTools applies it)

test("ssrf: a name that resolves to a private address is refused before connecting", async () => {
  await assert.rejects(discoverTools("https://upstream.example/mcp", "cred", to("10.0.0.5")), refusedWith(/isn’t public/));
});

test("ssrf: an IP literal is checked too", async () => {
  await assert.rejects(discoverTools("https://169.254.169.254/mcp", "cred"), refusedWith(/isn’t public/));
});

test("ssrf: plain http is refused, even to a public-looking name", async () => {
  await assert.rejects(discoverTools("http://upstream.example/mcp", "cred"), refusedWith(/must be https/));
});

test("ssrf: loopback over http is refused without the test allowance", async () => {
  handler = standardMcp({ tools: [] });
  await assert.rejects(discoverTools(base, "cred"), refusedWith(/must be https/));
});

test("ssrf: not a URL at all is refused", async () => {
  await assert.rejects(discoverTools("not a url", "cred"), refusedWith(/isn’t a URL/));
});

// ---------------------------------------------------------------------------
// The handshake and tool listing

test("handshake: a read-only tool and a plain tool are classified from readOnlyHint alone", async () => {
  handler = standardMcp({
    tools: [
      { name: "list_issues", description: "List issues", annotations: { readOnlyHint: true } },
      { name: "create_issue", description: "Create an issue" },
      { name: "archive_issue", annotations: { readOnlyHint: false, destructiveHint: true } },
    ],
  });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(tools, [
    { name: "list_issues", isWrite: false, description: "List issues" },
    { name: "create_issue", isWrite: true, description: "Create an issue" },
    { name: "archive_issue", isWrite: true, description: null },
  ]);
});

test("handshake: the credential is sent as a bearer token, never anything else", async () => {
  let seen;
  handler = (body, req, res) => {
    seen ??= req.headers.authorization;
    standardMcp({ tools: [] })(body, req, res);
  };
  await discoverTools(base, "s3cr3t-value", loopbackOk);
  assert.equal(seen, "Bearer s3cr3t-value");
});

test("handshake: the session id from initialize rides on the later calls; without one, none is sent", async () => {
  const seen = [];
  handler = (body, req, res) => {
    seen.push([body.method, req.headers["mcp-session-id"] ?? null]);
    standardMcp({ tools: [], sessionId: "sess-123" })(body, req, res);
  };
  await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(seen, [
    ["initialize", null],
    ["notifications/initialized", "sess-123"],
    ["tools/list", "sess-123"],
  ]);
});

test("handshake: tools/list is paged until nextCursor stops", async () => {
  handler = standardMcp({ pages: [[{ name: "a" }, { name: "b" }], [{ name: "c" }]] });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(tools.map((t) => t.name), ["a", "b", "c"]);
});

test("handshake: a response over Server-Sent Events is read the same as plain JSON", async () => {
  handler = standardMcp({ tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }], format: "sse" });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(tools, [{ name: "list_issues", isWrite: false, description: null }]);
});

test("handshake: a malformed tool entry is skipped, not fatal to the rest", async () => {
  handler = standardMcp({ tools: [{ name: "" }, { no_name: true }, "not an object", { name: "ok_one" }] });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(tools.map((t) => t.name), ["ok_one"]);
});

test("handshake: duplicate names across pages count once", async () => {
  handler = standardMcp({ pages: [[{ name: "dup" }], [{ name: "dup" }, { name: "new" }]] });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.deepEqual(tools.map((t) => t.name), ["dup", "new"]);
});

test("handshake: an https url pointed at loopback is still served over plain http (tests only, links_page.test.mjs relies on this: a link's url is always https, with no test bypass at the database layer)", async () => {
  handler = standardMcp({ tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }] });
  const tools = await discoverTools(base.replace("http://", "https://"), "cred", loopbackOk);
  assert.deepEqual(tools, [{ name: "list_issues", isWrite: false, description: null }]);
});

test("handshake: the same https-scheme loopback url is refused as ordinary https without the test allowance", async () => {
  handler = standardMcp({ tools: [] });
  await assert.rejects(discoverTools(base.replace("http://", "https://"), "cred"), refusedWith(/isn’t public/));
});

test("handshake: more than 500 tools is capped, not refused", async () => {
  handler = standardMcp({ tools: Array.from({ length: 600 }, (_, i) => ({ name: `t${i}` })) });
  const tools = await discoverTools(base, "cred", loopbackOk);
  assert.equal(tools.length, 500);
});

// ---------------------------------------------------------------------------
// Failure

test("failure: a JSON-RPC error from the server is surfaced, capped in length", async () => {
  handler = (body, req, res) => {
    if (body.method === "tools/list") return res.writeHead(200, { "content-type": "application/json" }).end(rpcErr(body.id, "no such method here"));
    standardMcp({ tools: [] })(body, req, res);
  };
  await assert.rejects(discoverTools(base, "cred", loopbackOk), refusedWith(/no such method here/));
});

test("failure: a non-2xx status on the handshake is refused", async () => {
  handler = (body, req, res) => res.writeHead(401).end();
  await assert.rejects(discoverTools(base, "cred", loopbackOk), refusedWith(/refused/));
});

test("failure: a redirect is refused, not followed", async () => {
  handler = (body, req, res) => res.writeHead(302, { location: base }).end();
  await assert.rejects(discoverTools(base, "cred", loopbackOk), refusedWith(/redirect/));
});

test("failure: a response over the size cap is refused", async () => {
  handler = (body, req, res) => {
    if (body.method !== "tools/list") return standardMcp({ tools: [] })(body, req, res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpc(body.id, { tools: [{ name: "big", description: "x".repeat(300 * 1024) }] }));
  };
  await assert.rejects(discoverTools(base, "cred", loopbackOk), refusedWith(/too large/));
});

test("failure: a server that never answers is given up on", async () => {
  handler = () => {};
  await assert.rejects(discoverTools(base, "cred", { ...loopbackOk, timeoutMs: 300 }), refusedWith(/too long/));
});

test("failure: an unexpected content type is refused", async () => {
  handler = (body, req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("nope");
  await assert.rejects(discoverTools(base, "cred", loopbackOk), refusedWith(/unexpected content type/));
});
