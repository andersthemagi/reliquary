// Mistyped commands and options get a hint toward the one meant. Parsing
// fails before any network call, so these need no server.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const cwd = mkdtempSync(path.join(os.tmpdir(), "cli-usage-"));
const cli = (...args) => spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], { cwd, env: { ...process.env, RELIQUARY_CONFIG_DIR: cwd }, encoding: "utf8" });

test("usage: top-level pull and push point to `reliquary env pull` and `env push`, exit 2", () => {
  for (const sub of ["pull", "push"]) {
    const r = cli(sub);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`Unknown command "${sub}"\\. Did you mean \`reliquary env ${sub}\`\\?`));
  }
});

test("usage: a command within two edits of a real one suggests it, exit 2", () => {
  const r = cli("vault");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command "vault"\. Did you mean "vaults"\?/);
});

test("usage: a command nothing is close to gets no suggestion", () => {
  const r = cli("frobnicate");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});

test("usage: --environment suggests --env, exit 2", () => {
  const r = cli("run", "--environment", "production", "--", "x");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option --environment\. Did you mean --env\?/);
});

test("usage: a mistyped option suggests the closest one that command accepts", () => {
  assert.match(cli("run", "--vualt", "a", "--", "x").stderr, /Did you mean --vault\?/);
  // `vaults` takes no --vault, so nothing is suggested.
  const r = cli("vaults", "--vualt", "a");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});
