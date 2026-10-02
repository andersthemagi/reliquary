// Shared end-to-end harness for the CLI test suites (cli.test.mjs,
// push.test.mjs): spawn the built CLI binary, read the database as a given
// user, wait on its output, and check that nothing secret leaked into it.
// Extracted from both files hand-rolling the same thing (ponytail-audit,
// 2026-10). createHarness(marker) takes each suite's own secret-value
// prefix (SEKRIT- in cli.test.mjs, PUSHVAL- in push.test.mjs), the one real
// difference between them; `page` still needs each file's own `cookie`
// variable, so it takes it as a second argument instead of closing over it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export function createHarness(marker) {
  const WEB = process.env.WEB_URL ?? "http://127.0.0.1:8796";
  const WEB_BUILD = process.env.WEB_BUILD ?? "/work/web";
  const CLI = path.resolve("dist/cli.js");
  const pg = createRequire(path.join(WEB_BUILD, "package.json"))("pg");

  const secrets = new Set();
  function record(...xs) {
    for (const x of xs) {
      if (typeof x !== "string" || x.length < 8 || secrets.has(x)) continue;
      secrets.add(x);
      appendFileSync(process.env.SECRETS_FILE ?? "/tmp/cli-test-secrets", `${x}\n`);
    }
  }
  const value = (label) => {
    const v = `${marker}-${label}-${randomBytes(6).toString("hex")}`;
    record(v);
    return v;
  };
  const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

  async function as(user, q, params = []) {
    const db = new pg.Client({ connectionString: process.env.PG_URL });
    await db.connect();
    try {
      await db.query("begin");
      if (user) {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
      }
      const { rows } = await db.query(q, params);
      await db.query("commit");
      return rows;
    } finally {
      await db.end();
    }
  }

  const outputs = []; // every CLI stdout and stderr

  function start(args, { config, cwd, env = {}, server = true } = {}) {
    const childEnv = { ...process.env, RELIQUARY_CONFIG_DIR: config ?? tmp("cfg"), RELIQUARY_NO_BROWSER: "1", ...env };
    delete childEnv.RELIQUARY_URL;
    if (server) childEnv.RELIQUARY_URL = WEB;
    for (const k of ["VARIABLES_KEY", "PG_URL", "WEB_DB_URL", "DATABASE_URL"]) delete childEnv[k];
    const child = spawn(process.execPath, [CLI, ...args], { cwd: cwd ?? tmp("cwd"), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const r = { child, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (r.stdout += d));
    child.stderr.on("data", (d) => (r.stderr += d));
    r.done = new Promise((resolve) =>
      child.on("close", (code, signal) => {
        outputs.push(r.stdout, r.stderr);
        resolve({ code, signal, stdout: r.stdout, stderr: r.stderr });
      }),
    );
    return r;
  }
  const cli = (args, opts) => start(args, opts).done;

  async function waitFor(r, stream, re, ms = 15000) {
    const until = Date.now() + ms;
    for (;;) {
      const m = re.exec(r[stream]);
      if (m) return m;
      if (Date.now() > until) throw new Error(`timed out waiting for ${re} in ${stream}: ${r[stream]}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  // No value, token or code in anything the CLI printed.
  function assertClean(...texts) {
    for (const t of texts) {
      assert.doesNotMatch(t, new RegExp(`${marker}|SEKRIT|rl[ecrq]_[0-9a-f]{8}`), "a value or token in CLI output");
      for (const s of secrets) assert.ok(!t.includes(s), "a recorded secret in CLI output");
    }
  }

  const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
  // Takes the caller's own `cookie` explicitly: it changes as each file
  // signs in and revokes, and belongs to the test file, not this harness.
  const page = (p, cookie) => fetch(new URL(p, WEB), { headers: { cookie }, redirect: "manual" });

  return { record, value, tmp, as, start, cli, waitFor, assertClean, csrfOf, page, outputs };
}
