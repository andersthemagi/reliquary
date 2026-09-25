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

// No sign-in for this server, or it was revoked or expired.
export class NotSignedIn extends CliError {
  constructor(server: string, why = "You're not signed in") {
    super(`${why} to ${server}. Run \`reliquary login${loginFlag(server)}\`.`);
    this.name = "NotSignedIn";
  }
}

const loginFlag = (server: string) => (server === DEFAULT_SERVER ? "" : ` --server ${server}`);

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
