// Token load: what each tool costs an agent, in bytes of text it has to read
// (tokens are roughly bytes / 4). Every call runs against the seeded Load
// vault (seed.sql: 40 notes, 5 canon files, 6 proposals), so the numbers are
// comparable from run to run; docs/research/token-load.md records them.
//
// Each measurement has a budget. A change that makes an agent read more
// fails here, and must raise the budget on purpose, with a Changes-behaviour
// trailer, the way a changed tool description fails the contract test.
//
// The table is printed as `token-load:` lines in the test output.

import assert from "node:assert/strict";
import { test } from "node:test";
import { connect as mcpConnect } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const env = process.env;

const connect = (token) => mcpConnect(URL_, token, "token-load");

const bytes = (s) => Buffer.byteLength(s, "utf8");
function record(name, text) {
  const b = bytes(text);
  console.log(`token-load: ${name.padEnd(40)} ${String(b).padStart(7)} bytes  ~${Math.ceil(b / 4)} tokens`);
  return b;
}

async function measure(c, name, args, label = name) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.map((x) => x.text).join("\n");
  assert.equal(Boolean(r.isError), false, `${label}: ${text}`);
  return { label, text };
}

// Budgets in bytes, set just above what the compact formats produce, so a
// regression shows and small wording changes don't.
const BUDGET = {
  // Raised for claim_path, renew_claim, release_claim and list_claims
  // (CL-2.4, F441): four more tool schemas in every tools/list response.
  // Raised again for register_work_plan and work_plan_status (CL-3.4, F530),
  // and for claim_step, checkin_step, complete_step and release_step (F531).
  "tools/list": 18700,
  list_vaults: 200,
  list_files: 1800,
  "list_files prefix=canon/": 400,
  "read_file notes/n01.md": 2000,
  "read_file max_bytes=400": 800,
  "read_file lines 1-5": 700,
  "search workshop": 4000,
  "search retainer": 1300,
  list_proposals: 1200,
  "list_proposals changes_requested": 700,
  read_proposal: 2100,
  changes_since: 5000,
  "changes_since limit=20": 1400,
  list_variables: 300,
  write_file: 150,
  propose: 150,
  comment_on_proposal: 200,
  delete_file: 150,
};

test("token load: every tool's response on the Load vault stays within its budget", async () => {
  const c = await connect(env.FAY_RW);
  const { tools } = await c.listTools();
  const out = [{ label: "tools/list", text: JSON.stringify(tools) }];
  const v = "Load";
  out.push(await measure(c, "list_vaults", {}));
  out.push(await measure(c, "list_files", { vault: v }));
  out.push(await measure(c, "list_files", { vault: v, prefix: "canon/" }, "list_files prefix=canon/"));
  out.push(await measure(c, "read_file", { vault: v, path: "notes/n01.md" }, "read_file notes/n01.md"));
  out.push(await measure(c, "read_file", { vault: v, path: "notes/n01.md", max_bytes: 400 }, "read_file max_bytes=400"));
  out.push(await measure(c, "read_file", { vault: v, path: "notes/n01.md", from_line: 1, to_line: 5 }, "read_file lines 1-5"));
  out.push(await measure(c, "search", { vault: v, query: "workshop" }, "search workshop"));
  out.push(await measure(c, "search", { vault: v, query: "retainer" }, "search retainer"));
  out.push(await measure(c, "list_proposals", { vault: v }));
  out.push(await measure(c, "list_proposals", { vault: v, status: "changes_requested" }, "list_proposals changes_requested"));
  out.push(await measure(c, "read_proposal", { proposal_id: env.LOAD_PROPOSAL }));
  out.push(await measure(c, "changes_since", { vault: v }));
  out.push(await measure(c, "changes_since", { vault: v, limit: 20 }, "changes_since limit=20"));
  out.push(await measure(c, "list_variables", { vault: v }));
  out.push(await measure(c, "write_file", { vault: v, path: "scratch/load.md", content: "x" }));
  out.push(await measure(c, "propose", { vault: v, path: "canon/load.md", content: "x", reason: "measure" }));
  out.push(await measure(c, "comment_on_proposal", { proposal_id: env.LOAD_PROPOSAL, comment: "measured" }));
  out.push(await measure(c, "delete_file", { vault: v, path: "scratch/load.md" }));
  await c.close();

  let total = 0;
  const over = [];
  for (const { label, text } of out) {
    const b = record(label, text);
    total += b;
    if (BUDGET[label] !== undefined && b > BUDGET[label]) over.push(`${label}: ${b} > ${BUDGET[label]}`);
  }
  console.log(`token-load: ${"total".padEnd(40)} ${String(total).padStart(7)} bytes  ~${Math.ceil(total / 4)} tokens`);
  if (env.TOKEN_LOAD_MEASURE_ONLY !== "1") assert.deepEqual(over, [], "responses over budget");
});
