// Setting up search by meaning (src/embeddings.ts, docs/ops/runbook.md
// "Search by meaning"): what a half-done setup does, and the probe a deploy
// checks (GET /healthz?embed=1, scripts/deploy-check.sh). v0.25.0's first
// deploy failed on the first of these: EMBED_URL reached Netlify without
// EMBED_SECRET, and the function never started.
//
// The servers here start from dist/ on free ports. The one that searches by
// meaning (MCP_SEM_URL, test.sh) holds the stand-in's secret; this file
// doesn't, so a server it starts against the stand-in holds the wrong one.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { after, test } from "node:test";

const { MCP_URL, MCP_SEM_URL, EMBED_DOUBLE_URL } = process.env;
const DEAD_DB = "postgres://reliquary_mcp:test@127.0.0.1:1/postgres";
const SECRET = "embed-setup-test-SECRETMARK";
const NO_EMBED = { EMBED_URL: "", EMBED_SECRET: "", EMBED_REGION: "", EMBED_MIN_SIMILARITY: "" };

const children = [];
after(() => children.forEach((c) => c.kill()));

function refused(env) {
  const r = spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, ...NO_EMBED, DATABASE_URL: DEAD_DB, PORT: "1", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, ...NO_EMBED, DATABASE_URL: DEAD_DB, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return { origin, log: () => log };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${log}`);
}

const probe = async (origin) => {
  const r = await fetch(`${origin}/healthz?embed=1`);
  return { status: r.status, body: await r.text() };
};
const functionAnswers = (status) =>
  fetch(`${EMBED_DOUBLE_URL}/_status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) => assert.equal(r.status, 200));

test("embed setup: EMBED_URL without EMBED_SECRET refuses to start, saying which is missing", () => {
  const r = refused({ EMBED_URL: "https://example.test/functions/v1/embed" });
  assert.equal(r.status, 1);
  assert.match(r.out, /Refusing to start: EMBED_URL is set but EMBED_SECRET is not/);
});

test("embed setup: an EMBED_URL that isn't http(s) refuses to start, never printing the secret", () => {
  const r = refused({ EMBED_URL: "example.test/embed", EMBED_SECRET: SECRET });
  assert.equal(r.status, 1);
  assert.match(r.out, /Refusing to start: EMBED_URL must be an http\(s\) URL/);
  assert.equal(r.out.includes("SECRETMARK"), false);
});

test("embed setup: an EMBED_MIN_SIMILARITY outside 0 to 1 refuses to start", () => {
  const r = refused({ EMBED_URL: "https://example.test/embed", EMBED_SECRET: SECRET, EMBED_MIN_SIMILARITY: "1.5" });
  assert.equal(r.status, 1);
  assert.match(r.out, /Refusing to start: EMBED_MIN_SIMILARITY must be a number from 0 to 1/);
});

test("embed setup: EMBED_SECRET alone starts, searching by words", async () => {
  const s = await startServer({ EMBED_SECRET: SECRET });
  assert.deepEqual(await probe(s.origin), { status: 200, body: "off" });
});

test("embed probe: a server without EMBED_URL answers off", async () => {
  assert.deepEqual(await probe(new URL(MCP_URL).origin), { status: 200, body: "off" });
});

test("embed probe: a secret that differs from the function's answers 503 saying so, never printing it", async () => {
  const s = await startServer({ EMBED_URL: `${EMBED_DOUBLE_URL}/`, EMBED_SECRET: SECRET });
  const r = await probe(s.origin);
  assert.deepEqual(r, { status: 503, body: "The embedding function answered 401: its EMBED_SECRET and this server's differ" });
  assert.equal(s.log().includes("SECRETMARK"), false);
});

test("embed probe: an unreachable function answers 503 saying so", async () => {
  const port = await freePort();
  const s = await startServer({ EMBED_URL: `http://127.0.0.1:${port}/`, EMBED_SECRET: SECRET });
  assert.deepEqual(await probe(s.origin), { status: 503, body: "The embedding function couldn't be reached" });
});

test("embed probe: a function that is down answers 503 with its status, and ok once it is back", async () => {
  const sem = new URL(MCP_SEM_URL).origin;
  await functionAnswers(503);
  try {
    assert.deepEqual(await probe(sem), { status: 503, body: "The embedding function answered 503" });
  } finally {
    await functionAnswers(200);
  }
  assert.deepEqual(await probe(sem), { status: 200, body: "ok" });
});
