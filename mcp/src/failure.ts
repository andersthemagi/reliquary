// The error model (docs/public/reference/errors.md). Every failure shown to a
// person or an agent says what was being done, where it broke, why, and a
// reference id that is also in the server log with the full detail, so the
// owner can find it by searching the ref.
//
//   what   the operation: "Saving canon/pricing.md", "Signing in"
//   where  the component: database, sign-in (Supabase Auth), encryption,
//          rate limit, MCP tool <name>, env API, OAuth, network, web app
//   why    the real reason: our own raised exceptions' messages (written for
//          people), else the SQLSTATE and its name with the constraint or
//          function, an upstream's status, which call timed out
//   ref    8 hex characters per request: `ref 7f3a2c9e`
//
// Never in a shown message or a log line: a variable's value, a token, a
// key, a password, a file's text, a request body or query text. Postgres
// `detail` can hold row values ("Key (email)=(...)"): it is logged only
// with every parenthesised part redacted, and never shown. Messages Postgres
// writes itself (not our RAISEs) can quote input ("invalid input syntax for
// type uuid: \"...\""), so they are never shown, and logged redacted.
//
// The same file is mcp/src/failure.ts (separate deployables, no shared
// package); web/test/errors_unit.test.mjs fails if they differ.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type Failure = {
  status: number;
  what: string;
  where: string;
  why: string;
  ref: string;
};

// A failure we raise ourselves with its reason already written for people
// (a validation, a limit, an upstream we checked). Thrown anywhere in a
// request, it reaches the person or agent as it is.
export class Refusal extends Error {
  readonly status: number;
  readonly where: string;
  readonly code: string;
  constructor(o: { status: number; where: string; why: string; code?: string }) {
    super(o.why);
    this.name = "Refusal";
    this.status = o.status;
    this.where = o.where;
    this.code = o.code ?? "refused";
  }
}

export const newRef = (): string => randomBytes(4).toString("hex");

// ---------------------------------------------------------------------------
// The request's context: one ref per request, and what it is doing.
// `what` may be shown (it can name a path the person typed); `logWhat` is
// what the log says (no user text: a route's shape and ids).

type Context = { ref: string; what: string; logWhat: string; upstream?: { where: string; why: string } };
const store = new AsyncLocalStorage<Context>();

export function withRequest<T>(what: string, logWhat: string, fn: () => T): T {
  return store.run({ ref: newRef(), what, logWhat }, fn);
}

export function current(): { ref: string; what: string; logWhat: string } {
  const c = store.getStore();
  return c ?? { ref: newRef(), what: "Handling a request", logWhat: "request" };
}

// Refines what the request is doing, once a handler knows more.
export function doing(what: string, logWhat?: string): void {
  const c = store.getStore();
  if (!c) return;
  c.what = what;
  if (logWhat) c.logWhat = logWhat;
}

// An upstream failure noted where it happened (a sign-in call that timed
// out), for the answer built further up that only knows "unavailable".
export function noteUpstream(where: string, why: string): void {
  const c = store.getStore();
  if (c) c.upstream = { where, why };
}
export function upstreamNote(): { where: string; why: string } | undefined {
  return store.getStore()?.upstream;
}

// ---------------------------------------------------------------------------
// SQLSTATE names (PostgreSQL, Appendix A). Codes first, then their class.

const CODES: Record<string, string> = {
  "08000": "connection exception",
  "08001": "unable to connect",
  "08003": "connection does not exist",
  "08004": "connection rejected",
  "08006": "connection failure",
  "08P01": "protocol violation",
  "0A000": "feature not supported",
  "21000": "cardinality violation",
  "22001": "value too long",
  "22003": "numeric value out of range",
  "22007": "invalid datetime format",
  "22008": "datetime field overflow",
  "22012": "division by zero",
  "22021": "invalid byte sequence",
  "22023": "invalid parameter value",
  "22P02": "invalid text representation",
  "23000": "integrity constraint violation",
  "23502": "not null violation",
  "23503": "foreign key violation",
  "23505": "unique violation",
  "23514": "check violation",
  "23P01": "exclusion violation",
  "25001": "active transaction",
  "25006": "read only transaction",
  "25P02": "in failed transaction",
  "28000": "invalid authorization",
  "28P01": "invalid password",
  "3D000": "database does not exist",
  "40001": "serialization failure",
  "40P01": "deadlock detected",
  "42501": "permission denied",
  "42601": "syntax error",
  "42703": "undefined column",
  "42883": "undefined function",
  "42P01": "undefined table",
  "53000": "insufficient resources",
  "53100": "disk full",
  "53200": "out of memory",
  "53300": "too many connections",
  "54000": "program limit exceeded",
  "55000": "object not in prerequisite state",
  "55P03": "lock not available",
  "57014": "query canceled",
  "57P01": "admin shutdown",
  "57P02": "crash shutdown",
  "57P03": "cannot connect now",
  "58000": "system error",
  P0001: "raised exception",
  P0002: "no data found",
  P0003: "too many rows",
  P0004: "assert failure",
  XX000: "internal error",
  XX001: "data corrupted",
};
const CLASSES: Record<string, string> = {
  "08": "connection exception",
  "0A": "feature not supported",
  "21": "cardinality violation",
  "22": "data exception",
  "23": "integrity constraint violation",
  "25": "invalid transaction state",
  "28": "invalid authorization",
  "3D": "invalid catalog name",
  "40": "transaction rollback",
  "42": "syntax error or access rule violation",
  "53": "insufficient resources",
  "54": "program limit exceeded",
  "55": "object not in prerequisite state",
  "57": "operator intervention",
  "58": "system error",
  P0: "PL/pgSQL error",
  XX: "internal error",
};
// Reliquary's own codes (raised by our migrations).
const OWN_CODES: Record<string, string> = {
  RLV01: "no such vault for you",
  RLP01: "plan limit reached",
  RLP02: "account not admitted",
  RLA01: "session ended",
};

export function sqlstateName(code: string, message = ""): string {
  if (code === "57014") {
    if (/statement timeout/i.test(message)) return "57014 statement timeout";
    if (/user request/i.test(message)) return "57014 query canceled by request";
  }
  if (code === "55P03" && /lock timeout/i.test(message)) return "55P03 lock timeout";
  const name = CODES[code] ?? OWN_CODES[code] ?? CLASSES[code.slice(0, 2)];
  return name ? `${code} ${name}` : code;
}

// HTTP status for a SQLSTATE.
export function sqlstateStatus(code: string): number {
  if (code === "42501") return 403;
  if (code === "P0002" || code === "RLV01") return 404;
  // A plan limit (20260925230000_plans.sql): allowed, but not with room.
  if (code === "RLP01") return 403;
  // An account not admitted while Reliquary is invite-only
  // (20260925240000_admission.sql): signed in, but not let in.
  if (code === "RLP02") return 403;
  // A session its person signed out everywhere after, or a deleted
  // account's (20260926140000_sign_out_everywhere.sql): sign in again.
  if (code === "RLA01") return 401;
  if (code === "57014" || code === "55P03") return 504;
  if (code === "40001" || code === "40P01") return 503;
  if (code === "25006") return 503;
  const cls = code.slice(0, 2);
  if (cls === "22") return 400;
  if (cls === "23" || cls === "55" || cls === "21") return 409;
  if (cls === "08" || cls === "53" || cls === "57" || cls === "28" || cls === "3D") return 503;
  if (cls === "54") return 413;
  return 500;
}

// ---------------------------------------------------------------------------
// Redaction, for anything logged that Postgres or a library wrote.

// Every parenthesised part becomes (…): row values in "Key (email)=(...)"
// and "Failing row contains (...)". Nested parentheses are taken whole.
export function redactParens(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") {
      if (depth === 0) out += "(…";
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      if (depth === 0) out += ")";
    } else if (depth === 0) out += ch;
  }
  if (depth > 0) out += ")";
  return out;
}

// Quoted parts too ("..." and '...'): Postgres quotes the input it refused.
export function redact(s: string): string {
  return redactParens(s)
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Classifying an error

type PgError = {
  code?: string;
  message?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  where?: string;
  routine?: string;
  constraint?: string;
  table?: string;
  column?: string;
  schema?: string;
  dataType?: string;
};

// Codes whose Postgres message names only objects (a table, a constraint, a
// function, a column), never a value: "duplicate key value violates unique
// constraint \"x\"" (the values are in `detail`, never shown).
const NAMES_ONLY = new Set(["42501", "23505", "23503", "23502", "23514", "23P01", "42883", "42P01", "42703", "25006", "25P02"]);

const isPg = (e: PgError): boolean =>
  typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === "string";

// Our own RAISE (PL/pgSQL's exec_stmt_raise): its message was written by a
// migration for people. Reliquary's own codes count as ours too.
export const ownRaise = (e: PgError): boolean => isPg(e) && (e.routine === "exec_stmt_raise" || e.code! in OWN_CODES);

// The SQL functions in Postgres's context line, innermost first, with their
// line: "public.write_file line 12". Never the statement text around them.
export function pgFunctions(where: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (where ?? "").matchAll(/function ([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\([^)]*\)(?: line (\d+))?/g)) {
    const f = m[2] ? `${m[1]} line ${m[2]}` : m[1];
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

const sentence = (m: string) => {
  const t = m.trim();
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
};

// Node's network error codes, in words.
const NET: Record<string, string> = {
  ENOTFOUND: "DNS lookup failed (ENOTFOUND)",
  EAI_AGAIN: "DNS lookup failed for now (EAI_AGAIN)",
  ECONNREFUSED: "connection refused (ECONNREFUSED)",
  ECONNRESET: "the connection was reset (ECONNRESET)",
  ETIMEDOUT: "the connection timed out (ETIMEDOUT)",
  EPIPE: "the connection closed while sending (EPIPE)",
  EHOSTUNREACH: "host unreachable (EHOSTUNREACH)",
  ENETUNREACH: "network unreachable (ENETUNREACH)",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out (UND_ERR_CONNECT_TIMEOUT)",
  UND_ERR_SOCKET: "the connection closed unexpectedly (UND_ERR_SOCKET)",
  UND_ERR_HEADERS_TIMEOUT: "no response headers in time (UND_ERR_HEADERS_TIMEOUT)",
};
const TLS = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;

// A network-level cause, from the error or its cause chain.
export function networkReason(err: unknown): string | null {
  for (let e = err as { code?: unknown; cause?: unknown; name?: unknown } | undefined, i = 0; e && i < 4; e = e.cause as typeof e, i++) {
    const code = typeof e.code === "string" ? e.code : "";
    if (NET[code]) return NET[code];
    if (TLS.test(code)) return `TLS certificate check failed (${code})`;
    if (e.name === "TimeoutError") return "no answer in time (timeout)";
  }
  return null;
}

// The first frame of a stack that is ours: "dist/pages.js:123:45".
export function location(err: unknown): string {
  const stack = typeof (err as Error)?.stack === "string" ? (err as Error).stack! : "";
  for (const line of stack.split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?[^()\s]*\/(?:dist|src)\/[^()\s]+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (m && !m[1].includes("node_modules")) return `${m[1].replace(/^.*\/(dist|src)\//, "$1/")}:${m[2]}`;
  }
  return "";
}

// Stack frames only (never the message line, which may carry a value).
const frames = (err: unknown): string => {
  const stack = typeof (err as Error)?.stack === "string" ? (err as Error).stack! : "";
  return stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .slice(0, 8)
    .map((l) => l.trim().replace(/^at /, ""))
    .join(" | ");
};

export type Classified = {
  status: number;
  where: string;
  why: string;
  // Extra, for the log only: never shown.
  log: Record<string, string | undefined>;
};

// What an error means. `where` is the component when the error itself
// doesn't say (a pg error is always the database).
export function classify(err: unknown, where = "web app"): Classified {
  if (err instanceof Refusal) return { status: err.status, where: err.where, why: sentence(err.message), log: { code: err.code } };
  const e = (err ?? {}) as PgError & { name?: string };
  if (isPg(e)) {
    const code = e.code!;
    const fns = pgFunctions(e.where);
    const place = fns.length ? `database (function ${fns[0].replace(/ line \d+$/, "")})` : "database";
    const log = {
      sqlstate: code,
      message: ownRaise(e) ? e.message : redact(e.message ?? ""),
      detail: e.detail ? redactParens(e.detail) : undefined,
      hint: e.hint ? redact(e.hint) : undefined,
      functions: fns.join(" < ") || undefined,
      constraint: e.constraint,
      table: e.table ? `${e.schema ? `${e.schema}.` : ""}${e.table}` : undefined,
      column: e.column,
      routine: e.routine,
    };
    if (ownRaise(e)) {
      return { status: sqlstateStatus(code), where: place, why: sentence(e.message ?? sqlstateName(code)), log };
    }
    const on = e.constraint
      ? ` on constraint ${e.constraint}`
      : e.table
        ? ` on table ${e.table}${e.column ? `, column ${e.column}` : ""}`
        : e.dataType
          ? ` for type ${e.dataType}`
          : "";
    // Postgres's own words where they name only objects, never values.
    const said = NAMES_ONLY.has(code) && e.message ? `: ${e.message}` : on;
    let why = `${sqlstateName(code, e.message)}${said}`;
    if (code === "57014" && /statement timeout/i.test(e.message ?? "")) {
      why += fns.length ? `: ${fns[0].replace(/ line \d+$/, "")} ran past the database’s time limit and was stopped` : ": the query ran past the database’s time limit and was stopped";
    } else if (code === "55P03") why += ": waited too long for a lock another request held";
    else if (code === "40001" || code === "40P01") why += ": two requests collided; running it again usually works";
    else if (code.startsWith("08") || code === "57P01" || code === "57P03") why += ": the database connection broke";
    else if (code === "53300") why += ": the database has no free connections";
    return { status: sqlstateStatus(code), where: place, why: sentence(why), log };
  }
  const msg = typeof (err as Error)?.message === "string" ? (err as Error).message : "";
  // node-postgres's own errors (no SQLSTATE): the pool and the connection.
  if (/timeout exceeded when trying to connect|connection timeout/i.test(msg)) {
    return { status: 503, where: "database", why: "No database connection in time: the database or its pooler didn’t answer (pool connect timeout).", log: { message: msg } };
  }
  if (/Connection terminated|Client has encountered a connection error|Client was closed/i.test(msg)) {
    return { status: 503, where: "database", why: "The database connection closed in the middle of the request.", log: { message: redact(msg) } };
  }
  const net = networkReason(err);
  if (net) {
    const code = String((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? "");
    const status = /timeout|timed out/i.test(net) ? 504 : 503;
    return { status, where: where === "web app" ? "network" : where, why: sentence(net), log: { code } };
  }
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const at = location(err);
  // TypeError and ReferenceError messages name code, not data; any other
  // message (JSON.parse's quotes its input) is left out.
  const said = name === "TypeError" || name === "ReferenceError" ? `: ${redact(msg)}` : "";
  return {
    status: 500,
    where: where === "web app" || !where ? `${where || "web app"}${at ? ` (${at})` : ""}` : where,
    why: sentence(`${name}${said}${at ? ` at ${at}` : ""}, a bug in Reliquary`),
    log: { name, code: typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined },
  };
}

// ---------------------------------------------------------------------------
// The failure, logged

// Builds the failure for the current request and logs it, one line that
// starts with `failure ref=<ref>` (searchable in Vercel's logs), then the
// detail as JSON. 5xx at error level, the rest at info.
export function fail(err: unknown, o: { where?: string; what?: string; status?: number } = {}): Failure {
  const c = current();
  const k = classify(err, o.where);
  // The caller's component, then the part inside it that failed: "MCP tool
  // write_file: database (function public.write_file)".
  const where = o.where && k.where !== o.where && !k.where.startsWith(o.where) ? `${o.where}: ${k.where}` : k.where;
  const f: Failure = { status: o.status ?? k.status, what: o.what ?? c.what, where, why: k.why, ref: c.ref };
  logFailure(f, c.logWhat, k.log, err);
  return f;
}

// A failure we already understand (no error object): logs it the same way.
export function failure(o: { status: number; where: string; why: string; what?: string; code?: string }): Failure {
  const c = current();
  const f: Failure = { status: o.status, what: o.what ?? c.what, where: o.where, why: sentence(o.why), ref: c.ref };
  logFailure(f, c.logWhat, { code: o.code }, undefined);
  return f;
}

export function logFailure(f: Failure, logWhat: string, extra: Record<string, string | undefined>, err: unknown): void {
  const detail: Record<string, string | number> = { status: f.status, what: logWhat, where: f.where };
  // The shown reason is safe to log, except where it may name user text
  // (an own raise can name an environment the person typed): logged as is,
  // since it is exactly what was shown to them.
  detail.why = f.why;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") detail[k] = v;
  // No email address in a log line, even one a message was written with.
  for (const [k, v] of Object.entries(detail)) if (typeof v === "string") detail[k] = v.replace(/[^\s"'(),;:<>@]+@[^\s"'(),;:<>@]+/g, "<email>");
  const stack = err instanceof Error && !(err instanceof Refusal) && f.status >= 500 ? frames(err) : "";
  if (stack) detail.stack = stack;
  const line = `failure ref=${f.ref} ${JSON.stringify(detail)}`;
  if (f.status >= 500) console.error(line);
  else console.info(line);
}

// One line for agents and terminals: what failed, why, where, and the ref.
export function compact(f: Failure): string {
  return `${f.what} failed: ${f.why.replace(/\.$/, "")} (where: ${f.where}; ref ${f.ref})`;
}

// The same fields as plain text, for "Copy details".
export function plainText(f: Failure, extra: Record<string, string> = {}): string {
  const lines = [
    "Reliquary error",
    `what:  ${f.what}`,
    `where: ${f.where}`,
    `why:   ${f.why}`,
    `ref:   ${f.ref}`,
    `status: ${f.status}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join("\n");
}

// JSON for an API answer: {"error","message","where","ref"}; `error` keeps
// the endpoint's own codes.
export function apiBody(f: Failure, error: string): { error: string; message: string; where: string; ref: string } {
  return { error, message: `${f.what} failed: ${f.why}`, where: f.where, ref: f.ref };
}
