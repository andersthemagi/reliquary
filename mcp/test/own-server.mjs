// A server a test file starts for itself: dist/server.js on a free port, with
// a preload (node --import) that makes something observable or fail, which the
// shared test server must never do. Used by register_failure.test.mjs and
// link_lookup.test.mjs.

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// Resolves once /healthz answers. `log()` is everything the server has printed.
export async function startServer(preload, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL(preload, import.meta.url)), "dist/server.js"], {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return { origin, port, log: () => log, stop: () => child.kill() };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${log}`);
}

// One JSON-RPC message (or a batch) as Gus, who reads and writes every vault.
// A request the server never answers fails the test in seconds.
export const post = (origin, body) =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.GUS_RW}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
