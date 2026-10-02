// Where each address under /v/:id/threads goes. The pages themselves are in
// threadspage.ts (the list), threadview.ts (one thread) and threadnew.ts
// (opening one), threadredact.ts (redacting a message); this only reads the address.

import { notFound, type Ctx, type Reply } from "./pages.js";
import { openThread, newThread } from "./threadnew.js";
import { threadList } from "./threadspage.js";
import { redactAction, redactConfirm } from "./threadredact.js";
import { threadPost, threadState, threadView } from "./threadview.js";

export async function threadsRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  const get = ctx.method === "GET";
  if (rest === "/threads") return get ? threadList(ctx, id) : openThread(ctx, id);
  if (rest === "/threads/new") return get ? newThread(ctx, id) : notFound(ctx);
  const m = /^\/threads\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
  if (!m) return notFound(ctx);
  const [, tid, action = ""] = m;
  if (get && action === "") return ctx.url.searchParams.has("redact") ? redactConfirm(ctx, id, tid) : threadView(ctx, id, tid);
  if (!get && action === "redact") return redactAction(ctx, id, tid);
  if (!get && action === "post") return threadPost(ctx, id, tid);
  if (!get && (action === "resolve" || action === "reopen")) return threadState(ctx, id, tid, action);
  return notFound(ctx);
}
