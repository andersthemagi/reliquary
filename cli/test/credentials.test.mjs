// Where sign-ins are kept (src/credentials.ts): the OS keychain where there
// is one, else a 0600 file; RELIQUARY_CREDENTIALS=file|keychain overrides;
// sign-ins from before the keychain keep working and move into it on the
// next write. A token never reaches a keychain tool's arguments: it goes in
// on standard input. The macOS, libsecret and DPAPI adapters are checked
// with fakes on every OS, and against the real thing where it exists.
// Unit tests: no servers (npm test).

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  chooseStore,
  decodeCredential,
  encodeCredential,
  fileStore,
  macosKeychain,
  PS_SCRIPTS,
  realExec,
  secretTool,
  windowsDpapi,
  withFileFallback,
} from "../dist/credentials.js";

const SERVER = "https://app.example.test";
const OTHER = "http://127.0.0.1:8796";
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `cred-${p}-`));
const credential = () => ({
  refreshToken: `rlr_${randomBytes(32).toString("hex")}`,
  accessToken: `rle_${randomBytes(32).toString("hex")}`,
  expiresAt: Date.now() + 3_600_000,
});
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", failed: false });

// Each test gets its own config directory.
function inConfig(fn) {
  const saved = process.env.RELIQUARY_CONFIG_DIR;
  process.env.RELIQUARY_CONFIG_DIR = path.join(tmp("cfg"), "reliquary");
  try {
    return fn(process.env.RELIQUARY_CONFIG_DIR);
  } finally {
    if (saved === undefined) delete process.env.RELIQUARY_CONFIG_DIR;
    else process.env.RELIQUARY_CONFIG_DIR = saved;
  }
}

// No token in any argument of any call.
function assertNoTokenInArgs(calls, ...creds) {
  for (const c of calls) {
    for (const cr of creds) {
      for (const a of [c.file, ...c.args]) {
        assert.ok(!a.includes(cr.refreshToken) && !a.includes(cr.accessToken), `a token in the arguments of ${c.file} ${c.args[0]}`);
        assert.doesNotMatch(a, /rl[re]_[0-9a-f]{16}/);
      }
    }
  }
}

// macOS /usr/bin/security, as far as the CLI uses it: `-i` reads one
// command per line from standard input.
function fakeSecurity() {
  const items = new Map();
  const calls = [];
  const exec = (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input ?? "" });
    const argv = args[0] === "-i" ? opts.input.trim().split(/\s+/) : args;
    const flag = (f) => argv[argv.indexOf(f) + 1];
    const key = `${flag("-s")}|${flag("-a")}`;
    if (argv[0] === "find-generic-password") return items.has(key) ? ok(`${items.get(key)}\n`) : { status: 44, stdout: "", stderr: "not found", failed: false };
    if (argv[0] === "add-generic-password") {
      if (!argv.includes("-U") && items.has(key)) return { status: 45, stdout: "", stderr: "exists", failed: false };
      items.set(key, flag("-w"));
      return ok();
    }
    if (argv[0] === "delete-generic-password") return items.delete(key) ? ok() : { status: 44, stdout: "", stderr: "", failed: false };
    return { status: 2, stdout: "", stderr: "usage", failed: false };
  };
  return { exec, calls, items };
}

// libsecret's secret-tool: store reads the secret from standard input.
function fakeSecretTool({ running = true } = {}) {
  const items = new Map();
  const calls = [];
  const exec = (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input ?? "" });
    if (!running) return { status: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY", failed: false };
    const attrs = args.filter((a) => !a.startsWith("--")).slice(1);
    const key = attrs.join("|");
    if (args[0] === "lookup") return items.has(key) ? ok(items.get(key)) : { status: 1, stdout: "", stderr: "", failed: false };
    if (args[0] === "store") {
      items.set(key, opts.input);
      return ok();
    }
    if (args[0] === "clear") {
      items.delete(key);
      return ok();
    }
    return { status: 2, stdout: "", stderr: "usage", failed: false };
  };
  return { exec, calls, items };
}

// Windows PowerShell running the CLI's fixed DPAPI script: "encrypts" by
// reversing the base64 it's given.
function fakePowershell() {
  const calls = [];
  const exec = (file, args, opts = {}) => {
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    calls.push({ file, args, input: opts.input ?? "", script });
    const input = opts.input.trim();
    if (script === PS_SCRIPTS.protect) return ok(Buffer.from(`ENC${input}`).toString("base64"));
    if (script === PS_SCRIPTS.unprotect) {
      const plain = Buffer.from(input, "base64").toString();
      return plain.startsWith("ENC") ? ok(plain.slice(3)) : { status: 1, stdout: "", stderr: "bad data", failed: false };
    }
    return { status: 1, stdout: "", stderr: "unknown script", failed: false };
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------

test("keychain choice: RELIQUARY_CREDENTIALS=file uses the file and never asks for a keychain", () =>
  inConfig(() => {
    let asked = false;
    const s = chooseStore("file", () => ((asked = true), macosKeychain(fakeSecurity().exec)));
    assert.equal(s.kind, "file");
    assert.equal(asked, false);
  }));

test("keychain choice: unset, the keychain when one answers, else the file", () =>
  inConfig(() => {
    assert.equal(chooseStore(undefined, () => macosKeychain(fakeSecurity().exec)).kind, "keychain");
    assert.equal(chooseStore("", () => null).kind, "file");
    assert.equal(chooseStore("auto", () => null).kind, "file");
  }));

test("keychain choice: RELIQUARY_CREDENTIALS=keychain without one fails instead of using the file", () =>
  inConfig(() => {
    assert.throws(() => chooseStore("keychain", () => null), (e) => e.name === "CliError" && /no OS keychain/.test(e.message) && /RELIQUARY_CREDENTIALS/.test(e.message));
    assert.throws(() => chooseStore("vault", () => null), (e) => e.name === "UsageError" && e.exitCode === 2);
  }));

test("keychain choice: Linux uses secret-tool only when a Secret Service answers", () => {
  assert.equal(secretTool(fakeSecretTool().exec).available(), true);
  assert.equal(secretTool(fakeSecretTool({ running: false }).exec).available(), false);
  assert.equal(secretTool(realExec, path.join(tmp("none"), "secret-tool")).available(), false, "not installed");
});

test("no token in arguments: macOS Keychain gets the sign-in on standard input through security -i", () => {
  const f = fakeSecurity();
  const kc = macosKeychain(f.exec, "/usr/bin/security");
  const a = credential();
  const b = credential();
  assert.equal(kc.get(SERVER), null);
  kc.set(SERVER, a);
  assert.deepEqual(kc.get(SERVER), a);
  kc.set(SERVER, b); // -U: replaces
  assert.deepEqual(kc.get(SERVER), b);
  kc.set(SERVER, null);
  assert.equal(kc.get(SERVER), null);
  assertNoTokenInArgs(f.calls, a, b);
  const adds = f.calls.filter((c) => c.args[0] === "-i");
  assert.equal(adds.length, 2);
  for (const c of adds) {
    assert.deepEqual(c.args, ["-i"]);
    assert.match(c.input, /^add-generic-password -U -s reliquary-cli -a https:\/\/app\.example\.test -w v1:rlr_[0-9a-f]{64}:rle_[0-9a-f]{64}:\d+\n$/);
  }
  assert.ok(f.calls.every((c) => c.file === "/usr/bin/security"));
});

test("no token in arguments: macOS Keychain errors name the exit code, never what the tool printed", () => {
  const kc = macosKeychain(() => ({ status: 51, stdout: "rlr_leak", stderr: "User interaction is not allowed.", failed: false }));
  assert.throws(() => kc.get(SERVER), (e) => /exit 51/.test(e.message) && !/rlr_|interaction/.test(e.message) && /RELIQUARY_CREDENTIALS=file/.test(e.message));
  // A write the tool claims but that didn't land is an error, not a lost sign-in.
  const f = fakeSecurity();
  const broken = macosKeychain((file, args, opts) => (args[0] === "-i" ? ok() : f.exec(file, args, opts)));
  assert.throws(() => broken.set(SERVER, credential()), /save your sign-in/);
});

test("no token in arguments: secret-tool store reads the sign-in from standard input", () => {
  const f = fakeSecretTool();
  const kc = secretTool(f.exec);
  const a = credential();
  assert.equal(kc.get(SERVER), null);
  kc.set(SERVER, a);
  kc.set(OTHER, credential());
  assert.deepEqual(kc.get(SERVER), a);
  kc.set(SERVER, null);
  assert.equal(kc.get(SERVER), null);
  assert.notEqual(kc.get(OTHER), null);
  assertNoTokenInArgs(f.calls, a);
  const store = f.calls.find((c) => c.args[0] === "store");
  assert.deepEqual(store.args.slice(2), ["service", "reliquary-cli", "account", SERVER]);
  assert.equal(store.input, encodeCredential(a));
});

test("no token in arguments: DPAPI encrypts through a fixed PowerShell script, the store on standard input", () =>
  inConfig((dir) => {
    const f = fakePowershell();
    const file = path.join(dir, "credentials.dpapi");
    const kc = windowsDpapi(f.exec, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", () => file);
    const a = credential();
    kc.set(SERVER, a);
    kc.set(OTHER, credential());
    assert.deepEqual(kc.get(SERVER), a);
    kc.set(SERVER, null);
    assert.equal(kc.get(SERVER), null);
    assertNoTokenInArgs(f.calls, a);
    for (const c of f.calls) {
      assert.ok(!c.script.includes(a.refreshToken), "no token in the script");
      assert.deepEqual(c.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    }
    const protect = f.calls.find((c) => c.script === PS_SCRIPTS.protect);
    assert.ok(Buffer.from(protect.input, "base64").toString().includes(a.refreshToken), "the store goes in on stdin");
    assert.ok(!readFileSync(file, "utf8").includes("rlr_"), "the file holds only what PowerShell returned");
    assert.match(PS_SCRIPTS.protect, /ProtectedData\]::Protect\(.*CurrentUser/);
    assert.match(PS_SCRIPTS.unprotect, /ProtectedData\]::Unprotect\(/);
  }));

test("no token in arguments: a sign-in is one line a keychain tool needs no quoting for", () => {
  const a = credential();
  assert.match(encodeCredential(a), /^[a-z0-9_:]+$/);
  assert.deepEqual(decodeCredential(`${encodeCredential(a)}\n`), a);
  for (const bad of ["", "v1:x:y:1", `v2:${a.refreshToken}:${a.accessToken}:1`, `${encodeCredential(a)} extra`]) assert.equal(decodeCredential(bad), null);
  // A server name that would need quoting on security's command line is refused.
  assert.throws(() => macosKeychain(fakeSecurity().exec).set("https://evil.test -w x", a), /keychain name/);
});

test("no token in arguments: a real secret-tool process gets the sign-in on stdin, not in its argv", { skip: process.platform === "win32" && "POSIX shell script" }, () => {
  const dir = tmp("st");
  const bin = path.join(dir, "secret-tool");
  // Records its argv and stdin; keeps one item per attribute list.
  writeFileSync(
    bin,
    `#!/bin/sh
d=${JSON.stringify(dir)}
printf '%s\\n' "$*" >> "$d/argv.log"
cmd=$1; shift
[ "$cmd" = store ] && shift
key=$(printf '%s' "$*" | tr -c 'a-zA-Z0-9' _)
case $cmd in
  store) cat > "$d/item.$key"; cat "$d/item.$key" >> "$d/stdin.log" ;;
  lookup) [ -f "$d/item.$key" ] || exit 1; cat "$d/item.$key" ;;
  clear) rm -f "$d/item.$key" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const kc = secretTool(realExec, bin);
  const a = credential();
  assert.equal(kc.available(), true);
  kc.set(SERVER, a);
  assert.deepEqual(kc.get(SERVER), a);
  kc.set(SERVER, null);
  assert.equal(kc.get(SERVER), null);
  const argv = readFileSync(path.join(dir, "argv.log"), "utf8");
  assert.ok(!argv.includes(a.refreshToken) && !argv.includes(a.accessToken));
  assert.match(argv, /^store --label=Reliquary CLI sign-in for https:\/\/app\.example\.test service reliquary-cli account https:\/\/app\.example\.test$/m);
  assert.equal(readFileSync(path.join(dir, "stdin.log"), "utf8"), encodeCredential(a));
});

test("sign-ins from before the keychain: read from the file, moved into the keychain on the next write", () =>
  inConfig((dir) => {
    const file = fileStore();
    const old = credential();
    const kept = credential();
    file.set(SERVER, old);
    file.set(OTHER, kept);
    const f = fakeSecurity();
    const s = withFileFallback(macosKeychain(f.exec), fileStore());
    assert.equal(s.kind, "keychain");
    assert.deepEqual(s.get(SERVER), old, "an old sign-in keeps working");
    const fresh = credential();
    s.set(SERVER, fresh); // e.g. a refresh
    assert.deepEqual(s.get(SERVER), fresh);
    assert.equal(fileStore().get(SERVER), null, "gone from the file");
    assert.deepEqual(fileStore().get(OTHER), kept, "another server's sign-in stays until it's written");
    s.set(OTHER, null); // logout
    assert.equal(s.get(OTHER), null);
    assert.equal(fileStore().get(OTHER), null);
    assert.ok(!readFileSync(path.join(dir, "credentials.json"), "utf8").includes("rlr_"));
  }));

test("sign-ins from before the keychain: a keychain write doesn't create the file", () =>
  inConfig((dir) => {
    const s = withFileFallback(secretTool(fakeSecretTool().exec), fileStore());
    s.set(SERVER, credential());
    s.set(SERVER, null);
    assert.equal(existsSync(path.join(dir, "credentials.json")), false);
  }));

test("file store: sign-ins per server in credentials.json, mode 600 in a 700 directory, no temporary files left", { skip: process.platform === "win32" && "POSIX modes" }, () =>
  inConfig((dir) => {
    const s = fileStore();
    const a = credential();
    s.set(SERVER, a);
    s.set(OTHER, credential());
    assert.deepEqual(s.get(SERVER), a);
    assert.equal(statSync(path.join(dir, "credentials.json")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(dir), ["credentials.json"]);
    assert.equal(s.where, path.join(dir, "credentials.json"));
  }));

test("file store: a damaged file is named, never echoed", () =>
  inConfig((dir) => {
    fileStore().set(SERVER, credential());
    writeFileSync(path.join(dir, "credentials.json"), '{"servers": {"x": "rlr_secretish');
    assert.throws(() => fileStore().get(SERVER), (e) => /damaged/.test(e.message) && !/secretish/.test(e.message));
  }));

test("real keychain: DPAPI round trip on Windows, the file unreadable as text", { skip: process.platform !== "win32" && "Windows only" }, () =>
  inConfig((dir) => {
    const file = path.join(dir, "credentials.dpapi");
    const kc = windowsDpapi(realExec, undefined, () => file);
    const a = credential();
    kc.set(SERVER, a);
    assert.deepEqual(kc.get(SERVER), a);
    assert.ok(!readFileSync(file, "utf8").includes("rlr_") && !readFileSync(file, "utf8").includes(SERVER));
    kc.set(SERVER, null);
    assert.equal(kc.get(SERVER), null);
  }));

test("real keychain: macOS Keychain round trip on macOS", { skip: process.platform !== "darwin" && "macOS only" }, (t) => {
  if (realExec("/usr/bin/security", ["show-keychain-info"]).status !== 0) {
    t.skip("no unlocked default keychain on this machine");
    return;
  }
  const kc = macosKeychain(realExec, "/usr/bin/security", `reliquary-cli-test-${randomBytes(4).toString("hex")}`);
  const a = credential();
  try {
    kc.set(SERVER, a);
    assert.deepEqual(kc.get(SERVER), a);
  } finally {
    kc.set(SERVER, null);
  }
  assert.equal(kc.get(SERVER), null);
});
