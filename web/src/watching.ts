// Watching a folder or file for flags (docs/public/concepts/flags.md,
// "Watching a path"): the Watch / Unwatch button on folder and file pages
// (files.ts), and the Watching tab of the vault's Settings, which lists
// everything the person watches in the vault. The database decides
// (supabase/migrations/20260928150000_flags.sql): any member, owner, editor
// or viewer, in person (create_subscription, delete_subscription), and only
// their own; RLS shows a person only their own. Not owner-gated, unlike a
// path's owners: watching is about the person's own flags, not about
// writing to the vault. Nothing here is logged in the vault's Activity.
//
//   GET  /v/:id/config/watching   what you watch in the vault, and a form to watch a path
//   POST /v/:id/config/watching   action watch (path) or unwatch (subscription), then back

import type pg from "pg";
import { asPerson } from "./db.js";
import { changesPath } from "./changes.js";
import { csrfField, emptyState, html, time, type Raw } from "./html.js";
import { flagsPath } from "./flagspage.js";
import { Refusal } from "./failure.js";
import { vaultShell } from "./files.js";
import { filePath, message, notFound, render, treePath, UUID, vault, vaultPath, type Ctx, type Reply } from "./pages.js";
import { settingsHeader } from "./vaultadmin.js";
import { watchCovers } from "./watchrule.js";

export const watchingPath = (id: string) => vaultPath(id, "/config/watching");

type Watch = { id: string; target: string; created_at: Date };

// What the person watches that covers `path`: a watch on it exactly, or on
// a folder above it (a folder covers everything under it). The closest first.
export type WatchState = { direct?: Watch; via?: Watch };
export async function watchState(c: pg.PoolClient, ctx: Ctx, id: string, path: string): Promise<WatchState> {
  const rows = (
    await c.query(
      `select id, target, created_at from public.subscriptions
        where vault_id = $1 and user_id = $2 and kind = 'path'
          and ${watchCovers("target", "$3")}
        order by (target = $3) desc, length(target) desc`,
      [id, ctx.userId, path],
    )
  ).rows as Watch[];
  return { direct: rows.find((w) => w.target === path), via: rows.find((w) => w.target !== path) };
}

// For a folder or file page's header: the state as a badge beside the title,
// and the button (a one-button form, no script). A path already covered by
// a watched folder says which one, and offers no second watch.
export function watchControl(ctx: Ctx, id: string, path: string, w: WatchState): { badge?: Raw; action: Raw | "" } {
  const back = html`<input type="hidden" name="back" value="${ctx.url.pathname + ctx.url.search}">`;
  if (w.direct) {
    return {
      badge: html`<span class="badge info" title="Changes here are flagged to you and your agents. Only you see this.">Watching</span>`,
      action: html`<form method="post" action="${watchingPath(id)}" class="watch-form">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="unwatch"><input type="hidden" name="subscription" value="${w.direct.id}">${back}<button aria-label="Unwatch ${path}">Unwatch</button></form>`,
    };
  }
  if (w.via) {
    return {
      badge: html`<span class="badge info" title="Your watch on ${w.via.target} covers this. Only you see it.">Watching via ${w.via.target}</span>`,
      action: "",
    };
  }
  return {
    action: html`<form method="post" action="${watchingPath(id)}" class="watch-form">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="watch"><input type="hidden" name="path" value="${path}">${back}<button title="Flag changes here to you and your agents">Watch</button></form>`,
  };
}

// ---------------------------------------------------------------------------
// The Watching tab

// The Watch form's values when saving was refused: the path as typed and
// the refusal with its reference, shown in the form.
type WatchForm = { path: string; error: string };

async function watchingPage(ctx: Ctx, id: string, form?: WatchForm): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const list = (
      await c.query(
        `select id, target, created_at from public.subscriptions
          where vault_id = $1 and user_id = $2 and kind = 'path' order by target`,
        [id, ctx.userId],
      )
    ).rows as Watch[];
    const here = watchingPath(id);
    // A watch may name what isn't written yet ("It needn't exist yet"), and
    // a folder or file page that isn't there is a 404, so only what exists
    // is linked.
    const there = new Set<string>(
      (
        await c.query(
          `select w.target from unnest($2::text[]) as w(target)
            where exists (select 1 from public.files f where f.vault_id = $1 and f.deleted_at is null and ${watchCovers("w.target", "f.path")})`,
          [id, list.map((w) => w.target)],
        )
      ).rows.map((r) => r.target as string),
    );
    const table = list.length
      ? html`<div class="section-head"><h2>What you watch</h2><p class="section-meta">${list.length === 1 ? "1 path" : `${list.length} paths`}</p></div>
        <div class="table-wrap"><table class="table-stack member-list watch-list">
          <thead><tr><th scope="col">Path</th><th scope="col">Since</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${list.map((w) => {
            const folder = w.target.endsWith("/");
            const name = html`<code>${w.target}</code>`;
            return html`<tr><td>${there.has(w.target) ? html`<a href="${folder ? treePath(id, w.target) : filePath(id, w.target)}">${name}</a>` : name}<span class="token-client">${folder ? "Folder, and everything in it" : "File"}${there.has(w.target) ? "" : ", nothing there yet"}</span></td>
              <td class="small" data-label="Since">${time(w.created_at)}</td>
              <td class="num row-actions"><form method="post" action="${here}">${csrfField(ctx.csrf)}<input type="hidden" name="action" value="unwatch"><input type="hidden" name="subscription" value="${w.id}"><input type="hidden" name="back" value="${here}"><button class="quiet" aria-label="Unwatch ${w.target}">Unwatch</button></form></td></tr>`;
          })}</tbody></table></div>`
      : emptyState({
          title: "You don’t watch anything here",
          body: "Watch a folder or file from its page, or type one below. Changes there are flagged to you and your agents from then on.",
        });
    const addForm = html`<form method="post" action="${here}" class="panel watch-add" id="watch-path" aria-labelledby="watch-path-title">
        <h2 id="watch-path-title" class="form-title">Watch a folder or file</h2>
        ${csrfField(ctx.csrf)}<input type="hidden" name="action" value="watch"><input type="hidden" name="back" value="${here}">
        ${form ? html`<p class="callout danger" role="alert" id="watch-error">${form.error}</p>` : ""}
        <label for="wp">Path</label>
        <div class="inline-field"><input id="wp" type="text" name="path" placeholder="clients/" required maxlength="1024" autocomplete="off" spellcheck="false" value="${form?.path ?? ""}"${
          form ? html` aria-invalid="true" aria-describedby="watch-error wp-hint"` : html` aria-describedby="wp-hint"`
        }><button>Watch</button></div>
        <p class="hint" id="wp-hint">A folder ends in <code>/</code>, like <code>clients/</code>, and covers everything in it; a file is its full path, like <code>notes/plan.md</code>. It needn’t exist yet. Changes are flagged from when you start watching, not before.</p>
      </form>`;
    // A refused form goes first, so its reason is on the first screen.
    const body = html`
      ${settingsHeader(id, v, "watching", {
        description: html`Folders and files you watch in ${v.name}. Changes there are flagged to you and to your agents. You see them in <a href="${flagsPath(id)}">Flags</a> (under Diagnostics) and in <a href="${changesPath(id, "watching")}">Changes, Watching</a>; your agents ask for theirs with <code>list_flags</code>. Only you see this list.`,
        primary: form || !list.length ? "" : html`<a class="button primary" href="#watch-path">Watch a path</a>`,
      })}
      ${form ? addForm : ""}
      ${table}
      ${form ? "" : addForm}
      <p class="hint">Any member can watch, a viewer too. Your agents can list what you watch, but only you start or stop it, here. <a href="/docs/concepts/flags#watching-a-path">Watching a path</a></p>`;
    return vaultShell(c, ctx, v, { section: "settings" }, body);
  });
  if (!out) return notFound(ctx);
  return { ...render(ctx, "Watching", out, "vaults"), ...(form ? { status: 400 } : {}) };
}

// ---------------------------------------------------------------------------
// POST: watch or stop watching, then back to the page the button was on.

// Back to a page of this vault only; otherwise the Watching tab.
function backTo(id: string, back: string | null): string {
  const b = back ?? "";
  const mine = b === vaultPath(id) || b.startsWith(`${vaultPath(id)}/`) || b.startsWith(`${vaultPath(id)}?`);
  return mine && !b.includes("//") && !/[\u0000-\u001f\u007f]/.test(b) ? b : watchingPath(id);
}

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (Watching)", why }));

async function watchAction(ctx: Ctx, id: string): Promise<Reply> {
  const action = ctx.form.get("action") ?? "";
  const back = backTo(id, ctx.form.get("back"));
  if (action === "watch") {
    const path = (ctx.form.get("path") ?? "").trim();
    try {
      const r = await asPerson(ctx.userId, async (c) => {
        if (!(await vault(c, ctx, id))) return null;
        const had = (
          await c.query(`select 1 from public.subscriptions where vault_id = $1 and user_id = $2 and kind = 'path' and target = $3`, [id, ctx.userId, path])
        ).rowCount;
        // Watching a path already watched returns that watch: never a second one.
        await c.query(`select public.create_subscription($1, 'path', $2)`, [id, path]);
        return { had: !!had };
      });
      if (!r) return notFound(ctx);
      if (r.had) ctx.setFlash(`You already watch ${path}.`, "info");
      else ctx.setFlash(`Watching ${path}. From now on, changes there are flagged to you and your agents.`, "success");
    } catch (err) {
      // Refused by the database: a path it won't take, or the most paths
      // one person can watch in a vault. Its own words, with a reference.
      // The Watching tab's own form keeps the path typed there; the button
      // on a file or folder page has nothing typed, so it flashes.
      const text = message(err);
      if (back === watchingPath(id)) return watchingPage(ctx, id, { path, error: text });
      ctx.setFlash(text);
    }
    return { redirect: back };
  }
  if (action === "unwatch") {
    const sub = ctx.form.get("subscription") ?? "";
    if (!UUID.test(sub)) {
      ctx.setFlash(refuse("The form didn’t say which watch to stop, so nothing changed: reload the page and try again"));
      return { redirect: back };
    }
    try {
      const r = await asPerson(ctx.userId, async (c) => {
        if (!(await vault(c, ctx, id))) return null;
        const w = (await c.query(`select target from public.subscriptions where id = $1 and vault_id = $2 and user_id = $3`, [sub, id, ctx.userId])).rows[0] as
          | { target: string }
          | undefined;
        if (!w) return { target: null };
        await c.query(`select public.delete_subscription($1)`, [sub]);
        return { target: w.target };
      });
      if (!r) return notFound(ctx);
      if (r.target === null) ctx.setFlash("You weren’t watching that, so nothing changed. It may have been stopped already, in another tab.", "warning");
      else ctx.setFlash(`Stopped watching ${r.target}.`, "success");
    } catch (err) {
      ctx.setFlash(message(err));
    }
    return { redirect: back };
  }
  ctx.setFlash(refuse("The form didn’t say whether to watch or stop watching, so nothing changed"));
  return { redirect: back };
}

export async function watchingRoutes(ctx: Ctx, id: string): Promise<Reply> {
  return ctx.method === "GET" ? watchingPage(ctx, id) : watchAction(ctx, id);
}
