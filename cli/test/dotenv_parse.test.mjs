// The .env parser `reliquary env push` uses (src/dotenv.ts) is the web
// app's, byte for byte, and passes the same vectors (web/test/dotenv-vectors.json).
// cli/test.sh mounts web/ read-only at /src; outside it, ../web.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseDotenv } from "../dist/dotenv.js";

const WEB_SRC = process.env.WEB_SRC ?? (existsSync("/src/src/dotenv.ts") ? "/src" : path.resolve("../web"));

test("dotenv parse: the CLI's parser is the web app's, byte for byte", () => {
  assert.equal(readFileSync("src/dotenv.ts", "utf8"), readFileSync(path.join(WEB_SRC, "src/dotenv.ts"), "utf8"));
});

test("dotenv parse: the CLI passes every shared vector", () => {
  const vectors = JSON.parse(readFileSync(path.join(WEB_SRC, "test/dotenv-vectors.json"), "utf8"));
  assert.ok(vectors.length >= 20);
  for (const v of vectors) {
    const r = parseDotenv(v.input);
    assert.deepEqual(r.entries.map((e) => [e.line, e.name, e.value]), v.entries, v.name);
    assert.deepEqual(r.refused.map((e) => [e.line, e.name, e.reason]), v.refused, v.name);
  }
});
