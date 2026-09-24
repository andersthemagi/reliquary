// Final sweep (docs/research/server-load.md, "Final sweep"): a web file
// save checks its vault inside the write's own query, as the MCP tools do.
// The form handler runs here, in this process (pages.ts routes()), on a pool
// that counts round trips, as Ana on this file's own vault, deleted at the
// end so nothing is left waiting on her.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { asPerson, usePool } from "../dist/db.js";
import { routes } from "../dist/pages.js";

const { TEST_DATABASE_URL } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
const STRANGER = "00000000-0000-0000-0000-0000000005f1";
const NAME = "Final Sweep Saves";

const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
const n = { roundTrips: 0 };
const wrapped = new WeakSet();
db.on("acquire", (client) => {
  if (wrapped.has(client)) return;
  wrapped.add(client);
  const query = client.query.bind(client);
  client.query = (...args) => {
    n.roundTrips++;
    return query(...args);
  };
});
usePool(db);

let vault = "";
before(async () => {
  vault = await asPerson(ANA, async (c) => {
    const id = (await c.query("select public.create_vault($1) as id", [NAME])).rows[0].id;
    await c.query("select public.set_policy($1, 'canon/', 'canon', 1)", [id]);
    return id;
  });
});
after(async () => {
  await asPerson(ANA, (c) => c.query("select public.delete_vault($1, $2)", [vault, NAME]));
  await db.end();
});

// A form POST to /v/<vault>/file, as the server hands it to routes().
async function save(userId, fields) {
  const flashes = [];
  const ctx = {
    userId,
    csrf: "0",
    url: new URL(`http://web.test/v/${vault}/file`),
    form: new URLSearchParams(fields),
    method: "POST",
    theme: "auto",
    mcpUrl: "",
    setFlash: (m) => flashes.push(m),
  };
  n.roundTrips = 0;
  const reply = await routes(ctx);
  return { reply, flashes, roundTrips: n.roundTrips };
}
const bodyOf = async (path) =>
  (
    await asPerson(ANA, (c) =>
      c.query(
        `select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null`,
        [vault, path],
      ),
    )
  ).rows[0]?.body;

test("file saves: a save is one query in its transaction (begin, the write with its vault check, commit)", async () => {
  const w = await save(ANA, { action: "write", path: "notes/a.md", content: "A" });
  assert.equal(w.reply.redirect, `/v/${vault}/file?path=notes%2Fa.md`);
  assert.deepEqual(w.flashes, ["Saved notes/a.md."]);
  assert.equal(w.roundTrips, 3, "before: 4 (the vault lookup was its own query)");
  assert.equal(await bodyOf("notes/a.md"), "A");
  const d = await save(ANA, { action: "delete", path: "notes/a.md" });
  assert.deepEqual(d.flashes, ["Deleted notes/a.md."]);
  assert.equal(d.roundTrips, 3);
  assert.equal(await bodyOf("notes/a.md"), undefined);
});

test("file saves: a new file follows its path's rule in the same one query: open is written, canon is proposed", async () => {
  const open = await save(ANA, { action: "create", path: "notes/new.md", content: "N" });
  assert.deepEqual(open.flashes, ["Saved notes/new.md."]);
  assert.equal(open.roundTrips, 3, "before: 5 (vault lookup, rule, write)");
  assert.equal(await bodyOf("notes/new.md"), "N");
  const canon = await save(ANA, { action: "create", path: "canon/brief.md", content: "B", reason: "why" });
  assert.deepEqual(canon.flashes, ["Proposed. It applies once enough people approve it."]);
  assert.match(canon.reply.redirect, new RegExp(`^/v/${vault}/proposals/[0-9a-f-]{36}$`));
  assert.equal(canon.roundTrips, 3);
  assert.equal(await bodyOf("canon/brief.md"), undefined, "a canon path isn't written, only proposed");
});

test("file saves: someone who isn't a member gets Not found and nothing is written", async () => {
  for (const action of ["write", "create", "delete", "propose"]) {
    const r = await save(STRANGER, { action, path: "notes/intruder.md", content: "X", reason: "x" });
    assert.equal(r.reply.status, 404, action);
    assert.deepEqual(r.flashes, []);
  }
  assert.equal(await bodyOf("notes/intruder.md"), undefined);
});

test("file saves: an unknown action is a bad request, with no query", async () => {
  const r = await save(ANA, { action: "shred", path: "notes/x.md" });
  assert.equal(r.reply.status, 400);
  assert.equal(r.roundTrips, 0);
});
