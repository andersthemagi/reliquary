// The CLI's side of the error model (docs/public/reference/errors.md): the
// server's reason, component and reference are printed when it sends them,
// and a request that never got an answer says which host and what failed.

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { failureMessage } from "../dist/api.js";
import { getJson, networkReason } from "../dist/config.js";
import { CliError, serverSays } from "../dist/errors.js";

const BODY = {
  error: "server_error",
  message: "Reading development in vault 1a2b3c4d failed: 57014 statement timeout: the query ran past the database’s time limit and was stopped.",
  where: "env API: database",
  ref: "7f3a2c9e",
};

test("errors: the server's reason, where and reference are printed with what the CLI was doing", () => {
  const m = failureMessage(504, BODY, "development in Team");
  assert.match(m, /^Reading development in Team failed: the server answered 504 \(server_error\)\./);
  assert.match(m, /The server says: Reading development in vault 1a2b3c4d failed: 57014 statement timeout/);
  assert.match(m, /\(where: env API: database; ref 7f3a2c9e\)$/);
  assert.doesNotMatch(m, /[Tt]ry again later/);
  // Pushes say so.
  assert.match(failureMessage(502, BODY, "development in Team", "Sending values to"), /^Sending values to development in Team failed/);
});

test("errors: an answer with no reason says so instead of a bare status", () => {
  const m = failureMessage(502, null, "your vaults");
  assert.equal(m, "Reading your vaults failed: the server answered 502. It sent no reason; it may not be a Reliquary server, or a proxy in front of it answered.");
});

test("errors: the server's words are shown as plain text, capped, and a malformed ref is left out", () => {
  const RLO = String.fromCodePoint(0x202e);
  const s = serverSays({ message: `bad${String.fromCodePoint(0x1b)}[31m${RLO} thing`, where: "x".repeat(500), ref: "NOT-A-REF" });
  assert.equal(s.includes(String.fromCodePoint(0x1b)) || s.includes(RLO), false);
  assert.match(s, /where: x{120}\)$/);
  assert.doesNotMatch(s, /NOT-A-REF/);
  assert.equal(serverSays({ error: "forbidden" }), "");
  assert.equal(serverSays(null), "");
  // OAuth's error_description counts as the reason.
  assert.match(serverSays({ error: "invalid_grant", error_description: "Refreshing a sign-in failed: revoked", where: "OAuth", ref: "0123abcd" }), /revoked\. \(where: OAuth; ref 0123abcd\)$/);
});

test("errors: a refused connection names the host, the request and ECONNREFUSED", async () => {
  // A port nothing listens on: bind one, then close it.
  const port = await new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await assert.rejects(getJson(`http://127.0.0.1:${port}/api/env/vaults`), (err) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.message, `Couldn't reach 127.0.0.1:${port} (GET /api/env/vaults): the connection was refused (ECONNREFUSED): nothing is listening there. Check the server address and your connection.`);
    return true;
  });
});

test("errors: DNS, TLS and timeouts are told apart by their codes, never by a message", () => {
  assert.equal(networkReason({ cause: { code: "ENOTFOUND", message: "SEKRIT" } }), "the DNS lookup found no such host (ENOTFOUND)");
  assert.equal(networkReason({ cause: { code: "CERT_HAS_EXPIRED" } }), "the TLS certificate check failed (CERT_HAS_EXPIRED)");
  assert.equal(networkReason({ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }), "the TLS certificate check failed (ERR_TLS_CERT_ALTNAME_INVALID)");
  assert.equal(networkReason({ name: "TimeoutError" }), "no answer within 30 seconds (timeout)");
  assert.equal(networkReason({ cause: { code: "ECONNRESET" } }), "the connection was reset (ECONNRESET)");
  assert.equal(networkReason({ cause: { code: "EWHATEVER" } }), "the request failed (EWHATEVER)");
  assert.equal(networkReason(new TypeError("fetch failed: SEKRIT")), "the request failed (TypeError, no error code)");
});

