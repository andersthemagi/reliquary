// Client ID Metadata Document fetching (web/src/cimd.ts): the SSRF fence
// around a URL any client can make us fetch, and redirect URI matching.
// Runs the compiled module directly. A fixture server on loopback stands in
// for client sites; `resolve` stands in for DNS, so a name can be made to
// point anywhere without touching the network.

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { addressAllowed, CimdError, fetchClientMetadata, MAX_BYTES, redirectAllowed } from "../dist/cimd.js";

let fixture;
let base = "";
const routes = new Map();

before(async () => {
  fixture = http.createServer((req, res) => {
    const handler = routes.get(req.url);
    if (!handler) return res.writeHead(404).end();
    handler(req, res);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${fixture.address().port}`;
});
after(() => {
  fixture.closeAllConnections();
  fixture.close();
});

const doc = (clientId, extra = {}) =>
  JSON.stringify({ client_id: clientId, client_name: "Fixture", redirect_uris: ["https://app.client.test/cb"], ...extra });
function serve(path, body, headers = { "content-type": "application/json" }, status = 200) {
  routes.set(path, (_req, res) => res.writeHead(status, headers).end(body));
  return `${base}${path}`;
}
const loopbackOk = { allowLoopback: true };
const refusedWith = (re) => (err) => err instanceof CimdError && re.test(err.message);
const to = (...addresses) => ({ resolve: async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) });

// ---------------------------------------------------------------------------
// Addresses

test("ssrf: private, loopback, link-local and other non-public addresses are refused", () => {
  for (const ip of [
    "10.0.0.5", "172.16.3.4", "192.168.1.1", "127.0.0.1", "127.8.9.10", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1",
  ]) {
    assert.equal(addressAllowed(ip), false, ip);
  }
});

test("ssrf: public addresses are allowed", () => {
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
    assert.equal(addressAllowed(ip), true, ip);
  }
});

test("ssrf: the test-only loopback allowance opens loopback and nothing else", () => {
  assert.equal(addressAllowed("127.0.0.1", true), true);
  assert.equal(addressAllowed("::1", true), true);
  for (const ip of ["10.0.0.5", "169.254.169.254", "192.168.1.1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(addressAllowed(ip, true), false, ip);
  }
});

test("ssrf: a name that resolves to a private address is refused before connecting", async () => {
  for (const ip of ["10.0.0.5", "192.168.1.1", "172.16.0.1", "100.64.0.1"]) {
    await assert.rejects(fetchClientMetadata("https://client.example/meta.json", to(ip)), refusedWith(/isn’t public/), ip);
  }
});

test("ssrf: a name that resolves to loopback or link-local is refused", async () => {
  for (const ip of ["127.0.0.1", "::1", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(fetchClientMetadata("https://client.example/meta.json", to(ip)), refusedWith(/isn’t public/), ip);
  }
});

test("ssrf: one private address among public ones is enough to refuse", async () => {
  await assert.rejects(
    fetchClientMetadata("https://client.example/meta.json", to("93.184.216.34", "10.0.0.5")),
    refusedWith(/isn’t public/),
  );
});

test("ssrf: IP literals are checked too (Node skips DNS for them)", async () => {
  for (const id of [
    "https://127.0.0.1/meta.json", "https://10.1.2.3/meta.json", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/meta.json", "https://[fe80::1]/meta.json", "https://[::ffff:7f00:1]/meta.json",
  ]) {
    await assert.rejects(fetchClientMetadata(id), refusedWith(/isn’t public/), id);
  }
});

test("ssrf: localhost is loopback, refused without the test allowance", async () => {
  await assert.rejects(fetchClientMetadata("https://localhost/meta.json"), refusedWith(/isn’t public/));
});

test("ssrf: the socket connects to the address that was checked", async () => {
  // The same name, resolved two ways by our resolver: it is what the socket
  // uses, whatever the system's DNS says about localhost.
  const port = new URL(base).port;
  const id = `http://localhost:${port}/pointed.json`;
  serve("/pointed.json", doc(id));
  const meta = await fetchClientMetadata(id, { allowLoopback: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  assert.equal(meta.clientName, "Fixture");
  await assert.rejects(
    fetchClientMetadata(id, { allowLoopback: true, resolve: async () => [{ address: "10.0.0.1", family: 4 }] }),
    refusedWith(/isn’t public/),
  );
});

// ---------------------------------------------------------------------------
// The client id URL

test("client id: must be https (plain http only to loopback, only in tests)", async () => {
  await assert.rejects(fetchClientMetadata("http://client.example/meta.json"), refusedWith(/https/));
  await assert.rejects(fetchClientMetadata(`${base}/whatever.json`), refusedWith(/https/));
  await assert.rejects(fetchClientMetadata("ftp://client.example/meta.json"), refusedWith(/https/));
});

test("client id: fragments, credentials, dot segments, a bare origin or a non-URL are refused", async () => {
  for (const id of [
    "https://client.example/meta.json#x", "https://client.example/meta.json#", "https://user:pw@client.example/meta.json",
    "https://client.example/a/../meta.json", "https://client.example/", "https://client.example", "https://CLIENT.example/m.json",
    "not a url", "", "x".repeat(3000),
  ]) {
    await assert.rejects(fetchClientMetadata(id, to("93.184.216.34")), CimdError, id);
  }
});

// ---------------------------------------------------------------------------
// The response

test("fetch: a good document is read, with the client's name cleaned", async () => {
  const id = serve("/good.json", "");
  serve("/good.json", doc(id, { client_name: "  Fixture\u0000 App\u202e  " }));
  const meta = await fetchClientMetadata(id, loopbackOk);
  assert.deepEqual(meta, { clientId: id, clientName: "Fixture App", redirectUris: ["https://app.client.test/cb"] });
});

test("fetch: redirects are refused, not followed", async () => {
  const target = serve("/target.json", "");
  serve("/target.json", doc(target));
  for (const status of [301, 302, 303, 307, 308]) {
    const id = `${base}/moved-${status}.json`;
    serve(`/moved-${status}.json`, "", { location: target }, status);
    await assert.rejects(fetchClientMetadata(id, loopbackOk), refusedWith(/redirect/), String(status));
  }
});

test("fetch: a document over 5 KB is refused, declared or streamed", async () => {
  const idBig = `${base}/big.json`;
  const big = doc(idBig, { padding: "x".repeat(MAX_BYTES) });
  serve("/big.json", big, { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) });
  await assert.rejects(fetchClientMetadata(idBig, loopbackOk), refusedWith(/too large/));

  const idStream = `${base}/stream.json`;
  routes.set("/stream.json", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write(doc(idStream).slice(0, -1));
    res.write(`, "padding": "${"y".repeat(MAX_BYTES)}"}`);
    res.end();
  });
  await assert.rejects(fetchClientMetadata(idStream, loopbackOk), refusedWith(/too large/));
});

test("fetch: a document naming another client_id is refused", async () => {
  const id = serve("/mismatch.json", doc("https://someone-else.example/meta.json"));
  await assert.rejects(fetchClientMetadata(id, loopbackOk), refusedWith(/different client id/));
  const trailing = `${base}/slash.json`;
  serve("/slash.json", doc(`${trailing}/`));
  await assert.rejects(fetchClientMetadata(trailing, loopbackOk), refusedWith(/different client id/));
});

test("fetch: not JSON, not an object, or no usable redirect URIs is refused", async () => {
  const html = serve("/html.json", "<html></html>", { "content-type": "text/html" });
  await assert.rejects(fetchClientMetadata(html, loopbackOk), refusedWith(/isn’t JSON/));
  const bad = serve("/bad.json", "{nope", { "content-type": "application/json" });
  await assert.rejects(fetchClientMetadata(bad, loopbackOk), refusedWith(/isn’t JSON/));
  const arr = serve("/arr.json", "[]");
  await assert.rejects(fetchClientMetadata(arr, loopbackOk), refusedWith(/object/));
  for (const [i, uris] of [[], ["javascript:alert(1)"], ["https://a.test/cb#frag"], ["http://evil.test/cb"], "https://a.test/cb"].entries()) {
    const id = `${base}/uris-${i}.json`;
    serve(`/uris-${i}.json`, doc(id, { redirect_uris: uris }));
    await assert.rejects(fetchClientMetadata(id, loopbackOk), refusedWith(/redirect URIs/), JSON.stringify(uris));
  }
});

test("fetch: a confidential client (with a secret) is refused", async () => {
  const id = `${base}/secret.json`;
  serve("/secret.json", doc(id, { token_endpoint_auth_method: "client_secret_basic" }));
  await assert.rejects(fetchClientMetadata(id, loopbackOk), refusedWith(/public clients/));
});

test("fetch: a server that never answers is given up on", async () => {
  routes.set("/slow.json", () => {});
  await assert.rejects(fetchClientMetadata(`${base}/slow.json`, { allowLoopback: true, timeoutMs: 300 }), refusedWith(/too long/));
});

// ---------------------------------------------------------------------------
// Redirect URIs

const meta = { clientId: "https://c.test/m.json", clientName: "C", redirectUris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1/callback"] };

test("redirect: an exact registered URI matches", () => {
  assert.equal(redirectAllowed(meta, "https://claude.ai/api/mcp/auth_callback"), true);
});

test("redirect: anything else is refused (host, path, port, query, case, fragment)", () => {
  for (const r of [
    "https://evil.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/", "https://claude.ai:8443/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback?x=1", "https://Claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback#f",
    "http://claude.ai/api/mcp/auth_callback", "", "not a url",
  ]) {
    assert.equal(redirectAllowed(meta, r), false, r);
  }
});

test("redirect: a loopback URI matches on any port, same host and path only", () => {
  assert.equal(redirectAllowed(meta, "http://localhost:53124/callback"), true);
  assert.equal(redirectAllowed(meta, "http://127.0.0.1:1/callback"), true);
  assert.equal(redirectAllowed(meta, "http://127.0.0.1:53124/other"), false);
  assert.equal(redirectAllowed(meta, "http://127.0.0.1:53124/callback?x=1"), false);
  assert.equal(redirectAllowed(meta, "http://[::1]:53124/callback"), false);
  assert.equal(redirectAllowed(meta, "https://127.0.0.1:53124/callback"), false);
  assert.equal(redirectAllowed(meta, "http://user@127.0.0.1:53124/callback"), false);
  assert.equal(redirectAllowed({ ...meta, redirectUris: ["https://claude.ai/cb"] }, "http://127.0.0.1:5000/cb"), false);
});
