// Export entry names (src/export.ts): no entry, read with \ as / (as
// Windows extractors do), is absolute, names a drive, or has a . or ..
// segment; a path that isn't safe as given goes under renamed/ and the
// manifest lists it. No server needed: writeExport runs on a page source.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";

const { writeExport, entryProblem, tarEntry } = await import("../dist/export.js");

const ZERO = "00000000-0000-0000-0000-000000000000";

// Paths a vault may hold from before 20260926130000_portable_paths.sql.
const HOSTILE = [
  "..\\x.md",
  "a\\..\\..\\x.md",
  "notes\\..\\..\\..\\Windows\\evil.md",
  "C:\\Users\\evil.md",
  "C:evil.md",
  "notes/a:stream.md",
  "notes/.. /x.md",
  "notes/.../x.md",
  "notes/con.md",
  "notes/NUL",
  "notes/q?.md",
  "notes/\uff0e\uff0e\uff0fx.md",
  "notes/\u00a5..\u00a5x.md",
];
const SAFE = ["notes/plan.md", "clients/acme/brief.md", ".github/..notes.md", "caf\u00e9/r\u00e9sum\u00e9.md", "console.md"];

async function exportOf(paths) {
  const h = {
    export: ZERO,
    vault: { id: ZERO, name: "Paths", default_policy: "open", created_at: "2026-09-26T00:00:00.000Z" },
    exported_at: "2026-09-26T12:00:00.000Z",
    exported_by: ZERO,
    files: paths.length,
    bytes: 0,
    rules: [],
    variables: [],
  };
  const rows = [...paths].sort().map((path, i) => ({
    path,
    body: `file ${i}\n`,
    updated_at: new Date("2026-09-26T00:00:00Z"),
    version_id: ZERO,
  }));
  const pages = async (after) => rows.filter((r) => r.path > after);
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  await writeExport(ZERO, h, out, pages);
  return readTar(gunzipSync(Buffer.concat(chunks)));
}

// Entries in order: the name an extractor uses (pax path when given), the
// ustar name field, and the body.
function readTar(tar) {
  const out = [];
  let pax = null;
  for (let off = 0; off + 512 <= tar.length; ) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const field = hdr.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(hdr.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (String.fromCharCode(hdr[156]) === "x") {
      pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
      continue;
    }
    out.push({ name: pax ?? field, field, body });
    pax = null;
  }
  return out;
}

// What a Windows extractor can make of a name: \ as a separator, "best
// fit" look-alikes as the ASCII they resemble, trailing dots and spaces
// dropped from each name.
function escapes(name) {
  const n = name.normalize("NFKC").replace(/[\u00a5\u20a9]/g, "\\").replace(/\\/g, "/");
  if (n.startsWith("/") || n.includes(":")) return true;
  return n.split("/").some((s) => s === "." || s === ".." || (s !== "" && s.replace(/[. ]+$/, "") === ""));
}

test("export paths: no entry escapes the folder when \\ is read as a separator", async () => {
  const entries = await exportOf([...HOSTILE, ...SAFE]);
  for (const e of entries) {
    assert.equal(escapes(e.name), false, `unsafe entry name: ${JSON.stringify(e.name)}`);
    assert.equal(escapes(e.field), false, `unsafe ustar name: ${JSON.stringify(e.field)}`);
    assert.equal(entryProblem(e.name), null, `${JSON.stringify(e.name)}: ${entryProblem(e.name)}`);
  }
});

test("export paths: an unsafe path goes under renamed/, and the manifest gives its path in the vault", async () => {
  const entries = await exportOf([...HOSTILE, ...SAFE]);
  const manifest = JSON.parse(entries.at(-1).body.toString("utf8"));
  assert.equal(manifest.renamed.length, HOSTILE.length);
  assert.deepEqual(manifest.renamed.map((r) => r.path).sort(), [...HOSTILE].sort());
  for (const r of manifest.renamed) {
    assert.match(r.archived_as, /^renamed\/\d{4}-[^/\\]+$/);
    assert.ok(r.why.length > 0);
    const e = entries.find((x) => x.name === `paths-2026-09-26/${r.archived_as}`);
    assert.ok(e, `no entry for ${r.archived_as}`);
    const f = manifest.files.find((x) => x.path === r.path);
    assert.equal(f.archived_as, r.archived_as);
    assert.equal(f.bytes, e.body.length);
  }
  assert.equal(new Set(manifest.renamed.map((r) => r.archived_as)).size, HOSTILE.length, "no two renamed files share a name");
});

test("export paths: a safe path is kept as it is under files/", async () => {
  const entries = await exportOf([...HOSTILE, ...SAFE]);
  const manifest = JSON.parse(entries.at(-1).body.toString("utf8"));
  for (const p of SAFE) {
    assert.ok(entries.some((e) => e.name === `paths-2026-09-26/files/${p}`), p);
    assert.equal(manifest.files.find((x) => x.path === p).archived_as, undefined, p);
  }
});

test("export paths: a long path whose first 100 bytes end in .. has a safe ustar name", () => {
  const path = `root/files/${"a".repeat(86)}/..x/more.md`;
  const [e] = readTar(Buffer.concat([tarEntry(path, Buffer.from("x"), 0), Buffer.alloc(1024)]));
  assert.equal(e.name, path, "pax keeps the whole name");
  assert.equal(escapes(e.field), false, e.field);
});
