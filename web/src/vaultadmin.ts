// Vault settings at /v/:id/config (docs/parity.md), as tabs: General (rename
// and default policy), Members (members.ts), Rules (rules.ts, /v/:id/rules),
// Usage, Watching (watching.ts, the person's own), Export and Danger zone
// (leave, delete); and erasing a file, reached from the file. (Not
// /settings: a viewer's Variables page must hold no "/set" link.) Every
// action here is an owner's, in person, except leaving and watching, which
// are any member's own: the database refuses anyone else
// (supabase/migrations/20260925120000_vault_admin.sql, and erase_file in the
// core), and these pages only choose what to offer.
// Each action goes through a confirmation step:
//  - rename and default policy: a page that states the change, then Confirm;
//  - export: a page that says what the archive holds, then a POST download;
//  - delete: type the vault's name (the database checks it too);
//  - erase: type the file's path.
//
//   GET  /v/:id/config          General; POST saves (after a confirm page)
//   GET  /v/:id/config/usage    the vault's tier, people and storage
//   GET  /v/:id/config/watching what you watch here (watching.ts); POST watches or stops
//   GET  /v/:id/config/export   what an export holds; POST downloads it
//   GET  /v/:id/config/danger   Leave and Delete
//   GET  /v/:id/config/delete   confirm; POST deletes

import type pg from "pg";
import { asPerson } from "./db.js";
import { archiveName, MANIFEST, startExport, writeExport } from "./export.js";
import { leaveRoutes, membersRoutes } from "./members.js";
import { callout, confirmPage, csrfField, html, pageHeader, plural, policyBadge, type CrumbPart, type Raw, type Tab } from "./html.js";
import { message, notFound, render, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { crumbs as fileCrumbs, deletePath, vaultShell } from "./files.js";
import { usagePanel, vaultUsages } from "./plans.js";
import { watchingRoutes } from "./watching.js";

const q = encodeURIComponent;
const settingsPath = (id: string, rest = "") => vaultPath(id, `/config${rest}`);
const filePath = (id: string, path: string) => vaultPath(id, `/file?path=${q(path)}`);

// ---------------------------------------------------------------------------
// The Settings tabs, shared with members.ts (and for rules.ts to adopt):
// every tab page has the title "Settings", the tabs flush under it, and a
// breadcrumb vault / Settings / tab. Export is an owner's only, so only
// owners see its tab; Danger zone holds Leave, which is everyone's.

export type SettingsTab = "general" | "members" | "rules" | "usage" | "watching" | "export" | "danger";
const TABS: [SettingsTab, string, (id: string) => string][] = [
  ["general", "General", (id) => settingsPath(id)],
  ["members", "Members", (id) => settingsPath(id, "/members")],
  ["rules", "Rules", (id) => vaultPath(id, "/rules")],
  ["usage", "Usage", (id) => settingsPath(id, "/usage")],
  // The person's own, for every member (watching.ts).
  ["watching", "Watching", (id) => settingsPath(id, "/watching")],
  ["export", "Export", (id) => settingsPath(id, "/export")],
  ["danger", "Danger zone", (id) => settingsPath(id, "/danger")],
];
export const settingsTabLabel = (t: SettingsTab) => TABS.find(([k]) => k === t)![1];

export function settingsTabs(id: string, role: string, current?: SettingsTab): Tab[] {
  return TABS.filter(([k]) => k !== "export" || role === "owner").map(([k, label, href]) => ({
    href: href(id),
    label,
    current: k === current,
  }));
}

// Breadcrumb parts for a page under Settings: vault / Settings / ...rest.
export function settingsCrumb(id: string, v: Vault, ...rest: CrumbPart[]): CrumbPart[] {
  return [{ label: v.name, href: vaultPath(id) }, { label: "Settings", href: settingsPath(id) }, ...rest];
}

export function settingsHeader(
  id: string,
  v: Vault,
  tab: SettingsTab,
  o: { description?: Raw | string; primary?: Raw | ""; meta?: Raw } = {},
): Raw {
  return pageHeader({
    crumb: tab === "general" ? [{ label: v.name, href: vaultPath(id) }, { label: "Settings" }] : settingsCrumb(id, v, { label: settingsTabLabel(tab) }),
    title: "Settings",
    description: o.description,
    meta: o.meta,
    primary: o.primary,
    tabs: settingsTabs(id, v.role, tab),
    tabsLabel: "Settings",
  });
}

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

const ownerCount = async (c: pg.PoolClient, id: string) =>
  (await c.query(`select count(*)::int as n from public.vault_members where vault_id = $1 and role = 'owner'`, [id])).rows[0].n as number;

// ---------------------------------------------------------------------------
// General

async function settings(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Settings", async (_c, v) => {
    const owner = v.role === "owner";
    return html`
      ${settingsHeader(id, v, "general", {
        description: owner ? `The vault’s name, and what its files are when no rule covers them.` : `${v.name}’s name and default policy.`,
      })}
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
              <p class="hint">What a file is when no rule covers it. Rules for folders and files are on <a href="${vaultPath(id, "/rules")}">Rules</a>. You’ll confirm the change on the next page.</p>
            </fieldset>
            <div class="actions"><button class="primary">Save</button></div>
          </form>`
        : html`<dl class="settings-facts">
            <div><dt>Name</dt><dd>${v.name}</dd></div>
            <div><dt>Default policy</dt><dd>${policyBadge(v.default_policy)} <span class="muted">unless a rule says otherwise</span></dd></div>
            <div><dt>Your role</dt><dd>${v.role === "editor" ? "Editor" : "Viewer"}</dd></div>
          </dl>
          <p class="hint">Only owners rename a vault or change its default.</p>`}`;
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
      ${pageHeader({ crumb: settingsCrumb(id, v, { label: "Confirm changes" }), title: "Confirm changes" })}
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
      "success",
    );
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: settingsPath(id) };
}

// ---------------------------------------------------------------------------
// Usage: the vault's tier, people and storage (plans.ts), for every member.

async function usagePage(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Usage", async (c, v) => {
    const u = (await vaultUsages(c, [id])).get(id);
    if (!u) return null;
    return html`${settingsHeader(id, v, "usage", { description: `What ${v.name} holds, against its tier’s limits.` })}
      ${usagePanel(u, v.name)}`;
  });
}

// ---------------------------------------------------------------------------
// Export

async function exportPage(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Export", async (c, v) => {
    if (v.role !== "owner") {
      return html`${settingsHeader(id, v, "export")}${callout("info", "Only owners export a vault.")}`;
    }
    const n = (await c.query(`select count(*)::int as n from public.files where vault_id = $1 and deleted_at is null`, [id])).rows[0].n as number;
    return html`
      ${settingsHeader(id, v, "export", {
        description: html`A <code>.tar.gz</code> of ${plural(n, "file")}, each at its path under <code>files/</code>, and a <code>${MANIFEST}</code> manifest.`,
        primary: html`<button class="primary" form="export">Download export</button>`,
      })}
      <form method="post" action="${settingsPath(id, "/export")}" id="export">${csrfField(ctx.csrf)}</form>
      <ul class="export-facts">
        <li>The manifest lists the vault’s name and default policy, its rules, and every file with its SHA-256, size and when it was last written.</li>
        <li><strong>Variable values are not exported.</strong> The manifest names each environment variable and the environments that have a value, nothing more.</li>
        <li>Deleted and erased files, earlier versions, proposals, comments and the activity log are not included.</li>
        <li>The export is recorded in the vault’s activity. A vault can be exported 10 times an hour.</li>
      </ul>`;
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
    ctx.setFlash(e.code === "54000" ? `${(e.message ?? "Too large").replace(/^./, (s) => s.toUpperCase())}.` : message(err), "danger");
    return { redirect: settingsPath(id, "/export") };
  }
}

// ---------------------------------------------------------------------------
// Danger zone: leaving (every member but the only owner) and deleting (an
// owner). Each is a link to its confirm page.

async function dangerPage(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Danger zone", async (c, v) => {
    const owner = v.role === "owner";
    const soleOwner = owner && (await ownerCount(c, id)) <= 1;
    return html`${settingsHeader(id, v, "danger", { description: "Actions that take access away at once, or can’t be undone." })}
      <div class="danger-rows">
        <div class="danger-row">
          <div><h2>Leave this vault</h2>
            ${soleOwner
              ? html`<p>You’re the only owner, so you can’t leave. Make someone else an owner on <a href="${settingsPath(id, "/members")}">Members</a> first, or delete the vault.</p>`
              : html`<p>You and your agents lose access to ${v.name} at once. To come back, an owner invites you again.</p>`}</div>
          ${soleOwner ? "" : html`<a class="button danger" href="${settingsPath(id, "/leave")}">Leave this vault</a>`}
        </div>
        ${owner
          ? html`<div class="danger-row">
              <div><h2>Delete this vault</h2>
                <p>Its files, history, proposals and variables are deleted at once, for every member. This can’t be undone.</p></div>
              <a class="button danger" href="${settingsPath(id, "/delete")}">Delete vault</a>
            </div>`
          : ""}
      </div>
      ${owner ? "" : html`<p class="hint">Only owners delete a vault.</p>`}`;
  });
}

// ---------------------------------------------------------------------------
// Delete

async function deletePage(ctx: Ctx, id: string, error?: string): Promise<Reply> {
  return page(
    ctx,
    id,
    "Delete vault",
    async (c, v) => {
      const where = settingsCrumb(id, v, { label: "Danger zone", href: settingsPath(id, "/danger") }, { label: "Delete" });
      if (v.role !== "owner") {
        return html`${pageHeader({ crumb: where, title: "Delete vault" })}${callout("info", "Only owners delete a vault.")}`;
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
      return confirmPage({
        title: `Delete ${v.name}`,
        crumb: where,
        lede: `This deletes the vault now, for all ${plural(n.members, "member")}: ${plural(n.files, "file")} with every earlier version, ${plural(n.proposals, "open proposal")}, the activity log, and ${plural(n.variables, "environment variable")} with their encrypted values. Tokens that reached only this vault stop working.`,
        consequences: [
          "Nothing is kept to restore from. Backups hold it until they age out, then it is gone everywhere.",
          html`Want a copy? <a href="${settingsPath(id, "/export")}">Export it first</a>. Variable values are never exported.`,
          ...(n.members > 1
            ? ["The other members are told once, on their Home page, within 30 days: the vault’s name, your email and the date. Nothing else is kept."]
            : []),
        ],
        action: settingsPath(id, "/delete"),
        csrf: ctx.csrf,
        typed: { value: v.name },
        button: `Delete ${v.name}`,
        cancel: settingsPath(id, "/danger"),
        error,
      });
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
    ctx.setFlash(`Deleted ${name}. Its files, history and variables are gone.`, "success");
    return { redirect: "/" };
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "22023") return deletePage(ctx, id, "That isn’t the vault’s name. Nothing was deleted.");
    ctx.setFlash(message(err));
    return { redirect: settingsPath(id, "/danger") };
  }
}

// ---------------------------------------------------------------------------
// Erase a file

// Reached from a file page's More menu, so it sits under the file: the
// crumb runs vault / folders / file / Erase, the tree marks the file, and
// Cancel goes back to it.
async function erasePage(ctx: Ctx, id: string, error?: string): Promise<Reply> {
  const path = (ctx.method === "GET" ? ctx.url.searchParams.get("path") : ctx.form.get("path")) ?? "";
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const f = (
      await c.query(
        `select count(fv.id)::int as versions, bool_or(f.deleted_at is null) as live
           from public.files f left join public.file_versions fv on fv.file_id = f.id and fv.erased_at is null
          where f.vault_id = $1 and f.path = $2
          group by f.id`,
        [id, path],
      )
    ).rows[0] as { versions: number; live: boolean } | undefined;
    if (!f) return null;
    const name = path.split("/").pop()!;
    const where = f.live ? fileCrumbs(id, v, path, false, "Erase") : [{ label: v.name, href: vaultPath(id) }, { label: `Erase ${path}` }];
    const body =
      v.role !== "owner"
        ? html`${pageHeader({ crumb: where, title: `Erase ${name}`, path: true })}${callout("info", "Only owners erase a file.")}`
        : confirmPage({
            title: `Erase ${name}`,
            crumb: where,
            lede: html`Erasing <code>${path}</code> blanks the text of ${
              f.versions === 1 ? "its only version" : `all ${plural(f.versions, "version")}`
            }, and of every proposal, review note and comment on it, then removes the file. Use it when text must be forgotten, for example on a request to erase personal data.`,
            consequences: [
              "The activity log keeps its entries, in order: who wrote, proposed or approved what, and when. None of them holds the text.",
              "It can’t be undone. Backups hold the text until they age out.",
              html`To remove a file but keep its history, ${
                f.live ? html`<a href="${deletePath(id, path)}">delete it</a>` : "delete it"
              } instead.`,
            ],
            action: vaultPath(id, "/erase"),
            csrf: ctx.csrf,
            fields: { path },
            typed: { value: path, name: "confirm_path" },
            button: `Erase ${name}`,
            cancel: f.live ? filePath(id, path) : vaultPath(id),
            error,
          });
    return vaultShell(c, ctx, v, f.live ? { path, section: "files" } : { section: "settings" }, body);
  });
  if (!out) return notFound(ctx);
  return { ...render(ctx, `Erase ${path}`, out, "vaults"), status: error ? 400 : undefined };
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
    ctx.setFlash(`Erased ${path}: ${plural(n, "version")} blanked.`, "success");
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
  if (rest === "/config/leave") return leaveRoutes(ctx, id);
  if (rest === "/config/usage") return get ? usagePage(ctx, id) : notFound(ctx);
  if (rest === "/config/watching") return watchingRoutes(ctx, id);
  if (rest === "/config/export") return get ? exportPage(ctx, id) : exportDownload(ctx, id);
  if (rest === "/config/danger") return get ? dangerPage(ctx, id) : notFound(ctx);
  if (rest === "/config/delete") return get ? deletePage(ctx, id) : deleteVault(ctx, id);
  if (rest === "/erase") return get ? erasePage(ctx, id) : eraseFile(ctx, id);
  return notFound(ctx);
}
