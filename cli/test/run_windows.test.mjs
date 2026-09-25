// `reliquary run` on Windows (src/run.ts): commands found by PATH and
// PATHEXT; .cmd and .bat shims (npm, npx, pnpm) started through
// `cmd.exe /d /v:off /s /c` with every argument quoted, and arguments cmd.exe
// would act on refused; environment names merged without case duplicates.
// The planning is checked on every OS; the "real" tests start real .cmd
// files and run only on Windows. Unit tests: no servers (npm test).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeEnv, quoteForCmd, resolveWindowsCommand, runWith, windowsSpawnPlan } from "../dist/run.js";

const files = (...ps) => {
  const set = new Set(ps.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};
const ENV = { Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs;relative\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: "C:\\Windows" };
const NODE_DIR = "C:\\Program Files\\nodejs";
const exists = files(`${NODE_DIR}\\npm.cmd`, `${NODE_DIR}\\npm`, `${NODE_DIR}\\node.exe`, `${NODE_DIR}\\node.cmd`, "C:\\Windows\\system32\\where.exe", "C:\\proj\\tool.bat", "C:\\proj\\script.ps1", "C:\\proj\\bin\\app.exe");

test("windows run: a bare name is found on PATH (any case of Path) with PATHEXT, .exe before .cmd, never in a relative PATH entry", () => {
  assert.equal(resolveWindowsCommand("npm", ENV, "C:\\proj", exists), `${NODE_DIR}\\npm.cmd`, "the .cmd shim, not the extensionless sh script");
  assert.equal(resolveWindowsCommand("node", ENV, "C:\\proj", exists), `${NODE_DIR}\\node.exe`);
  assert.equal(resolveWindowsCommand("where", ENV, "C:\\proj", exists), "C:\\Windows\\system32\\where.exe");
  assert.equal(resolveWindowsCommand("npm.cmd", ENV, "C:\\proj", exists), `${NODE_DIR}\\npm.cmd`);
  assert.equal(resolveWindowsCommand("tool", ENV, "C:\\proj", exists), null, "not from the current directory");
  assert.equal(resolveWindowsCommand("nope", ENV, "C:\\proj", exists), null);
  assert.equal(resolveWindowsCommand("app", { ...ENV, Path: "relative\\..\\proj\\bin" }, "C:\\proj", exists), null);
});

test("windows run: a path is resolved from the current directory, with PATHEXT", () => {
  assert.equal(resolveWindowsCommand(".\\tool", ENV, "C:\\proj", exists), "C:\\proj\\tool.bat");
  assert.equal(resolveWindowsCommand("bin/app", ENV, "C:\\proj", exists), "C:\\proj\\bin\\app.exe");
  assert.equal(resolveWindowsCommand("C:\\proj\\tool.bat", ENV, "D:\\", exists), "C:\\proj\\tool.bat");
});

test("windows run: an .exe starts directly with its arguments as given", () => {
  assert.deepEqual(windowsSpawnPlan("node", ["-e", 'console.log("a & b")'], ENV, "C:\\proj", exists), {
    file: `${NODE_DIR}\\node.exe`,
    args: ["-e", 'console.log("a & b")'],
    verbatim: false,
  });
});

test("windows run: a .cmd shim goes through cmd.exe /d /v:off /s /c with every argument quoted, metacharacters kept as text", () => {
  const args = ["run", "dev", "a&b", "x|y", "<in>", "^caret", "(p)", "with space", "", "trail\\", "C:\\dir\\\\", "!bang!"];
  const plan = windowsSpawnPlan("npm", args, ENV, "C:\\proj", exists);
  assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.verbatim, true);
  assert.deepEqual(plan.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.equal(plan.args.length, 5);
  assert.equal(
    plan.args[4],
    `""C:\\Program Files\\nodejs\\npm.cmd" "run" "dev" "a&b" "x|y" "<in>" "^caret" "(p)" "with space" "" "trail\\\\" "C:\\dir\\\\\\\\" "!bang!""`,
  );
  assert.equal(quoteForCmd("a\\b\\"), '"a\\b\\\\"', "only backslashes before the closing quote are doubled");
});

test("windows run: an argument holding a double quote, a percent sign or a line break is refused for a .cmd, and nothing runs", () => {
  for (const bad of ['"&calc', "%PATH%", "50%", "line\nbreak", "cr\rhere", "nul\u0000"]) {
    assert.throws(
      () => windowsSpawnPlan("npm", ["run", bad], ENV, "C:\\proj", exists),
      (e) => e.name === "CliError" && e.exitCode === 2 && /argument 2/.test(e.message) && !e.message.includes(bad),
      JSON.stringify(bad),
    );
  }
  // The same arguments go to an .exe untouched: no cmd.exe reads them.
  assert.deepEqual(windowsSpawnPlan("node", ['"&calc', "%PATH%"], ENV, "C:\\proj", exists).args, ['"&calc', "%PATH%"]);
});

test("windows run: not found exits 127; a file Windows can't start directly is refused", () => {
  assert.throws(() => windowsSpawnPlan("nope", [], ENV, "C:\\proj", exists), (e) => e.exitCode === 127 && /Command not found: nope/.test(e.message));
  assert.throws(() => windowsSpawnPlan(".\\script.ps1", [], ENV, "C:\\proj", exists), (e) => e.exitCode === 126 && /interpreter/.test(e.message));
});

test("windows env: a variable replaces an inherited one of any case instead of sitting beside it, and is named", () => {
  const { env, overridden } = mergeEnv({ Path: "C:\\x", api_key: "old", Other: "1" }, new Map([["API_KEY", "new"], ["FRESH", "2"]]), "win32");
  assert.deepEqual(Object.keys(env).sort(), ["API_KEY", "FRESH", "Other", "Path"]);
  assert.equal(env.API_KEY, "new");
  assert.deepEqual(overridden, ["API_KEY"]);
});

test("windows env: two variables differing only in case are refused on Windows, kept apart elsewhere", () => {
  const vars = new Map([["Token", "a"], ["TOKEN", "b"]]);
  assert.throws(() => mergeEnv({}, vars, "win32"), (e) => e.name === "CliError" && /Token and TOKEN differ only in case/.test(e.message));
  const { env } = mergeEnv({ token: "x" }, vars, "linux");
  assert.deepEqual(Object.keys(env).sort(), ["TOKEN", "Token", "token"]);
});

test("windows env: __proto__ and toString are plain names on every platform", () => {
  for (const p of ["win32", "linux"]) {
    const { env, overridden } = mergeEnv({}, new Map([["__proto__", "p"], ["toString", "t"]]), p);
    assert.equal(Object.getOwnPropertyDescriptor(env, "__proto__").value, "p");
    assert.equal(env.toString, "t");
    assert.deepEqual(overridden, []);
  }
});

// ---------------------------------------------------------------------------
// Real .cmd shims, on Windows only

const onWindows = { skip: process.platform !== "win32" && "Windows only" };

function shimDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reliquary-shim-"));
  // Like npm's shims: a .cmd that passes %* on to node.
  writeFileSync(path.join(dir, "print.js"), "require('fs').writeFileSync(process.env.OUT, JSON.stringify({ argv: process.argv.slice(2), v: process.env.RELQ_TEST ?? null })); process.exit(Number(process.env.CODE ?? 0));\n");
  writeFileSync(path.join(dir, "relqshim.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0print.js" %*\r\n`);
  return dir;
}

async function withPath(dir, fn) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
  const saved = process.env[key];
  process.env[key] = `${dir};${saved}`;
  try {
    return await fn();
  } finally {
    process.env[key] = saved;
  }
}

test("windows real: a .cmd shim on PATH gets every argument intact, metacharacters included, and the variables", onWindows, async () => {
  const dir = shimDir();
  const out = path.join(dir, "out.json");
  const args = ["a&b", "x|y", "<in>", "^caret", "(p)", "with space", "", "trail\\", "!bang!"];
  const code = await withPath(dir, () => runWith(["relqshim", ...args], new Map([["OUT", out], ["RELQ_TEST", "hello"]]), () => {}));
  assert.equal(code, 0);
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(got.argv, args);
  assert.equal(got.v, "hello");
});

test("windows real: the shim's exit code is ours", onWindows, async () => {
  const dir = shimDir();
  const code = await withPath(dir, () => runWith(["relqshim"], new Map([["OUT", path.join(dir, "o.json")], ["CODE", "7"]]), () => {}));
  assert.equal(code, 7);
});

test("windows real: an injection attempt through a .cmd is refused and runs nothing", onWindows, async () => {
  const dir = shimDir();
  const marker = path.join(dir, "pwned");
  await withPath(dir, async () => {
    assert.throws(() => runWith(["relqshim", `"&echo x>"${marker}`], new Map([["OUT", path.join(dir, "o.json")]]), () => {}), (e) => e.exitCode === 2);
  });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(dir, "o.json")), false);
});

test("windows real: an .exe by bare name starts directly, and an unknown command exits 127", onWindows, async () => {
  assert.equal(await runWith(["node", "-e", "process.exit(3)"], new Map(), () => {}), 3);
  assert.throws(() => runWith(["no-such-command-reliquary"], new Map(), () => {}), (e) => e.exitCode === 127);
});
