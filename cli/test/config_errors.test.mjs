// Two configuration mistakes that were named wrongly (src/config.ts): a
// project file that can't be read is not "invalid JSON", and an empty
// RELIQUARY_URL names itself instead of a vague "must be a URL". Unit tests:
// no database (npm test).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectConfig, serverOrigin } from "../dist/config.js";
import { CliError } from "../dist/errors.js";

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `config-${p}-`));

test("config errors: a project file that can't be read says so and why, and isn't called invalid JSON", () => {
  const dir = tmp("project");
  mkdirSync(path.join(dir, ".reliquary.json"));
  assert.throws(
    () => projectConfig(dir),
    (err) => err instanceof CliError && /^Couldn't read .*\.reliquary\.json \(EISDIR\): it is a folder, not a file\./.test(err.message) && !/valid JSON/.test(err.message),
  );
  const bad = tmp("badjson");
  writeFileSync(path.join(bad, ".reliquary.json"), "{ not json");
  assert.throws(() => projectConfig(bad), /isn't valid JSON/);
});

test("config errors: an empty RELIQUARY_URL is named instead of a vague 'must be a URL'", () => {
  const saved = process.env.RELIQUARY_URL;
  process.env.RELIQUARY_URL = "";
  try {
    assert.throws(
      () => serverOrigin(undefined, null),
      (err) => err.exitCode === 2 && /^RELIQUARY_URL is set but empty\. Unset it, or set it to a server like https:\/\//.test(err.message),
    );
    assert.equal(serverOrigin("https://flag.example", null), "https://flag.example", "--server still wins");
  } finally {
    if (saved === undefined) delete process.env.RELIQUARY_URL;
    else process.env.RELIQUARY_URL = saved;
  }
});
