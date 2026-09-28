// Vault export: a .tar.gz of every live file's current text plus a
// reliquary-export.json manifest, streamed as it is built.
//
// The database decides who may export (public.export_vault and
// public.export_files: an owner, in person) and logs vault.export when an
// export starts. export_vault also fixes what the export holds: each live
// file's version at that moment, and the header, in one snapshot
// (20260925160000_membership_polish.sql). Files then come a page at a time
// from that list, each page its own short transaction, so a large vault or
// a slow download never holds a pooled connection, and the archive is still
// one consistent moment. The manifest carries variable names and
// environments, never a value: values leave Reliquary only through
// `reliquary run` and `env pull`.
//
// An archive that looks whole is whole: the manifest is written last, then
// the end-of-archive blocks, then the gzip trailer. If anything fails
// before that, the gzip stream is destroyed without its trailer and the
// download is cut (server.ts), so a truncated file fails to gunzip and
// holds no manifest.
//
// The tar writer is the minimum POSIX ustar needs: regular files, 0644,
// owner 0, and a pax header for any path over 100 bytes. No dependency.
//
// Every entry name is safe to extract anywhere. A vault path is written as
// given under files/ only when no system would read it as something else
// (entryProblem). Otherwise (a backslash, which Windows extractors take as a
// folder separator, so "a\..\..\x" would climb out; a colon, a drive or a
// stream; a name ending in a dot or space; a device name; a character that
// Windows maps to / \ : or . when it converts names), the file goes under
// renamed/ as "<n>-<the path with every unsafe character as _>", and the
// manifest's "renamed" list gives its path in the vault. New paths like
// these are refused by the database (20260926130000_portable_paths.sql);
// this keeps files saved before that safe too.

import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { asPerson } from "./db.js";

export const MANIFEST = "reliquary-export.json";
// The database refuses to start an export over its cap (100 MiB of text);
// this guards the stream too, in case files grow while it runs.
const STREAM_CAP = 110 * 1024 * 1024;
const PAGE = 200;

export type ExportHeader = {
  export: string; // the snapshot's id: export_files serves this export's files
  vault: { id: string; name: string; default_policy: string; created_at: string };
  exported_at: string;
  exported_by: string;
  files: number;
  bytes: number;
  rules: { path: string; policy: string; quorum: number }[];
  variables: { name: string; environments: string[] }[];
};

// Starts an export as the signed-in person: the database checks and logs it.
export async function startExport(userId: string, vaultId: string): Promise<ExportHeader> {
  return asPerson(userId, async (c) => (await c.query(`select public.export_vault($1) as h`, [vaultId])).rows[0].h);
}

// A name safe for a file and a folder: lower-case letters, digits, dashes.
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return s || "vault";
}

export function archiveName(h: ExportHeader): string {
  return `${slug(h.vault.name)}-${h.exported_at.slice(0, 10)}.tar.gz`;
}

// ---------------------------------------------------------------------------
// tar

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: Buffer, size: number, mtime: number, type: "0" | "x"): Buffer {
  const h = Buffer.alloc(512);
  name.copy(h, 0, 0, Math.min(name.length, 100));
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

const padding = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);

// One pax record, "<length> path=<value>\n", where length counts itself.
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.concat([Buffer.from(String(len), "ascii"), body]);
}

export function tarEntry(path: string, body: Buffer, mtime: number): Buffer {
  let name = Buffer.from(path, "utf8");
  const parts: Buffer[] = [];
  if (name.length > 100) {
    const pax = paxRecord("path", path);
    parts.push(header(Buffer.from("PaxHeader", "ascii"), pax.length, mtime, "x"), pax, padding(pax.length));
    // The name an extractor that ignores pax sees: the first 100 bytes, if
    // that cut is itself a safe name (it could end in ".." or a dot).
    const cut = name.subarray(0, 100);
    name = entryProblem(cut.toString("utf8")) ? Buffer.from("long-path", "ascii") : cut;
  }
  parts.push(header(name, body.length, mtime, "0"), body, padding(body.length));
  return Buffer.concat(parts);
}

// Two empty blocks end an archive.
export const tarEnd = () => Buffer.alloc(1024);

// ---------------------------------------------------------------------------
// Entry names

// Characters some Windows code pages convert ("best fit") to / \ : or .
// when a program uses the ANSI file APIs: fullwidth and look-alike slashes,
// yen and won signs (\ in Japanese and Korean code pages), fullwidth colon
// and full stop, and friends.
const BEST_FIT = /[\u00a5\u20a9\u2044\u2215\u2236\u2024\u2025\u2026\uff0e\uff0f\uff1a\uff3c\ufe55\ufe52\ufe68]/u;
const DEVICE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])$/;

// Why a vault path can't be an entry name as it is, or null when it can.
export function entryProblem(path: string): string | null {
  if (path === "" || path.length > 1024) return "empty or over 1024 characters";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "a control character";
  if (path.includes("\\")) return "a backslash, a folder separator on Windows";
  if (/[:*?"<>|]/.test(path)) return "a character Windows can't hold in a name (: * ? \" < > |)";
  if (BEST_FIT.test(path)) return "a character Windows can convert to / \\ : or .";
  if (path.startsWith("/")) return "an absolute path";
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return "an empty, . or .. segment";
    if (/[. ]$/.test(seg)) return "a name ending in a dot or a space";
    if (DEVICE.test(seg.split(".")[0].replace(/ +$/, "").toUpperCase())) return "a name Windows reserves for a device";
  }
  return null;
}

// The name under renamed/ for the n-th renamed file: one segment, every
// character entryProblem objects to as "_", no trailing dot or space, and a
// number first, so it is never a device name and never collides.
export function renamedEntry(path: string, n: number): string {
  const flat = [...path]
    // eslint-disable-next-line no-control-regex
    .map((c) => (/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(c) || BEST_FIT.test(c) ? "_" : c))
    .join("")
    .slice(0, 150)
    .replace(/[. ]+$/, "");
  return `${String(n).padStart(4, "0")}-${flat || "file"}`;
}

// ---------------------------------------------------------------------------
// The archive

export type FileRow = { path: string; body: string; updated_at: Date; version_id: string };
// One page of the export's files after `after`, in path order.
export type FilePages = (after: string, limit: number) => Promise<FileRow[]>;

const dbPages = (userId: string, h: ExportHeader): FilePages => (after, limit) =>
  asPerson(userId, async (c) =>
    (
      await c.query(`select path, body, updated_at, version_id from public.export_files($1, $2, $3, $4)`, [
        h.vault.id,
        after,
        limit,
        h.export,
      ])
    ).rows,
  );

export async function writeExport(userId: string, h: ExportHeader, out: Writable, pages: FilePages = dbPages(userId, h)): Promise<void> {
  const root = `${slug(h.vault.name)}-${h.exported_at.slice(0, 10)}`;
  const gz = createGzip();
  const piped = pipeline(gz, out);
  // Waits for the gzip stream to take more, or fails if the download ended.
  const drained = () =>
    new Promise<void>((resolve, reject) => {
      const settle = (err?: Error) => {
        gz.off("drain", ok);
        gz.off("close", closed);
        gz.off("error", settle);
        if (err) reject(err);
        else resolve();
      };
      const ok = () => settle();
      const closed = () => settle(new Error("export aborted"));
      gz.on("drain", ok);
      gz.on("close", closed);
      gz.on("error", settle);
    });
  const put = async (b: Buffer) => {
    if (gz.destroyed) throw new Error("export aborted");
    if (!gz.write(b)) await drained();
  };
  const files: { path: string; archived_as?: string; sha256: string; bytes: number; updated_at: string; version_id: string }[] = [];
  const renamed: { path: string; archived_as: string; why: string }[] = [];
  let total = 0;
  try {
    let after = "";
    for (;;) {
      const rows = await pages(after, PAGE);
      for (const r of rows) {
        const body = Buffer.from(r.body, "utf8");
        total += body.length;
        if (total > STREAM_CAP) throw new Error("export grew past its cap while streaming");
        const why = entryProblem(r.path);
        const entry = why ? `renamed/${renamedEntry(r.path, renamed.length + 1)}` : `files/${r.path}`;
        if (why) renamed.push({ path: r.path, archived_as: entry, why });
        await put(tarEntry(`${root}/${entry}`, body, r.updated_at.getTime() / 1000));
        files.push({
          path: r.path,
          ...(why ? { archived_as: entry } : {}),
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
          updated_at: r.updated_at.toISOString(),
          version_id: r.version_id,
        });
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1].path;
    }
    const manifest = Buffer.from(
      JSON.stringify(
        {
          format: "reliquary-export/1",
          vault: h.vault,
          exported_at: h.exported_at,
          exported_by: h.exported_by,
          layout:
            "Each file's current text is under files/, at its path in the vault. " +
            "A path that another system could read as something else (a backslash, a colon, a name ending in a dot " +
            "or a space, a device name like CON) is under renamed/ instead: renamed lists each one's path in the vault.",
          not_included:
            "Deleted and erased files, earlier versions, proposals, comments and the activity log. " +
            "Environment variable values are never exported: only their names and the environments that have a value.",
          default_policy: h.vault.default_policy,
          rules: h.rules,
          files,
          renamed,
          variables: { values_included: false, names: h.variables },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await put(tarEntry(`${root}/${MANIFEST}`, manifest, Date.parse(h.exported_at) / 1000));
    await put(tarEnd());
    gz.end();
  } catch (err) {
    gz.destroy(err as Error);
  }
  // Rejects (and destroys `out`) if anything above failed: a broken download,
  // never a short archive that looks whole.
  await piped;
}
