// The MCP tools' composition root: wraps server.registerTool once (so every
// tool call gets its own error reference and log line, see
// tools-shared.ts's wrapRegisterTool), then calls each domain module's own
// register*Tools() to register its tools onto the same McpServer:
//
//   vaultfiles-tools.ts  vault + file tools (list_vaults, create_vault,
//                        list_files, read_file, search, write_file,
//                        delete_file)
//   claims-tools.ts      claim_path, renew_claim, release_claim,
//                        list_claims (break_claim needs a person present,
//                        so no tool here offers it)
//   workplan-tools.ts    register_work_plan, work_plan_status, claim_step,
//                        checkin_step, complete_step, release_step
//                        (cancel_step and skip_step need a person present,
//                        so no tool here offers them)
//   proposals-tools.ts   propose, list_proposals, revise_proposal,
//                        changes_since, read_proposal, comment_on_proposal
//   thread-tools.ts      open_thread, post_message (which also resolves
//                        and reopens), list_threads, read_thread
//                        (redact_message needs a person present, so no
//                        tool here offers it)
//   variables-tools.ts   list_variables
//   flags-tools.ts       flags, subscriptions and feedback to Reliquary's
//                        own operators
//   links-tools.ts       list_links, and the dynamic <link>.<tool> tools
//                        proxied to each vault's granted upstream servers
//
// Each tool's own behaviour, and the shared helpers those modules pull
// from (explain(), fileBlock(), freshNonce(), VAULT_REF, the input-size
// ceilings), live in tools-shared.ts.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type pg from "pg";
import { registerClaimsTools } from "./claims-tools.js";
import { asIdentity, type Identity } from "./db.js";
import { registerFlagsTools } from "./flags-tools.js";
import { registerLinksTools } from "./links-tools.js";
import { registerProposalsTools } from "./proposals-tools.js";
import { registerThreadTools } from "./thread-tools.js";
import { refuseInput, wrapRegisterTool } from "./tools-shared.js";
import { registerVariablesTools } from "./variables-tools.js";
import { registerVaultFileTools } from "./vaultfiles-tools.js";
import { registerWorkPlanTools } from "./workplan-tools.js";

// Whether a request's messages can reach a <link>.<tool>: tools/list shows
// them, and a tools/call of a name with a dot is one. Nothing else does, and
// finding them costs a query (links-tools.ts) that, on a tools/call, would
// take the transaction the Session opened for the call itself.
export function needsLinkTools(messages: unknown[]): boolean {
  return messages.some((m) => {
    const r = m as { method?: unknown; params?: { name?: unknown } } | null;
    return r?.method === "tools/list" || (r?.method === "tools/call" && typeof r.params?.name === "string" && r.params.name.includes("."));
  });
}

// `runAs` runs one tool call's queries in a transaction as the identity:
// the request's Session (one connection for the request, the token
// resolved inside the transaction), or by default a transaction of its own.
// `linkTools: false` leaves the <link>.<tool> ones out (needsLinkTools).
export async function registerTools(
  server: McpServer,
  id: Identity,
  runAs: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T> = (fn) => asIdentity(id, fn),
  linkTools = true,
): Promise<void> {
  // Each tool call is its own request for the error model (failure.ts): a
  // reference of its own, and what it is doing (the log: the tool's name).
  // Applied once, before any tool is registered, so every domain module's
  // server.registerTool call below (and the dynamic <link>.<tool> ones
  // links-tools.ts registers) goes through it.
  wrapRegisterTool(server);

  registerVaultFileTools(server, id, runAs);
  registerClaimsTools(server, id, runAs);
  registerWorkPlanTools(server, id, runAs);
  registerProposalsTools(server, id, runAs);
  registerThreadTools(server, id, runAs);
  registerVariablesTools(server, id, runAs);
  registerFlagsTools(server, id, runAs);
  await registerLinksTools(server, id, runAs, linkTools);

  trimToolList(server);
  explainInputRefusals(server);
}

// tools/list, through the SDK's own handler with one post-process step:
// dropping each tool's inputSchema.$schema line (50 bytes a client never
// needs). No longer cached process-wide (removed 2026-09-28, alongside
// <link>.<tool>): registerLinksTools above makes the list identity-
// dependent (different vaults, different grants -- mcp/test/contract.test.mjs
// now only compares the fixed tools, and a dedicated test proves a granted
// and an ungranted identity see different <link>.<tool> entries), so one
// answer cached for everyone would be wrong. tools/list isn't the hot path
// (tools/call is), and a tools/call of a fixed tool doesn't look the
// <link>.<tool> ones up at all (needsLinkTools), so this trades a minor
// optimization for correctness. If the SDK's internals change shape, this
// does nothing and the SDK's own list is served, $schema included.
type Handler = (req: unknown, extra: unknown) => Promise<unknown>;
const sdkHandler = (server: McpServer, method: string): Handler | undefined =>
  (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers?.get(method);

function trimToolList(server: McpServer): void {
  const original = sdkHandler(server, ListToolsRequestSchema.shape.method.value);
  if (typeof original !== "function") return;
  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const list = (await original(req, extra)) as { tools?: { inputSchema?: Record<string, unknown> }[] };
    for (const t of list.tools ?? []) delete t.inputSchema?.$schema;
    return list as { tools: [] };
  });
}

// tools/call, through the SDK's own handler with one post-process step: the
// SDK answers arguments that fail a tool's schema with a plain tool error,
// before any handler (and so before wrapRegisterTool) runs; this gives it a
// reference and a log line like every other failure. If the SDK's internals
// change shape, this does nothing and the SDK's own answer is served;
// mcp/test/errors.test.mjs fails then.
const SDK_INPUT_REFUSAL = /^(?:MCP error -?\d+: )?Input validation error: ([\s\S]*)$/;
function explainInputRefusals(server: McpServer): void {
  const original = sdkHandler(server, CallToolRequestSchema.shape.method.value);
  if (typeof original !== "function") return;
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const result = (await original(req, extra)) as { isError?: boolean; content?: { text?: unknown }[] };
    const text = result.content?.[0]?.text;
    const said = result.isError && typeof text === "string" ? SDK_INPUT_REFUSAL.exec(text) : null;
    return (said ? refuseInput(req.params.name, said[1]) : result) as never;
  });
}
