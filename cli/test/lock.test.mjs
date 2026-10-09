// The lock around a token refresh (src/credentials.ts, withLock): refreshing
// rotates the refresh token, and presenting a rotated one again revokes the
// whole grant, so two processes must never hold the lock at once. A holder
// that is slow but alive must keep it, a holder whose lock was replaced must
// not remove the new owner's, and a crashed process's lock must be replaced.
// The age of a lock is its file's modification time, which the tests set.
// Unit tests: no servers (npm test).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withLock } from "../dist/credentials.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inConfig(fn) {
  const saved = process.env.RELIQUARY_CONFIG_DIR;
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "lock-")), "reliquary");
  process.env.RELIQUARY_CONFIG_DIR = dir;
  try {
    return await fn(path.join(dir, "credentials.lock"));
  } finally {
    if (saved === undefined) delete process.env.RELIQUARY_CONFIG_DIR;
    else process.env.RELIQUARY_CONFIG_DIR = saved;
  }
}

const age = (file, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

test("lock: while held it names its owner, and it is gone afterwards", () =>
  inConfig(async (lock) => {
    const seen = [];
    for (let i = 0; i < 2; i++) await withLock(async () => seen.push(readFileSync(lock, "utf8")));
    assert.ok(seen.every((t) => /^[0-9a-f]{16}$/.test(t)), "an owner token");
    assert.notEqual(seen[0], seen[1], "a new one each time");
    assert.equal(existsSync(lock), false);
  }));

test("lock: a holder whose lock was taken over leaves the new owner's lock alone", () =>
  inConfig(async (lock) => {
    await withLock(async () => {
      unlinkSync(lock);
      writeFileSync(lock, "someone-elses-token");
    });
    assert.equal(readFileSync(lock, "utf8"), "someone-elses-token");
  }));

test("lock: a lock that is slow but alive (older than one request, younger than the limit) is waited for, not taken over", () =>
  inConfig(async (lock) => {
    let release;
    const held = new Promise((r) => (release = r));
    let holding = false;
    let waiterRan = false;
    const holder = withLock(async () => {
      holding = true;
      age(lock, 45_000);
      await held;
    });
    while (!holding) await sleep(5);
    const waiter = withLock(async () => void (waiterRan = true));
    await sleep(400);
    assert.equal(waiterRan, false, "the second process must still be waiting");
    release();
    await holder;
    await waiter;
    assert.equal(waiterRan, true);
  }));

test("lock: a crashed process's lock (older than any live holder can be) is replaced, and the command goes on", () =>
  inConfig(async (lock) => {
    await withLock(async () => {});
    writeFileSync(lock, "a-crashed-process");
    age(lock, 10 * 60_000);
    let ran = false;
    await withLock(async () => void (ran = true));
    assert.equal(ran, true);
    assert.equal(existsSync(lock), false);
  }));
