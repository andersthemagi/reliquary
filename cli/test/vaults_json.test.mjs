// `reliquary vaults --json`: the vault list for scripts, since a vault's
// name may hold spaces, colons and parentheses that the plain line can't
// be split on. Against a stand-in server (npm test).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const config = mkdtempSync(path.join(os.tmpdir(), "vaults-json-"));
process.env.RELIQUARY_CONFIG_DIR = config;
process.env.RELIQUARY_CREDENTIALS = "file";

const { fileStore } = await import("../dist/credentials.js");
const { json, stubServer } = await import("./stub-server.mjs");

const VAULT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme: site (v2)", role: "owner", environments: ["development", "production"] };
let answer;
let stub;

before(async () => {
  stub = await stubServer((req, res) => req.method === "GET" && req.url === "/api/env/vaults" && json(res, 200, { vaults: answer }));
  fileStore().set(stub.origin, { refreshToken: `rlr_${"a".repeat(64)}`, accessToken: `rle_${"b".repeat(64)}`, expiresAt: Date.now() + 3_600_000 });
});

after(() => stub.close());

// Async, so the stand-in in this process can answer while the CLI runs.
const vaults = async () => {
  try {
    const r = await promisify(execFile)(process.execPath, [path.resolve("dist/cli.js"), "vaults", "--json", "--server", stub.origin], { cwd: config });
    return { code: 0, ...r };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
};

test("vaults json: --json prints {vaults} as one JSON line on stdout and nothing on stderr", async () => {
  answer = [VAULT];
  const r = await vaults();
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.ok(r.stdout.endsWith("}\n"));
  assert.deepEqual(JSON.parse(r.stdout), { vaults: [VAULT] });
});

test("vaults json: no vaults is an empty list, exit 0", async () => {
  answer = [];
  const r = await vaults();
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, '{"vaults":[]}\n');
});
