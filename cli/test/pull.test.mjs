// The checks `env pull` makes before it writes (src/pull.ts): the target must
// be inside a git work tree and ignored there, and what it prints about the
// file must be true. Unit tests: they run git and nothing else (npm test).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CliError } from "../dist/errors.js";
import { checkTarget } from "../dist/pull.js";

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `pull-${p}-`));
function repo(gitignore) {
  const dir = tmp("repo");
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(path.join(dir, ".gitignore"), gitignore);
  return dir;
}

// git's own switch for "this repository belongs to someone else", the state
// of a bind-mounted checkout in a dev container or WSL.
function asSomeoneElsesRepo(fn) {
  const saved = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = saved;
  }
}

test("env pull git check: a repository git refuses to open is reported as git's refusal, and --outside-repo doesn't get past it", () => {
  const dir = repo(".env\n");
  const file = path.join(dir, ".env");
  asSomeoneElsesRepo(() => {
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
