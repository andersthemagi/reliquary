// Vault settings at /v/:id/config (docs/parity.md): rename and default
// policy, export, delete, and erasing a file. (Not /settings: a viewer's
// Variables page must hold no "/set" link.) Every action here is an
// owner's, in person: the database refuses anyone else
// (supabase/migrations/20260925120000_vault_admin.sql, and erase_file in the
// core), and these pages only choose what to offer.
// Each action goes through a confirmation step:
//  - rename and default policy: a page that states the change, then Confirm;
//  - export: a page that says what the archive holds, then a POST download;
//  - delete: type the vault's name (the database checks it too);
//  - erase: type the file's path.

import type pg from "pg";
import { asPerson } from "./db.js";
import { archiveName, MANIFEST, startExport, writeExport } from "./export.js";
import { membersRoutes } from "./members.js";
import { csrfField, html, pageHeader, type Raw } from "./html.js";
import { message, notFound, render, UUID, vault, vaultPath, vaultShell, type Ctx, type Reply, type Vault } from "./pages.js";

const q = encodeURIComponent;
const settingsPath = (id: string, rest = "") => vaultPath(id, `/config${rest}`);
const filePath = (id: string, path: string) => vaultPath(id, `/file?path=${q(path)}`);
const policyBadge = (p: string) =>
  html`<span class="badge policy ${p}">${p === "canon" ? "Canon" : "Open"}</span>`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function page(ctx: Ctx, id: string, title: string, build: (c: pg.PoolClient, v: Vault & { default_policy: string }) => Promise<Raw | null>, status?: number): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy as string;
    const body = await build(c, { ...v, default_policy: def });
    if (!body) return null;
    return vaultShell(c, ctx, v, { section: "settings" }, body);
  });
  if (!out) return notFound(ctx);
  return { ...render(ctx, title, out, "vaults"), status };
}

const crumb = (id: string, v: Vault, here?: string) =>
  html`<p class="crumb"><a href="${vaultPath(id)}">${v.name}</a><span aria-hidden="true"> / </span>${
    here ? html`<a href="${settingsPath(id)}">Settings</a>` : "Settings"
  }</p>`;

// ---------------------------------------------------------------------------
// Settings

async function settings(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Settings", async (_c, v) => {
    const owner = v.role === "owner";
    return html`
      ${pageHeader({ crumb: crumb(id, v), title: "Settings" })}
      <h2>General</h2>
      ${owner
        ? html`<form method="post" action="${settingsPath(id)}" class="panel choice-form" id="general">
            ${csrfField(ctx.csrf)}
            <label for="vn">Name</label>
            <input id="vn" type="text" name="name" value="${v.name}" required maxlength="100">
            <fieldset>
              <legend>Default policy</legend>
              <label class="choice"><input type="radio" name="default_policy" value="open"${v.default_policy === "open" ? html` checked` : ""}>
                <span><strong>Open:</strong> members and their agents write files directly. Every change is logged.</span></label>
              <label class="choice"><input type="radio" name="default_policy" value="canon"${v.default_policy === "canon" ? html` checked` : ""}>
                <span><strong>Canon:</strong> every change is a proposal that people approve before it applies.</span></label>
              <p class="hint">What a file is when no rule covers it. You’ll confirm the change on the next page.</p>
            </fieldset>
            <div class="actions"><button class="primary">Save</button></div>
          </form>`
        : html`<p>Everything is ${policyBadge(v.default_policy)} unless a rule says otherwise. <span class="muted">Only owners rename a vault or change its default.</span></p>`}
      <h2>Members</h2>
      <p>${owner ? "Invite people, change their roles, and see their agent connections." : "Who is in this vault, and their roles."} <a href="${settingsPath(id, "/members")}">Members</a></p>
      <h2>Rules</h2>
      <p>Which folders and files are canon, and how many approvals their changes need. <a href="${vaultPath(id, "/rules")}">Rules</a></p>
      <h2>Export</h2>
      ${owner
        ? html`<p>Download every file’s current text as a <code>.tar.gz</code>, with a manifest of rules and variable names. <a href="${settingsPath(id, "/export")}">Export this vault</a></p>`
        : html`<p class="muted">Owners can export this vault.</p>`}
      ${owner
        ? html`<h2>Danger zone</h2>
          <div class="danger-zone">
            <p><strong>Delete this vault.</strong> Its files, history, proposals and variables are deleted at once, for every member. This can’t be undone.</p>
            <a class="button danger" href="${settingsPath(id, "/delete")}">Delete vault</a>
          </div>`
        : ""}`;
  });
}

// POST /config: rename and default policy. Owners get a confirmation page
// first; anyone else goes straight to the database, which refuses.
async function saveSettings(ctx: Ctx, id: string): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  const policy = ctx.form.get("default_policy") === "canon" ? "canon" : "open";
  const current = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    return { ...v, def: (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy as string };
  });
  if (!current) return notFound(ctx);
  const renamed = name !== current.name;
  const repoliced = policy !== current.def;
  if (!renamed && !repoliced) {
    ctx.setFlash("Nothing changed.");
    return { redirect: settingsPath(id) };
  }
  if (current.role === "owner" && ctx.form.get("confirm") !== "1") {
    return page(ctx, id, "Confirm changes", async (_c, v) => html`
      ${pageHeader({ crumb: crumb(id, v, "confirm"), title: "Confirm changes" })}
      <ul class="changes">
        ${renamed ? html`<li>Rename <strong>${current.name}</strong> to <strong>${name || "(blank)"}</strong>. Members see the new name at once; the activity log records both.</li>` : ""}
        ${repoliced
          ? html`<li>Make the default ${policyBadge(policy)}. ${
              policy === "open"
                ? "Files no rule covers become open: members and their agents write them directly, with no approval."
                : "Files no rule covers become canon: every change to them, including an agent’s, waits for approval."
            } Files under a rule keep it.</li>`
          : ""}
      </ul>
      <form method="post" action="${settingsPath(id)}" class="actions">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="name" value="${name}"><input type="hidden" name="default_policy" value="${policy}">
        <input type="hidden" name="confirm" value="1">
        <a class="button quiet" href="${settingsPath(id)}">Cancel</a><button class="primary">Confirm</button>
      </form>`);
  }
  try {
    await asPerson(ctx.userId, async (c) => {
      if (renamed) await c.query(`select public.rename_vault($1, $2)`, [id, name]);
      if (repoliced) await c.query(`select public.set_default_policy($1, $2)`, [id, policy]);
    });
    ctx.setFlash(
      [renamed ? `Renamed to ${name}.` : "", repoliced ? `Files with no rule are ${policy} now.` : ""].filter(Boolean).join(" "),
    );
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: settingsPath(id) };
}

// ---------------------------------------------------------------------------
// Export

async function exportPage(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Export", async (c, v) => {
    const owner = v.role === "owner";
    const n = (await c.query(`select count(*)::int as n from public.files where vault_id = $1 and deleted_at is null`, [id])).rows[0].n as number;
    return html`
      ${pageHeader({
        crumb: crumb(id, v, "export"),
        title: "Export",
        actions: owner ? html`<button class="primary" form="export">Download export</button>` : "",
      })}
      <p class="lede">A <code>.tar.gz</code> of ${plural(n, "file")}, each at its path under <code>files/</code>, and a <code>${MANIFEST}</code> manifest.</p>
      <ul>
        <li>The manifest lists the vault’s name and default policy, its rules, and every file with its SHA-256, size and when it was last written.</li>
        <li><strong>Variable values are not exported.</strong> The manifest names each environment variable and the environments that have a value, nothing more.</li>
        <li>Deleted and erased files, earlier versions, proposals, comments and the activity log are not included.</li>
        <li>The export is recorded in the vault’s activity.</li>
      </ul>
      ${owner
        ? html`<form method="post" action="${settingsPath(id, "/export")}" id="export" class="actions">
            ${csrfField(ctx.csrf)}<button class="primary">Download export</button>
            <a class="button quiet" href="${settingsPath(id)}">Cancel</a></form>`
        : html`<p class="callout info">Only owners export a vault.</p>`}`;
  });
}

async function exportDownload(ctx: Ctx, id: string): Promise<Reply> {
  try {
    const header = await startExport(ctx.userId, id);
    return {
      download: {
        filename: archiveName(header),
        type: "application/gzip",
        write: (out) => writeExport(ctx.userId, header, out),
      },
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    ctx.setFlash(e.code === "54000" ? `${(e.message ?? "Too large").replace(/^./, (s) => s.toUpperCase())}.` : message(err));
    return { redirect: settingsPath(id, "/export") };
  }
}

// ---------------------------------------------------------------------------
// Delete

async function deletePage(ctx: Ctx, id: string, error?: string): Promise<Reply> {
  return page(
    ctx,
    id,
    "Delete vault",
    async (c, v) => {
      if (v.role !== "owner") {
        return html`${pageHeader({ crumb: crumb(id, v, "delete"), title: "Delete vault" })}
          <p class="callout info">Only owners delete a vault.</p>`;
      }
      const n = (
        await c.query(
          `select (select count(*) from public.files where vault_id = $1 and deleted_at is null)::int as files,
                  (select count(*) from public.proposals where vault_id = $1 and status in ('open', 'changes_requested'))::int as proposals,
                  (select count(*) from public.variables where vault_id = $1)::int as variables,
                  (select count(*) from public.vault_members where vault_id = $1)::int as members`,
          [id],
        )
      ).rows[0];
      return html`
        ${pageHeader({ crumb: crumb(id, v, "delete"), title: `Delete ${v.name}` })}
        ${error ? html`<p class="callout danger" role="alert">${error}</p>` : ""}
        <p class="lede">This deletes the vault now, for all ${plural(n.members, "member")}: ${plural(n.files, "file")} with every earlier version, ${plural(n.proposals, "open proposal")}, the activity log, and ${plural(n.variables, "environment variable")} with their encrypted values. Tokens that reached only this vault stop working.</p>
        <ul>
          <li>Nothing is kept to restore from. Backups hold it until they age out, then it is gone everywhere.</li>
          <li>Want a copy? <a href="${settingsPath(id, "/export")}">Export it first</a>. Variable values are never exported.</li>
        </ul>
        <form method="post" action="${settingsPath(id, "/delete")}" class="panel">
          ${csrfField(ctx.csrf)}
          <label for="cn">Type <strong>${v.name}</strong> to confirm</label>
          <input id="cn" type="text" name="confirm_name" required autocomplete="off" spellcheck="false">
          <div class="actions"><button class="danger">Delete this vault</button>
            <a class="button quiet" href="${settingsPath(id)}">Cancel</a></div>
        </form>`;
    },
    error ? 400 : undefined,
  );
}

async function deleteVault(ctx: Ctx, id: string): Promise<Reply> {
  const typed = ctx.form.get("confirm_name") ?? "";
  try {
    const name = await asPerson(ctx.userId, async (c) => {
      const v = await vault(c, ctx, id);
      if (!v) return null;
      await c.query(`select public.delete_vault($1, $2)`, [id, typed]);
      return v.name;
    });
    if (name === null) return notFound(ctx);
    ctx.setFlash(`Deleted ${name}. Its files, history and variables are gone.`);
    return { redirect: "/" };
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "22023") return deletePage(ctx, id, "That isn’t the vault’s name. Nothing was deleted.");
    ctx.setFlash(message(err));
    return { redirect: settingsPath(id) };
  }
}

// ---------------------------------------------------------------------------
// Erase a file

async function erasePage(ctx: Ctx, id: string, error?: string): Promise<Reply> {
  const path = (ctx.method === "GET" ? ctx.url.searchParams.get("path") : ctx.form.get("path")) ?? "";
  return page(
    ctx,
    id,
    `Erase ${path}`,
    async (c, v) => {
      const f = (
        await c.query(
          `select count(fv.id)::int as versions, bool_or(f.deleted_at is null) as live
             from public.files f left join public.file_versions fv on fv.file_id = f.id and fv.erased_at is null
            where f.vault_id = $1 and f.path = $2
            group by f.id`,
          [id, path],
        )
      ).rows[0];
      if (!f) return null;
      const head = pageHeader({ crumb: crumb(id, v, "erase"), title: `Erase ${path.split("/").pop()}`, path: true });
      if (v.role !== "owner") return html`${head}<p class="callout info">Only owners erase a file.</p>`;
      return html`${head}
        ${error ? html`<p class="callout danger" role="alert">${error}</p>` : ""}
        <p class="lede">Erasing <code>${path}</code> blanks the text of all ${plural(f.versions, "version")}, and of every proposal, review note and comment on it, then removes the file. Use it when text must be forgotten, for example on a request to erase personal data.</p>
        <ul>
          <li>The activity log keeps its entries, in order: who wrote, proposed or approved what, and when. None of them holds the text.</li>
          <li>It can’t be undone. Backups hold the text until they age out.</li>
          <li>To remove a file but keep its history, ${f.live ? html`<a href="${vaultPath(id, `/edit?path=${q(path)}`)}">delete it</a>` : "delete it"} instead.</li>
        </ul>
        <form method="post" action="${vaultPath(id, "/erase")}" class="panel">
          ${csrfField(ctx.csrf)}<input type="hidden" name="path" value="${path}">
          <label for="cp">Type <strong>${path}</strong> to confirm</label>
          <input id="cp" type="text" name="confirm_path" required autocomplete="off" spellcheck="false">
          <div class="actions"><button class="danger">Erase every version</button>
            <a class="button quiet" href="${f.live ? filePath(id, path) : vaultPath(id)}">Cancel</a></div>
        </form>`;
    },
    error ? 400 : undefined,
  );
}

async function eraseFile(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.form.get("path") ?? "";
  if ((ctx.form.get("confirm_path") ?? "").trim() !== path) {
    return erasePage(ctx, id, "That isn’t the file’s path. Nothing was erased.");
  }
  try {
    const n = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      return (await c.query(`select public.erase_file($1, $2) as n`, [id, path])).rows[0].n as number;
    });
    if (n === null) return notFound(ctx);
    ctx.setFlash(`Erased ${path}: ${plural(n, "version")} blanked.`);
    return { redirect: vaultPath(id) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: filePath(id, path) };
  }
}

// ---------------------------------------------------------------------------

export async function adminRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  if (!UUID.test(id)) return notFound(ctx);
  const get = ctx.method === "GET";
  if (rest === "/config") return get ? settings(ctx, id) : saveSettings(ctx, id);
  if (rest === "/config/members" || rest.startsWith("/config/members/")) return membersRoutes(ctx, id, rest);
  if (rest === "/config/export") return get ? exportPage(ctx, id) : exportDownload(ctx, id);
  if (rest === "/config/delete") return get ? deletePage(ctx, id) : deleteVault(ctx, id);
  if (rest === "/erase") return get ? erasePage(ctx, id) : eraseFile(ctx, id);
  return notFound(ctx);
}
