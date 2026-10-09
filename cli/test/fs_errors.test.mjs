// A file or folder the system won't let the CLI use is a problem with the
// computer, not a bug in the CLI, and is said that way: what it was doing,
// which path, why, what to do (AGENTS.md: never ship a generic error).
// Unit tests: no database (npm test).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CliError, fsFailure } from "../dist/errors.js";
import { writePrivate } from "../dist/pull.js";
import { stubServer } from "./stub-server.mjs";

const CLI = path.resolve("dist/cli.js");
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `fs-${p}-`));

function runCli(args, { env = {}, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], {
    env: { ...process.env, RELIQUARY_CREDENTIALS: "file", RELIQUARY_NO_BROWSER: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.resume();
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
}

test("fs errors: each code says why and what to do, and never repeats the system's own text", () => {
  const e = (code) => Object.assign(new Error("SEKRIT from the system"), { code });
  assert.equal(
    fsFailure("write", "/p/.env", e("EACCES")).message,
    "Couldn't write /p/.env (EACCES): you don't have permission. Check who owns it and its folder, and that you may change them.",
  );
  assert.match(fsFailure("write", "/p/.env", e("ENOSPC")).message, /\(ENOSPC\): the disk is full\. Free some space/);
  assert.match(fsFailure("write", "/p/.env", e("EROFS")).message, /\(EROFS\): the file system is read-only\./);
  assert.match(fsFailure("read", "/p/f", e("EISDIR")).message, /\(EISDIR\): it is a folder, not a file\./);
  assert.match(fsFailure("read", "/p/f", e("EWEIRD")).message, /\(EWEIRD\): the system answered EWEIRD\. Check the path and its permissions\./);
  assert.match(fsFailure("read", "/p/f", new Error("SEKRIT")).message, /\(no error code\): the system refused it\./);
  assert.equal(fsFailure("save", "/c", e("EACCES"), "Set X.").message.endsWith("(EACCES): you don't have permission. Set X."), true, "a caller's hint replaces the generic advice");
  for (const code of ["EACCES", "ENOSPC", "EWEIRD", undefined]) assert.doesNotMatch(fsFailure("write", "/p", e(code)).message, /SEKRIT/);
  assert.ok(fsFailure("write", "/p", e("EACCES")) instanceof CliError);
});

test("fs errors: a config directory that can't be created says so, with the variable that moves it, instead of 'a bug in the CLI'", async () => {
  const stub = await stubServer();
  try {
    const blocker = path.join(tmp("blocker"), "a-file");
    writeFileSync(blocker, "not a folder");
    const r = await runCli(["logout", "--server", stub.origin], { env: { RELIQUARY_CONFIG_DIR: path.join(blocker, "reliquary") } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /^reliquary: Couldn't create .*a-file.reliquary \(E[A-Z]+\): .*RELIQUARY_CONFIG_DIR/m);
    assert.doesNotMatch(r.stderr, /bug in the CLI/);
  } finally {
    await stub.close();
  }
});

test("fs errors: a file that can't be written is named with the reason, whether it is written in place or through a temporary file", () => {
  const gone = path.join(tmp("gone"), "missing", ".env");
  for (const target of [{ abs: gone, tmp: null }, { abs: gone, tmp: `${gone}.reliquary-1.tmp` }]) {
    assert.throws(
      () => writePrivate(target, "A=1\n"),
      (err) => err instanceof CliError && err.message.startsWith(`Couldn't write ${gone} (ENOENT): a folder in that path doesn't exist.`),
    );
  }
});

test("fs errors: an unexpected file error still isn't called a bug in the CLI; it names the operation, the path and the code", async () => {
  const preload = path.join(tmp("preload"), "boom.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.existsSync = () => { throw Object.assign(new Error("SEKRIT from the system"), { code: "EACCES", syscall: "stat", path: "/some/where" }); };
syncBuiltinESMExports();
`,
  );
  const r = await runCli(["vaults"], { nodeArgs: ["--import", pathToFileURL(preload).href] });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^reliquary: Couldn't stat \/some\/where \(EACCES\): you don't have permission\./m);
  assert.doesNotMatch(r.stderr, /bug in the CLI|SEKRIT/);
});

