// On Windows a program started by bare name is looked up in the working
// directory before PATH (libuv's search order, like CreateProcess). The CLI
// starts two programs by name besides the user's command: `git`, with the
// repository about to be inspected as its working directory, and the browser
// opener. A `git.exe` committed to a repository must not run when someone
// pulls there, so both are named by absolute path or found on PATH only, as
// `reliquary run` already does for its command (src/run.ts). The lookups are
// checked on every OS. Unit tests: no servers (npm test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { openCommand } from "../dist/auth.js";
import { gitCommand } from "../dist/pull.js";

const REPO = "C:\\src\\project";
const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const exists = (p) => [`${REPO}\\git.exe`, `${REPO}\\git.cmd`, GIT].includes(p);
const ENV = { Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;.;relative\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

test("windows search: git is found on PATH, never in the repository being inspected", () => {
  assert.equal(gitCommand("win32", ENV, REPO, exists), GIT);
  assert.equal(gitCommand("win32", { ...ENV, Path: "C:\\Windows\\system32;." }, REPO, exists), null, "only in the working directory: not found, so env pull says git isn't installed");
});

test("windows search: elsewhere git is looked up by name, as before", () => {
  assert.equal(gitCommand("linux", {}, "/repo"), "git");
  assert.equal(gitCommand("darwin", {}, "/repo"), "git");
});

test("windows search: the browser opener on Windows is rundll32 by its full path under SystemRoot, not by name", () => {
  const [file, args] = openCommand("https://app.example/x", "win32", { SystemRoot: "D:\\Win" });
  assert.equal(file, "D:\\Win\\System32\\rundll32.exe");
  assert.deepEqual(args, ["url.dll,FileProtocolHandler", "https://app.example/x"]);
  assert.equal(openCommand("https://a", "win32", {})[0], "C:\\Windows\\System32\\rundll32.exe");
  assert.deepEqual(openCommand("https://a", "darwin", {}), ["open", ["https://a"]]);
  assert.deepEqual(openCommand("https://a", "linux", {}), ["xdg-open", ["https://a"]]);
});
