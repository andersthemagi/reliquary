// The dotenv format `reliquary env pull` writes (docs/variables.md):
// NAME="value" per line in the order given (name order from the API),
// escaping \ as \\, " as \", newline as \n and carriage return as \r, under
// a header comment that stays on its own lines whatever the vault is called.

import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeValue, formatDotenv } from "../dist/pull.js";
import { safeName } from "../dist/api.js";

const source = { server: "https://r.example", vaultName: "Team", vaultId: "00000000-0000-0000-0000-000000000001", environment: "development", at: new Date("2026-09-25T10:00:00Z") };

test("dotenv: escapes backslash, double quote, newline and carriage return, and nothing else", () => {
  assert.equal(escapeValue('a\\b"c\nd\re'), 'a\\\\b\\"c\\nd\\re');
  assert.equal(escapeValue("plain $HOME 'single' tab\tend"), "plain $HOME 'single' tab\tend");
  assert.equal(escapeValue(""), "");
});

test("dotenv: one NAME=\"value\" line per variable after a two-line header", () => {
  const text = formatDotenv(new Map([["A", "1"], ["B_2", 'x"y']]), source);
  const lines = text.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^# Environment variables from Reliquary: vault "Team" \(00000000-0000-0000-0000-000000000001\), environment development, https:\/\/r\.example\.$/);
  assert.match(lines[1], /^# Written by `reliquary env pull` at 2026-09-25T10:00:00\.000Z\./);
  assert.deepEqual(lines.slice(2), ['A="1"', 'B_2="x\\"y"', ""]);
});

test("dotenv: a vault name can't break out of the header comment", () => {
  const text = formatDotenv(new Map(), { ...source, vaultName: "Evil\nINJECTED=1\r x" });
  assert.equal(text.split("\n").filter((l) => l && !l.startsWith("#")).length, 0);
  assert.doesNotMatch(text, /^INJECTED/m);
});

test("dotenv: names that change how programs start are refused by the CLI too", () => {
  for (const n of ["PATH", "path", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_FUNC_x%%", "GIT_SSH_COMMAND", "1BAD", "A-B", ""]) {
    assert.equal(safeName(n), false, n);
  }
  for (const n of ["API_KEY", "_x", "DATABASE_URL"]) assert.equal(safeName(n), true, n);
});
