// Errors the CLI shows as a plain sentence and an exit code. Messages never
// carry a value, a token or a server response body: only fixed text, names
// the person typed, the API's error codes, and the reason, component and
// reference a Reliquary server sends with an error (serverSays below).

import { DEFAULT_SERVER } from "./config.js";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

// Wrong arguments: exit 2, like most command lines.
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

// No connection to this server, or it was revoked or expired.
export class NotSignedIn extends CliError {
  constructor(server: string, why?: string) {
    super(
      why
        ? `${why} (server ${server}). Run \`reliquary login${loginFlag(server)}\` to connect it again.`
        : `The Reliquary CLI isn't connected to ${server}. Run \`reliquary login${loginFlag(server)}\` to connect it.`,
    );
    this.name = "NotSignedIn";
  }
}

const loginFlag = (server: string) => (server === DEFAULT_SERVER ? "" : ` --server ${server}`);

// A file or folder the operating system wouldn't let the CLI use, said the
// way every other failure is: what it was doing, which path, why (the error
// code in words, never the error's own text), and what to do about it. These
// are problems with the computer, not bugs in the CLI, so they must never
// reach the "stopped on a bug" line. `hint` replaces the generic advice
// where the caller knows better (the config directory has a variable).
const FS_REASONS: Record<string, [why: string, fix: string]> = {
  EACCES: ["you don't have permission", "Check who owns it and its folder, and that you may change them."],
  EPERM: ["you don't have permission", "Check who owns it and its folder, and that you may change them."],
  EROFS: ["the file system is read-only", "Use a location you can write to."],
  ENOSPC: ["the disk is full", "Free some space and run the command again."],
  EDQUOT: ["your disk quota is used up", "Free some space and run the command again."],
  EISDIR: ["it is a folder, not a file", "Move or remove the folder, or name another file."],
  ENOTDIR: ["part of that path isn't a folder", "Check the path."],
  EEXIST: ["something that isn't a folder is already there", "Move it aside, or use another path."],
  ENOENT: ["a folder in that path doesn't exist", "Create it, or check the path."],
  ELOOP: ["the path loops through symbolic links", "Check the path."],
  ENAMETOOLONG: ["the path is too long", "Use a shorter path."],
  EMFILE: ["too many files are open", "Close some programs and run the command again."],
  ENFILE: ["too many files are open", "Close some programs and run the command again."],
  EBUSY: ["another program is using it", "Close that program and run the command again."],
};
export function fsFailure(doing: string, file: string, err: unknown, hint?: string): CliError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const known = typeof code === "string" ? FS_REASONS[code] : undefined;
  const why = known?.[0] ?? (typeof code === "string" ? `the system answered ${code}` : "the system refused it");
  return new CliError(`Couldn't ${doing} ${file} (${typeof code === "string" ? code : "no error code"}): ${why}. ${hint ?? known?.[1] ?? "Check the path and its permissions."}`);
}

// What the server said about a failure (docs/public/reference/errors.md):
// its reason, where it broke and the reference, printed so a person can
// report it. The server writes these for people and never puts a value in
// them; the CLI still prints them as plain text only (no control or
// bidirectional characters, which a terminal would act on) and caps them.
// The ref must be 8 hex characters or it is left out.
// The unsafe characters are api.ts's shown() set (C0 and C1 controls, the
// Arabic letter mark, LRM and RLM, line and paragraph separators, bidi
// embeddings and isolates), as code point ranges.
const UNSAFE: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]];
const plain = (s: string) =>
  [...s].map((ch) => (UNSAFE.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b) ? String.fromCodePoint(0xfffd) : ch)).join("");
export function serverSays(body: unknown): string {
  const b = (body ?? {}) as { message?: unknown; where?: unknown; ref?: unknown; error_description?: unknown };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? plain(v.trim()).slice(0, max) : "");
  const message = text(b.message, 400) || text(b.error_description, 400);
  const where = text(b.where, 120);
  const ref = typeof b.ref === "string" && /^[0-9a-f]{8}$/.test(b.ref) ? b.ref : "";
  const parts = [where && `where: ${where}`, ref && `ref ${ref}`].filter(Boolean).join("; ");
  if (!message && !parts) return "";
  return ` The server says: ${message ? message.replace(/\.?$/, ".") : "(no reason)"}${parts ? ` (${parts})` : ""}`;
}
