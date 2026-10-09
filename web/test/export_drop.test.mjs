// A download dropped mid-export (src/export.ts). No server needed: writeExport
// runs on a page source, and the client going away is the stream being
// destroyed. An unhandled rejection ends the node:test run, as it would end the
// web process.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

const { writeExport } = await import("../dist/export.js");

const ZERO = "00000000-0000-0000-0000-000000000000";
const HEADER = {
  export: ZERO,
  vault: { id: ZERO, name: "Drop", default_policy: "open", created_at: "2026-10-08T00:00:00.000Z" },
  exported_at: "2026-10-08T12:00:00.000Z",
  exported_by: ZERO,
  files: 0,
  bytes: 0,
  rules: [],
  variables: [],
};

test("export drop: a download dropped while a page is being fetched fails the export and leaves the process running", async () => {
  const out = new PassThrough();
  let release;
  const pages = () => new Promise((resolve) => (release = resolve));
  const done = writeExport(ZERO, HEADER, out, pages);
  out.destroy();
  // Past the point where an unobserved pipeline rejection is reported.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release([]);
  await assert.rejects(done, { code: "ERR_STREAM_PREMATURE_CLOSE" });
});
