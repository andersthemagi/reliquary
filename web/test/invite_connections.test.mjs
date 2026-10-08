// GET /invite and the pool (src/pages.ts, routes()): the page asks the rate
// limit and the invite's state through the pool itself, so it must hold no
// connection of its own while it does. A web pool is 3 and an instance
// shares it between requests: three invite links opened together, each
// holding one while it waited for a second, would stall. Called directly,
// as shell.test.mjs does, with a pool that says what the page holds.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";

const { TEST_DATABASE_URL } = process.env;
process.env.DATABASE_URL = TEST_DATABASE_URL;
const { pool, usePool } = await import("../dist/db.js");
const { routes } = await import("../dist/pages.js");

const ANA = "00000000-0000-0000-0000-00000000000a";
const pages = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
usePool(pages);
after(() => Promise.all([pages.end(), pool.end()]));

test("invite page: a GET holds no connection while the rate limit and the invite are looked up", async () => {
  const heldAt = [];
  const query = pool.query.bind(pool);
  pool.query = (...args) => {
    heldAt.push(pages.totalCount - pages.idleCount);
    return query(...args);
  };
  const reply = await routes({
    userId: ANA,
    csrf: "0",
    url: new URL(`http://web.test/invite?token=rli_${"0".repeat(64)}`),
    form: new URLSearchParams(),
    method: "GET",
    theme: "auto",
    mcpUrl: "",
    setFlash() {},
    ip: "127.0.0.1",
  });
  assert.equal(reply.status, 404);
  assert.ok(heldAt.length >= 2, "both the rate limit and the invite lookup ran");
  assert.deepEqual(heldAt.filter((held) => held !== 0), []);
});
