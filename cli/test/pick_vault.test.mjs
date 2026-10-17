// Which vault a command uses: --vault by name or id, else the only one.
// A --vault that names none of yours lists the ones you can reach, so you
// don't need a second command to see their names.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pickVault } from "../dist/api.js";

const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Client Work", role: "owner", environments: ["development"] };
const B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Side project", role: "editor", environments: [] };
const listed = (e) => e.message.includes(`  Client Work  ${A.id}`) && e.message.includes(`  Side project  ${B.id}`);

test("pick vault: with one vault and no --vault, that one is used", () => {
  assert.equal(pickVault([A], undefined), A);
});

test("pick vault: an unknown name lists the vaults you can reach, exit 1", () => {
  assert.throws(() => pickVault([A, B], "Clinet Work"), (e) => e.exitCode === 1 && /No vault named "Clinet Work"/.test(e.message) && listed(e));
});

test("pick vault: an unknown id lists the vaults you can reach, exit 1", () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.throws(() => pickVault([A, B], id), (e) => e.exitCode === 1 && e.message.includes(`No vault ${id}`) && listed(e));
});

test("pick vault: a name matches whatever its case", () => {
  assert.equal(pickVault([A, B], "client work"), A);
});

test("pick vault: a name two vaults share is a usage error listing both ids, exit 2", () => {
  const twin = { ...B, name: "Client Work" };
  assert.throws(() => pickVault([A, twin], "Client Work"), (e) => e.exitCode === 2 && e.message.includes(A.id) && e.message.includes(B.id));
});
