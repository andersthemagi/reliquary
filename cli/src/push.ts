// `reliquary env push`: a .env file's values, sent for a person to apply in
// the web UI (docs/variables.md, "Imports"). An agent may be the one running
// this, so a push never sets a value: it makes a pending import that an
// owner or editor applies (or rejects) on the vault's Variables page. The
// values go from the file to the server over TLS and nowhere else: this
// prints names, line numbers and reasons, never a value.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { pushStatus, type PushStatus } from "./api.js";
import type { Server } from "./config.js";
import { DOTENV_MAX_BYTES, dotenvTooBig, parseDotenv, type DotenvResult } from "./dotenv.js";
import { CliError, fsFailure } from "./errors.js";

// Reads and parses the file. A directory, a device or anything over the
// limit is refused before its contents are looked at.
export function readDotenv(file: string): DotenvResult {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`There's no ${file}. Name the file with --file.`);
    throw fsFailure("read", file, err);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CliError(`${file} isn't a regular file.`);
    if (st.size > DOTENV_MAX_BYTES) throw new CliError(`${file} is over ${DOTENV_MAX_BYTES / 1024} KiB; that isn't a .env file.`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString("utf8");
    const big = dotenvTooBig(text);
    if (big) throw new CliError(`${file} can't be sent: ${big}.`);
    return parseDotenv(text);
  } finally {
    closeSync(fd);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Polls a push until a person decides, it expires, or `timeoutMs` passes
// (then "pending"). Starts at 2 s and backs off to 15 s: a person takes
// minutes, and every poll is a request the server has to answer.
export async function waitForDecision(
  server: Server,
  id: string,
  timeoutMs: number,
  opts: { firstMs?: number; maxMs?: number } = {},
): Promise<PushStatus> {
  const until = Date.now() + timeoutMs;
  let delay = opts.firstMs ?? 2000;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) return "pending";
    await sleep(Math.min(delay, left));
    const s = await pushStatus(server, id);
    if (s !== "pending") return s;
    delay = Math.min(Math.round(delay * 1.5), opts.maxMs ?? 15_000);
  }
}
