// `reliquary env push --wait` polls a push's status for up to a day
// (src/push.ts). One failed poll (a dropped connection, a 5xx, a rate limit)
// must not end the wait as if the push had been refused: the push is still
// pending, and a script that reads exit 1 as "rejected" may push it again.
// Unit tests against a stand-in server (npm test); the real server's side is
// in push.test.mjs.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const config = mkdtempSync(path.join(os.tmpdir(), "push-wait-"));
process.env.RELIQUARY_CONFIG_DIR = config;
process.env.RELIQUARY_CREDENTIALS = "file";

const { discover } = await import("../dist/config.js");
const { fileStore } = await import("../dist/credentials.js");
const { CliError, NotSignedIn } = await import("../dist/errors.js");
const { waitForDecision } = await import("../dist/push.js");
const { json, stubServer } = await import("./stub-server.mjs");

const ID = "11111111-1111-4111-8111-111111111111";
const FAST = { firstMs: 5, maxMs: 10 };

// What the stand-in answers to the next status polls, in order; "drop" cuts
// the connection, a number is an HTTP status, a string is a push's status.
let script = [];
let polls = 0;
let stub;
let server;

before(async () => {
  stub = await stubServer((req, res) => {
    if (req.method === "POST" && req.url === "/oauth/token") return json(res, 400, { error: "invalid_grant" });
    if (req.method !== "GET" || req.url !== `/api/env/imports/${ID}`) return false;
    polls++;
    const next = script.shift();
    if (next === "drop") return req.socket.destroy(), true;
    if (typeof next === "number") return json(res, next, { error: "server_error", message: "The database was busy.", where: "env API: database", ref: "7f3a2c9e" });
    return json(res, 200, { status: next });
  });
  server = await discover(stub.origin);
});

after(() => stub.close());

// Signed in afresh for every poll: a revoked connection is forgotten.
const poll = (answers, timeoutMs = 10_000) => {
  fileStore().set(stub.origin, { refreshToken: `rlr_${"a".repeat(64)}`, accessToken: `rle_${"b".repeat(64)}`, expiresAt: Date.now() + 3_600_000 });
  script = answers;
  polls = 0;
  return waitForDecision(server, ID, timeoutMs, FAST);
};

test("push wait: a failed status check is retried, and the decision that follows is reported", async () => {
  assert.equal(await poll([503, "drop", "pending", "applied"]), "applied");
  assert.equal(polls, 4);
  assert.equal(await poll([429, "rejected"]), "rejected");
});

test("push wait: failures that are not three in a row don't add up", async () => {
  assert.equal(await poll([503, 503, "pending", 503, 503, "expired"]), "expired");
  assert.equal(polls, 6);
});

test("push wait: three failed checks in a row stop the wait with exit 3, saying the push may still be pending and why the check failed", async () => {
  await assert.rejects(
    poll([503, 502, "drop", "applied"]),
    (err) =>
      err instanceof CliError &&
      err.exitCode === 3 &&
      /Couldn't check whether the push was applied \(3 tries in a row\)/.test(err.message) &&
      /Couldn't reach/.test(err.message) &&
      /may still be waiting for approval/.test(err.message),
  );
  assert.equal(polls, 3, "it stopped there");
});

test("push wait: a server error's reason is passed on", async () => {
  await assert.rejects(poll([500, 500, 500]), (err) => err.exitCode === 3 && /The server says: The database was busy\./.test(err.message) && /ref 7f3a2c9e/.test(err.message));
});

test("push wait: a connection that is no longer accepted is not retried; it needs a person", async () => {
  await assert.rejects(poll([401, 401, "applied"]), (err) => err instanceof NotSignedIn && err.exitCode === 1);
});

test("push wait: running out of time is still 'pending', not a failure", async () => {
  assert.equal(await poll(Array(100).fill("pending"), 80), "pending");
});
