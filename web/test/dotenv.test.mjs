// The .env parser behind the Variables page's paste (src/dotenv.ts; the CLI
// has the same file for `reliquary env push`). Every case in
// dotenv-vectors.json, which the CLI's tests run too, plus the limits.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOTENV_MAX_ENTRIES, dotenvTooBig, parseDotenv } from "../dist/dotenv.js";

const vectors = JSON.parse(readFileSync(new URL("./dotenv-vectors.json", import.meta.url), "utf8"));

for (const v of vectors) {
  test(`dotenv parse: ${v.name}`, () => {
    const r = parseDotenv(v.input);
    assert.deepEqual(r.entries.map((e) => [e.line, e.name, e.value]), v.entries);
    assert.deepEqual(r.refused.map((e) => [e.line, e.name, e.reason]), v.refused);
  });
}

test("dotenv parse: no refusal ever holds any of its line's value", () => {
  for (const v of vectors) {
    const r = parseDotenv(v.input);
    for (const x of r.refused) {
      const text = `${x.name ?? ""} ${x.reason}`;
      for (const line of v.input.split(/\r\n|\n|\r/)) {
        const after = line.slice(line.indexOf("=") + 1).trim();
        if (line.includes("=") && after.length >= 4) assert.equal(text.includes(after), false, `${v.name}: ${x.reason}`);
      }
    }
  }
});

test(`dotenv parse: over ${DOTENV_MAX_ENTRIES} variables, the rest are refused, not dropped silently`, () => {
  const text = Array.from({ length: DOTENV_MAX_ENTRIES + 3 }, (_, i) => `K_${i}=v${i}`).join("\n");
  const r = parseDotenv(text);
  assert.equal(r.entries.length, DOTENV_MAX_ENTRIES);
  assert.deepEqual(r.refused.map((x) => x.line), [DOTENV_MAX_ENTRIES + 1, DOTENV_MAX_ENTRIES + 2, DOTENV_MAX_ENTRIES + 3]);
  assert.match(r.refused[0].reason, /over 200 variables; import the rest separately/);
});

test("dotenv parse: a value over 64 KiB is refused; 64 KiB exactly is taken", () => {
  const r = parseDotenv(`BIG=${"x".repeat(64 * 1024 + 1)}\nOK=${"y".repeat(64 * 1024)}`);
  assert.deepEqual(r.refused, [{ line: 1, name: "BIG", reason: "the value is over 64 KiB" }]);
  assert.deepEqual(r.entries.map((e) => e.name), ["OK"]);
});

test("dotenv parse: a whole file over 512 KiB or 5000 lines is refused before parsing", () => {
  assert.equal(dotenvTooBig("A=1\n"), null);
  assert.match(dotenvTooBig("x".repeat(512 * 1024 + 1)), /over 512 KiB/);
  assert.match(dotenvTooBig("\n".repeat(5000)), /over 5000 lines/);
});
