// A form body over its limit (src/server.ts, readForm): answered 413 with the
// limit and a reference, on the sign-in forms too, which anyone can post to
// without a session. Uses the first Supabase-mode instance web/test.sh starts
// (PUBLIC_URL set, so a post must carry that origin).

import assert from "node:assert/strict";
import { test } from "node:test";

const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL } = process.env;
const ORIGIN = new URL(WEB_AUTH_PUBLIC_URL).origin;

const signIn = (body) =>
  fetch(`${A}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body,
  });

test("body limit: a sign-in form over 2 MB is answered 413 with the limit and a reference, not as a bug", async () => {
  const r = await signIn(`email=${"a".repeat(2 * 1024 * 1024 + 1)}`);
  assert.equal(r.status, 413);
  const text = await r.text();
  assert.match(text, /over 2 MB, so nothing was saved/);
  assert.match(text, /ref [0-9a-f]{8}/);
  assert.doesNotMatch(text, /a bug in Reliquary/);
});

test("body limit: the 413 closes the connection, which is what ends the upload", async () => {
  const r = await signIn(`email=${"a".repeat(2 * 1024 * 1024 + 1)}`);
  assert.equal(r.status, 413);
  assert.equal(r.headers.get("connection"), "close");
  await r.arrayBuffer();
});
