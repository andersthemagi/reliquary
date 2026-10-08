// The database dropping a connection (src/db.ts): the real pool against the
// test database, whose backend is terminated from a second connection, as a
// pooler reset or a restart would. An unhandled 'error' event ends the
// node:test run, as it would end the web process.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";

const { TEST_DATABASE_URL } = process.env;
process.env.DATABASE_URL = TEST_DATABASE_URL;
const { asPerson, pool } = await import("../dist/db.js");

const PERSON = "00000000-0000-0000-0000-0000000000d0";
const killer = new pg.Client({ connectionString: TEST_DATABASE_URL });
await killer.connect();
after(() => Promise.all([pool.end(), killer.end()]));

// Terminates the client's backend and waits until pg has finished reporting it.
async function drop(client) {
  const { rows } = await client.query("select pg_backend_pid() as pid");
  // Not events.once: it rejects on the very 'error' being waited out.
  const ended = new Promise((resolve) => client.once("end", resolve));
  await killer.query("select pg_terminate_backend($1)", [rows[0].pid]);
  await ended;
}

function captureErrors(t) {
  const lines = [];
  t.mock.method(console, "error", (...args) => lines.push(args.join(" ")));
  return lines;
}

function assertLoggedOnce(lines) {
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^failure ref=[0-9a-f]{8} \{.*"what":"db connection".*"where":"database"/);
  assert.ok(!lines[0].includes(TEST_DATABASE_URL), "the line holds the connection string");
}

test("db connection loss: a connection dropped under a request fails that request, is logged once with a ref and does not end the process", async (t) => {
  const lines = captureErrors(t);
  await assert.rejects(asPerson(PERSON, drop));
  assertLoggedOnce(lines);
});

test("db connection loss: an idle connection dropped is logged once with a ref, and the pool connects again", async (t) => {
  const lines = captureErrors(t);
  const client = await pool.connect();
  client.release();
  await drop(client);
  assertLoggedOnce(lines);
  assert.equal((await pool.query("select 1 as one")).rows[0].one, 1);
});
