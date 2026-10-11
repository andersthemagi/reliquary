// The error model's pieces (src/failure.ts, src/errorpage.ts): SQLSTATE
// names and statuses, redaction, classifying an error into what, where and
// why, the log line, and the rule that nothing says "something went wrong".
// No server needed.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO = process.env.REPO_DIR ?? new URL("../..", import.meta.url).pathname;
const f = await import("../dist/failure.js");
const { describe, refusalText } = await import("../dist/errorpage.js");

// An error as node-postgres builds it from a server's ErrorResponse.
const pgError = (fields) => Object.assign(new Error(fields.message ?? "error"), { severity: "ERROR", ...fields });

// Console output while fn runs, one string.
function capture(fn) {
  const out = [];
  const orig = { error: console.error, info: console.info };
  console.error = (...a) => out.push(a.join(" "));
  console.info = (...a) => out.push(a.join(" "));
  try {
    return { value: fn(), out: out.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

test("errors: SQLSTATE codes are named, with their class when the code isn't listed", () => {
  assert.equal(f.sqlstateName("23505"), "23505 unique violation");
  assert.equal(f.sqlstateName("42501"), "42501 permission denied");
  assert.equal(f.sqlstateName("08006"), "08006 connection failure");
  assert.equal(f.sqlstateName("57014", "canceling statement due to statement timeout"), "57014 statement timeout");
  assert.equal(f.sqlstateName("57014", "canceling statement due to user request"), "57014 query canceled by request");
  assert.equal(f.sqlstateName("55P03", "canceling statement due to lock timeout"), "55P03 lock timeout");
  assert.equal(f.sqlstateName("23999"), "23999 integrity constraint violation");
  assert.equal(f.sqlstateName("RLV01"), "RLV01 no such vault for you");
  assert.equal(f.sqlstateName("ZZ999"), "ZZ999");
  assert.equal(f.sqlstateName("RLW01"), "RLW01 step already claimed");
  assert.equal(f.sqlstateName("RLW02"), "RLW02 step not available");
  assert.equal(f.sqlstateName("RLW03"), "RLW03 stale step claim");
  assert.equal(f.sqlstateName("RLW04"), "RLW04 step claim past its hold limit");
});

test("errors: each SQLSTATE maps to the HTTP status a person or client can act on", () => {
  const cases = {
    "42501": 403, P0002: 404, RLV01: 404, "22023": 400, "22P02": 400, "23505": 409, "23503": 409, "55000": 409,
    "57014": 504, "55P03": 504, "08006": 503, "53300": 503, "57P01": 503, "40001": 503, "54000": 413, XX000: 500, "42883": 500,
    RLW01: 409, RLW02: 409, RLW03: 409,
    RLW04: 403,
  };
  for (const [code, status] of Object.entries(cases)) assert.equal(f.sqlstateStatus(code), status, code);
});

test("errors: an account not admitted while invite-only (RLP02) is named, refused with 403, and shows the database's reason", () => {
  assert.equal(f.sqlstateName("RLP02"), "RLP02 account not admitted");
  assert.equal(f.sqlstateStatus("RLP02"), 403);
  const k = f.classify(pgError({
    code: "RLP02", message: "your account can't create vaults yet: Reliquary is invite-only during alpha. Open an invite link someone sent you and join their vault (that admits your account), or ask the operator to admit you",
    routine: "exec_stmt_raise", where: "PL/pgSQL function private.admission_refusal() line 3 at RAISE\nSQL statement \"SELECT private.admission_refusal()\"\nPL/pgSQL function public.create_vault(text,text) line 14 at PERFORM",
  }));
  assert.equal(k.status, 403);
  assert.equal(k.where, "database (function private.admission_refusal)");
  assert.match(k.why, /^Your account can't create vaults yet: Reliquary is invite-only during alpha\. .* ask the operator to admit you\.$/);
});

test("errors: redaction drops every parenthesised value and quoted input", () => {
  assert.equal(f.redactParens("Key (email)=(ana@example.test) already exists."), "Key (…)=(…) already exists.");
  assert.equal(f.redactParens("Failing row contains (SEKRIT, (nested SEKRIT), 3)."), "Failing row contains (…).");
  assert.equal(f.redactParens("unclosed (SEKRIT"), "unclosed (…)");
  assert.equal(f.redact('invalid input syntax for type uuid: "SEKRIT-1"'), 'invalid input syntax for type uuid: "…"');
  assert.equal(f.redact("value 'SEKRIT-2' is out of range"), "value '…' is out of range");
  assert.ok(f.redact("x".repeat(2000)).length <= 500);
});

test("errors: our own raised exception shows its message, from the function that raised it", () => {
  const k = f.classify(pgError({
    code: "42501", message: "only owners set rules", routine: "exec_stmt_raise",
    where: "PL/pgSQL function public.set_policy(uuid,text,text,integer) line 9 at RAISE",
  }));
  assert.deepEqual([k.status, k.where, k.why], [403, "database (function public.set_policy)", "Only owners set rules."]);
});

test("errors: a Postgres error shows its SQLSTATE and the object, never the row's values", () => {
  const unique = f.classify(pgError({
    code: "23505", message: 'duplicate key value violates unique constraint "uniq_v_key"', routine: "_bt_check_unique",
    constraint: "uniq_v_key", table: "uniq", schema: "test_faults", detail: "Key (v)=(SEKRIT-3) already exists.",
  }));
  assert.equal(unique.status, 409);
  assert.equal(unique.where, "database");
  assert.equal(unique.why, '23505 unique violation: duplicate key value violates unique constraint "uniq_v_key".');
  assert.equal(unique.log.detail, "Key (…)=(…) already exists.");
  assert.doesNotMatch(JSON.stringify(unique), /SEKRIT/);

  // A message that quotes the input is never shown.
  const syntax = f.classify(pgError({ code: "22P02", message: 'invalid input syntax for type uuid: "SEKRIT-4"', routine: "string_to_uuid" }));
  assert.equal(syntax.why, "22P02 invalid text representation.");
  assert.doesNotMatch(JSON.stringify(syntax), /SEKRIT/);
});

test("errors: a statement timeout says which function ran out of time", () => {
  const k = f.classify(pgError({
    code: "57014", message: "canceling statement due to statement timeout", routine: "ProcessInterrupts",
    where: "PL/pgSQL function test_faults.fire() line 12 at PERFORM\nSQL statement \"insert into public.file_versions values ($1)\"\nPL/pgSQL function private.apply_write(uuid,text,text,uuid,text,uuid) line 7 at SQL statement",
  }));
  assert.equal(k.status, 504);
  assert.equal(k.where, "database (function test_faults.fire)");
  assert.equal(k.why, "57014 statement timeout: test_faults.fire ran past the database’s time limit and was stopped.");
  assert.equal(k.log.functions, "test_faults.fire line 12 < private.apply_write line 7");
  assert.doesNotMatch(JSON.stringify(k), /insert into/);
});

test("errors: connection failures, pool timeouts and network codes are told apart", () => {
  const pool = f.classify(new Error("timeout exceeded when trying to connect"));
  assert.deepEqual([pool.status, pool.where], [503, "database"]);
  assert.match(pool.why, /pool connect timeout/);
  const refused = f.classify(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }));
  assert.deepEqual([refused.status, refused.where, refused.why], [503, "network", "Connection refused (ECONNREFUSED)."]);
  const tls = f.classify(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), "sign-in (Supabase Auth)");
  assert.deepEqual([tls.status, tls.where, tls.why], [503, "sign-in (Supabase Auth)", "TLS certificate check failed (CERT_HAS_EXPIRED)."]);
  const broken = f.classify(pgError({ code: "08006", message: "connection failure", routine: "x" }));
  assert.equal(broken.status, 503);
  assert.match(broken.why, /^08006 connection failure: the database connection broke\.$/);
});

test("errors: a bug is named by its kind and place, and a message that could hold data is left out", () => {
  const bug = f.classify(new TypeError("Cannot read properties of undefined (reading 'r')"));
  assert.equal(bug.status, 500);
  assert.match(bug.why, /^TypeError: Cannot read properties of undefined \(…\).* a bug in Reliquary\.$/);
  const json = f.classify(new SyntaxError('Unexpected token \'S\', "SEKRIT-5" is not valid JSON'));
  assert.doesNotMatch(json.why, /SEKRIT/);
  assert.match(json.why, /^SyntaxError/);
  const refusal = f.classify(new f.Refusal({ status: 402, where: "plan limits", why: "Your plan holds 3 vaults" }));
  assert.deepEqual([refusal.status, refusal.where, refusal.why], [402, "plan limits", "Your plan holds 3 vaults."]);
});

test("errors: a failure is logged once, searchable by its ref, with the detail but no values or emails", () => {
  const { value, out } = capture(() =>
    f.withRequest("Saving canon/SEKRIT-path.md", "POST /v/:id/file", () =>
      f.fail(pgError({
        code: "23503", message: 'insert or update on table "child" violates foreign key constraint "child_v_fkey"', routine: "ri_ReportViolation",
        constraint: "child_v_fkey", table: "child", detail: "Key (v)=(SEKRIT-6) is not present in table \"parent\".", hint: "ask ana@example.test",
      })),
    ),
  );
  assert.equal(value.what, "Saving canon/SEKRIT-path.md");
  assert.match(value.ref, /^[0-9a-f]{8}$/);
  assert.equal(out.split("\n").length, 1);
  assert.ok(out.startsWith(`failure ref=${value.ref} {`), out);
  const logged = JSON.parse(out.slice(out.indexOf("{")));
  assert.equal(logged.what, "POST /v/:id/file");
  assert.equal(logged.sqlstate, "23503");
  assert.equal(logged.constraint, "child_v_fkey");
  assert.equal(logged.detail, "Key (…)=(…) is not present in table \"parent\".");
  assert.doesNotMatch(out, /SEKRIT|@/);
});

test("errors: one reference per request, shown in every format with what, where and why", () => {
  const fl = f.withRequest("Reading development in vault 1a2b3c4d", "env api GET", () =>
    capture(() => f.failure({ status: 504, where: "env API: database", why: "57014 statement timeout" })).value,
  );
  assert.equal(f.compact(fl), `Reading development in vault 1a2b3c4d failed: 57014 statement timeout (where: env API: database; ref ${fl.ref})`);
  assert.deepEqual(f.apiBody(fl, "server_error"), {
    error: "server_error", message: "Reading development in vault 1a2b3c4d failed: 57014 statement timeout.", where: "env API: database", ref: fl.ref,
  });
  assert.match(f.plainText(fl), new RegExp(`^Reliquary error\nwhat:  Reading development in vault 1a2b3c4d\nwhere: env API: database\nwhy:   57014 statement timeout\\.\nref:   ${fl.ref}\nstatus: 504$`));
  const [a, b] = [f.withRequest("x", "x", () => f.current().ref), f.withRequest("x", "x", () => f.current().ref)];
  assert.notEqual(a, b);
});

test("errors: a request is described by what it does; typed paths are shown only when plain, and never logged", () => {
  const V = "3f2a9c1d-0000-4000-8000-000000000000";
  const form = (o) => new URLSearchParams(o);
  const d = describe("POST", new URL(`http://x/v/${V}/file`), form({ action: "write", path: "canon/pricing.md" }));
  assert.equal(d.what, "Saving canon/pricing.md in vault 3f2a9c1d");
  assert.equal(d.log, `POST /v/:id/file ${V} action=write`);
  assert.equal(describe("POST", new URL(`http://x/v/${V}/file`), form({ action: "write", path: "../ECHO\nx.md" })).what, "Saving a file in vault 3f2a9c1d");
  assert.equal(describe("POST", new URL(`http://x/v/${V}/proposals/${V}/decide`), form({ decision: "reject" })).what, "Rejecting proposal 3f2a9c1d in vault 3f2a9c1d");
  assert.equal(describe("GET", new URL("http://x/review"), form({})).what, "Opening Review");
  assert.equal(describe("GET", new URL(`http://x/v/${V}/file?path=notes%2Fa.md`), form({})).what, "Opening notes/a.md in vault 3f2a9c1d");
});

test("errors: a refusal from the database is shown with its reason and reference; anything else goes on to the error page", () => {
  const { value, out } = capture(() => refusalText(pgError({ code: "42501", message: "only owners set rules", routine: "exec_stmt_raise" })));
  assert.match(value, /^Only owners set rules\. \(ref [0-9a-f]{8}\)$/);
  assert.match(out, /^failure ref=[0-9a-f]{8} .*"sqlstate":"42501"/);
  assert.throws(() => capture(() => refusalText(new TypeError("boom"))), TypeError);
});

test("errors: the web app's and the MCP server's error models are the same file", () => {
  assert.equal(readFileSync(join(REPO, "web/src/failure.ts"), "utf8"), readFileSync(join(REPO, "mcp/src/failure.ts"), "utf8"));
});

test("errors: no source says something went wrong or an error occurred", () => {
  const banned = /something went wrong|went wrong|an error occurred/i;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(name) && banned.test(readFileSync(p, "utf8"))) hits.push(p.slice(REPO.length));
    }
  };
  for (const dir of ["web/src", "mcp/src", "cli/src", "mcp/netlify", "web/netlify"]) walk(join(REPO, dir));
  assert.deepEqual(hits, []);
});
