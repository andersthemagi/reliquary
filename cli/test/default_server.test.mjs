// The server the CLI talks to when nothing names one: the hosted app's own
// host (the OAuth issuer and the env API), not the public site's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SERVER, serverOrigin } from "../dist/config.js";

const APP = "https://app.reliquary.redmage.cc";

test("default server: with no --server, RELIQUARY_URL or .reliquary.json, the CLI uses the app host", () => {
  assert.equal(DEFAULT_SERVER, APP);
  const saved = process.env.RELIQUARY_URL;
  delete process.env.RELIQUARY_URL;
  try {
    assert.equal(serverOrigin(undefined, null), APP);
    assert.equal(serverOrigin(undefined, { file: "/x/.reliquary.json" }), APP);
  } finally {
    if (saved !== undefined) process.env.RELIQUARY_URL = saved;
  }
});

test("default server: the help names the app host as the default", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "cli-help-"));
  const env = { ...process.env, RELIQUARY_CONFIG_DIR: cwd };
  delete env.RELIQUARY_URL;
  const r = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "--help"], { cwd, env, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  assert.match(out, /else https:\/\/app\.reliquary\.redmage\.cc\)/);
});
