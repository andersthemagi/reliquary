// The checks `env pull` makes before it writes (src/pull.ts): the target must
// be inside a git work tree and ignored there, and what it prints about the
// file must be true. Unit tests: they run git and nothing else (npm test).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CliError } from "../dist/errors.js";
import { checkTarget, privacyNote } from "../dist/pull.js";

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `pull-${p}-`));
function repo(gitignore) {
  const dir = tmp("repo");
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(path.join(dir, ".gitignore"), gitignore);
  return dir;
}

// Runs fn with these variables set.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// What a person in a dev container or WSL gets: git won't open a repository
// that belongs to someone else, and says so with exit status 128, the same
// status as for "not a git repository".
function assertRefusedInGitsWords(dir) {
  const file = path.join(dir, ".env");
  for (const outsideRepo of [false, true]) {
    assert.throws(
      () => checkTarget(file, outsideRepo),
      (err) =>
        err instanceof CliError &&
        /dubious ownership/.test(err.message) &&
        /safe\.directory/.test(err.message) &&
        /Nothing was written/.test(err.message) &&
        !/isn't in a git repository|--outside-repo/.test(err.message),
    );
  }
}

test("env pull git check: a repository git refuses to open is reported as git's refusal, and --outside-repo doesn't get past it", { skip: process.platform === "win32" && "a shell script stands in for git" }, () => {
  const bin = tmp("fakegit");
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
echo "fatal: detected dubious ownership in repository at '$PWD'" >&2
echo "To add an exception for this directory, call:" >&2
echo "" >&2
echo "	git config --global --add safe.directory $PWD" >&2
exit 128
`,
  );
  chmodSync(path.join(bin, "git"), 0o755);
  withEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }, () => assertRefusedInGitsWords(tmp("fakerepo")));
});

test("env pull git check: the same with the real git, where it honours its own switch for a repository owned by someone else", (t) => {
  const dir = repo(".env\n");
  withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }, () => {
    if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).status === 0) {
      t.skip("this git ignores GIT_TEST_ASSUME_DIFFERENT_OWNER");
      return;
    }
    assertRefusedInGitsWords(dir);
  });
});

test("env pull git check: a directory outside any repository is still refused, and --outside-repo still allows it", () => {
  const dir = tmp("norepo");
  const file = path.join(dir, ".env");
  assert.throws(() => checkTarget(file, false), /isn't in a git repository.*--outside-repo/);
  assert.equal(checkTarget(file, true).abs, file);
});

test("env pull git check: an ignored file in a repository passes", () => {
  const dir = repo(".env\n");
  assert.equal(checkTarget(path.join(dir, ".env"), false).abs, path.join(dir, ".env"));
});

test("env pull privacy: says mode 600 only where the file really gets it, and on Windows says it keeps the folder's permissions", () => {
  assert.equal(privacyNote("linux"), "mode 600");
  assert.equal(privacyNote("darwin"), "mode 600");
  assert.doesNotMatch(privacyNote("win32"), /600|mode/);
  assert.match(privacyNote("win32"), /folder's permissions/);
});
