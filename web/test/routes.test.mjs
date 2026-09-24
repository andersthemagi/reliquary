// Contract: every page the UI links to still answers. A table of GET routes,
// signed in as Ana, each expected to render (200) with the shared page
// shell; unknown paths and malformed ids stay 404. Removing or renaming a
// route fails here, so it has to be deliberate (a Changes-behaviour
// trailer, see docs/research/testing-strategy.md). Only GETs: POST routes
// are covered by the behaviour tests that use them (csrf is checked before
// routing, so a bare POST can't tell a real route from a missing one).
// Seed: test/seed.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, PROPOSAL, LOGIN_FILE } = process.env;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

const pages = [
  ["/", "home"],
  ["/review", "review inbox"],
  ["/activity", "activity across my vaults"],
  ["/connect", "connect a client"],
  ["/tokens", "tokens"],
  ["/vaults/new", "new vault"],
  [V, "vault root folder"],
  [`${V}/tree?path=notes`, "folder"],
  [`${V}/file?path=notes/md.md`, "file"],
  [`${V}/file?path=notes/md.md&tab=history`, "file history"],
  [`${V}/edit?path=notes/md.md`, "edit an open file"],
  [`${V}/new?dir=notes`, "new file"],
  [`${V}/proposals`, "proposal list"],
  [`${V}/proposals?status=closed`, "closed proposals"],
  [`${V}/activity`, "vault activity"],
  [`${V}/log`, "vault activity (old URL)"],
  [`${V}/rules`, "rules"],
  [`${V}/rules?check=canon/pricing.md`, "rules checker"],
  [`${V}/search?q=standup`, "search"],
  [`${V}/proposals/${PROPOSAL}`, "proposal"],
  [`${V}/proposals/${PROPOSAL}?view=split`, "proposal, split diff"],
  [`${V}/proposals/${PROPOSAL}?view=rendered`, "proposal, rendered"],
  [`${V}/proposals/${PROPOSAL}/edit`, "edit, then approve"],
  [`${V}/variables`, "variables"],
  [`${V}/variables/log`, "variables access log"],
  [`${V}/config`, "vault settings"],
  [`${V}/config/export`, "export a vault"],
  [`${V}/config/delete`, "delete a vault (confirm)"],
  [`${V}/erase?path=notes/md.md`, "erase a file (confirm)"],
];

for (const [path, what] of pages) {
  test(`route: ${what} renders (GET ${path.replace(TEAM_VAULT, ":vault").replace(PROPOSAL, ":proposal")})`, async () => {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} answered ${r.status}`);
    const h = await r.text();
    assert.match(h, /<html/i);
    assert.match(h, /<nav/i, "page shell (nav) missing");
  });
}

test("route: unknown paths and malformed ids are 404", async () => {
  for (const path of ["/nope", "/v/not-a-uuid", `${V}/nope`, `${V}/proposals/not-a-uuid`, "/v/00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});
