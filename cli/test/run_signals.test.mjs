// What `reliquary run` does with Ctrl-C and kill (src/run.ts). At a terminal
// the tty sends SIGINT to the whole foreground process group, the command
// included, so the CLI must not pass it on a second time; with no terminal
// nothing else delivers it, so the CLI must. The command here counts the
// SIGINTs it receives. Unit tests: no servers (npm test); POSIX signals only.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const RUN = pathToFileURL(path.resolve("dist/run.js")).href;

// Prints "ready", then after a second how many SIGINTs it saw.
const COUNTER = `let n = 0; process.on("SIGINT", () => n++); console.log("ready"); setTimeout(() => { console.log("SIGINTS=" + n); process.exit(0); }, 1000);`;

function wrapper() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const file = path.join(dir, "wrap.mjs");
  writeFileSync(
    file,
    `import { runWith } from ${JSON.stringify(RUN)};
process.exit(await runWith([process.execPath, "-e", ${JSON.stringify(COUNTER)}], new Map(), () => {}));
`,
  );
  return file;
}

const counted = (out) => Number(/SIGINTS=(\d+)/.exec(out)?.[1]);

// The same wrapper under a pseudo-terminal, where Ctrl-C is a real ^C that
// the kernel turns into SIGINT for the foreground group.
const PTY = `
import os, pty, select, sys
node, script = sys.argv[1:3]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, script])
out, sent = b"", False
while True:
    ready, _, _ = select.select([fd], [], [], 15)
    if not ready:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if b"ready" in out and not sent:
        os.write(fd, b"\\x03")
        sent = True
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
`;
const hasPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

test("run signals: Ctrl-C at a terminal reaches the command once, not twice", { skip: !hasPty && "needs POSIX and python3's pty" }, () => {
  const r = spawnSync("python3", ["-c", PTY, process.execPath, wrapper()], { encoding: "utf8" });
  assert.equal(counted(r.stdout), 1, r.stdout + r.stderr);
});

test("run signals: without a terminal, SIGINT sent to the CLI is passed to the command once", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const child = spawn(process.execPath, [wrapper()], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    if (out.includes("ready") && !child.killed) child.kill("SIGINT");
  });
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(counted(out), 1, out);
});
