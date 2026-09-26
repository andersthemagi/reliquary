// The CLI explains the env API's rate limit instead of a bare error.

import assert from "node:assert/strict";
import { test } from "node:test";
import { rateLimited } from "../dist/api.js";

test("rate limited: 429 rate_limited names the wait from Retry-After", () => {
  assert.equal(rateLimited(429, { error: "rate_limited" }, "42"), "Too many requests from this connection; the server asks to try again in 42 seconds.");
  assert.equal(rateLimited(429, { error: "rate_limited" }, "1"), "Too many requests from this connection; the server asks to try again in 1 second.");
});

test("rate limited: a missing or odd Retry-After says later; other answers are not rate limits", () => {
  for (const h of [null, "", "soon", "-5", "0", "999999"]) {
    assert.match(rateLimited(429, { error: "rate_limited" }, h), /try again later\.$/);
  }
  assert.equal(rateLimited(429, { error: "too_many_pending" }, "5"), null);
  assert.equal(rateLimited(403, { error: "rate_limited" }, "5"), null);
  assert.equal(rateLimited(200, null, null), null);
});
