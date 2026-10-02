// Opening a thread: a title, a first message, optionally a file it is about,
// and optionally the members it is addressed to. Owners and editors open
// threads; the database decides (open_thread), so a form sent by a viewer is
// refused there and comes back with its reference.
//
// Addressing decides who is told about a thread, never who can read it, and
// the form says so. The member list is the web app's own view of the vault
// (names never reach agents); an agent addresses members by id, in its own tool.
//
//   GET  /v/:id/threads/new     the form; ?path=<file> fills in what it is about
//   POST /v/:id/threads         title, body, path, to (any number of member ids)

import { asPerson } from "./db.js";
import { Refusal } from "./failure.js";
import { callout, csrfField, html, pageHeader, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { canWrite, message, notFound, render, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { personRef } from "./personref.js";
import { threadPath, threadsPath } from "./threadrefs.js";

type Typed = { title: string; body: string; path: string; to: string[] };
const NONE: Typed = { title: "", body: "", path: "", to: [] };

async function form(ctx: Ctx, id: string, v: Vault, typed: Typed, error?: string): Promise<Reply> {
  const members = await asPerson(ctx.userId, async (c) =>
    (await c.query(`select user_id, role from public.list_members($1)`, [id])).rows.filter((m) => m.user_id !== ctx.userId) as { user_id: string; role: string }[],
  );
  const body: Raw = html`
    ${pageHeader({
      crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Threads", href: threadsPath(id) }, { label: "New thread" }],
      title: "New thread",
      description: "Start a conversation with the people in this vault and their agents. Everyone in the vault can read it.",
      secondary: html`<a class="button quiet" href="${threadsPath(id)}">Cancel</a>`,
      primary: html`<button class="primary" form="new-thread">Open thread</button>`,
    })}
    ${error ? callout("danger", error) : ""}
    <form method="post" action="${threadsPath(id)}" class="panel choice-form" id="new-thread">
      ${csrfField(ctx.csrf)}
      <label for="t-title">Title</label>
      <input id="t-title" type="text" name="title" value="${typed.title}" maxlength="200" required>
      <label for="t-body">First message</label>
      <textarea id="t-body" name="body" class="short" maxlength="4000" required>${typed.body}</textarea>
      <label for="t-path">About a file (optional)</label>
      <p class="hint" id="t-path-hint">A file in this vault, or the path of one that isn’t written yet. Leave it empty if the thread is about nothing in particular.</p>
      <input id="t-path" type="text" name="path" value="${typed.path}" placeholder="notes/plan.md" aria-describedby="t-path-hint">
      ${members.length
        ? html`<fieldset><legend>Address it to (optional)</legend>
            <p class="hint">Leave everyone unticked to address the whole vault. Addressing decides who is told about the thread, never who can read it: everyone in this vault can read every thread, and so can their agents.</p>
            ${members.map((m) => html`<label class="choice"><input type="checkbox" name="to" value="${m.user_id}"${typed.to.includes(m.user_id) ? html` checked` : ""}> ${personRef(m.user_id)} <span class="muted small">${m.role}</span></label>`)}
          </fieldset>`
        : ""}
      <p class="hint">An agent sees a new message on its next tool call, not instantly. Secrets belong in <a href="${vaultPath(id, "/variables")}">variables</a>, never in a thread.</p>
      <div class="actions"><button class="primary">Open thread</button><a class="button quiet" href="${threadsPath(id)}">Cancel</a></div>
    </form>`;
  const shell = await asPerson(ctx.userId, (c) => vaultShell(c, ctx, v, { section: "threads" }, body));
  const reply = render(ctx, "New thread", shell, "vaults");
  return error ? { ...reply, status: 400 } : reply;
}

export async function newThread(ctx: Ctx, id: string): Promise<Reply> {
  const v = await asPerson(ctx.userId, (c) => vault(c, ctx, id));
  if (!v) return notFound(ctx);
  if (!canWrite(v)) {
    ctx.setFlash("Only editors and owners open threads; viewers read them.", "warning");
    return { redirect: threadsPath(id) };
  }
  const path = ctx.url.searchParams.get("path") ?? "";
  return form(ctx, id, v, { ...NONE, path: path.length <= 1024 ? path : "" });
}

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (a vault's threads)", why }));

export async function openThread(ctx: Ctx, id: string): Promise<Reply> {
  const v = await asPerson(ctx.userId, (c) => vault(c, ctx, id));
  if (!v) return notFound(ctx);
  const typed: Typed = {
    title: ctx.form.get("title") ?? "",
    body: (ctx.form.get("body") ?? "").replaceAll("\r\n", "\n"),
    path: (ctx.form.get("path") ?? "").trim(),
    to: ctx.form.getAll("to"),
  };
  if (typed.to.some((u) => !UUID.test(u))) return form(ctx, id, v, { ...typed, to: [] }, refuse("An addressee wasn’t one of this vault’s members, so no thread was opened"));
  try {
    const tid = await asPerson(
      ctx.userId,
      async (c) =>
        (await c.query(`select public.open_thread($1, $2, $3, $4::uuid[], $5) as id`, [id, typed.title, typed.body, typed.to.length ? typed.to : null, typed.path || null])).rows[0].id as string,
    );
    ctx.setFlash("Thread opened.", "success");
    return { redirect: threadPath(id, tid) };
  } catch (err) {
    return form(ctx, id, v, typed, message(err));
  }
}
