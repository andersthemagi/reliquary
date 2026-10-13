// Vault settings at /v/:id/config (docs/parity.md), a grouped sub-nav:
// Vault (General, with the Danger zone of leave and delete at its foot;
// Members, members.ts; Rules, rules.ts at /v/:id/rules; Usage), You
// (Watching, watching.ts) and Advanced (Diagnostics, diagnostics.ts at
// /v/:id/diagnostics; Export); and erasing a file, reached from the file. (Not
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
//   GET  /v/:id/config/danger   the old Danger zone tab: to General's Danger zone
//   GET  /v/:id/config/delete   confirm; POST deletes

import type pg from "pg";
import { asPerson } from "./db.js";
import { archiveName, MANIFEST, startExport, writeExport } from "./export.js";
import { leaveRoutes, membersRoutes } from "./members.js";
import { callout, confirmPage, csrfField, html, pageHeader, plural, policyBadge, raw, type CrumbPart, type Raw } from "./html.js";
import { Refusal } from "./failure.js";
import { message, notFound, render, treePath, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { crumbs as fileCrumbs, deletePath, vaultShell } from "./files.js";
import { usagePanel, vaultUsages } from "./plans.js";
import { watchingRoutes } from "./watching.js";

const q = encodeURIComponent;
const settingsPath = (id: string, rest = "") => vaultPath(id, `/config${rest}`);
const filePath = (id: string, path: string) => vaultPath(id, `/file?path=${q(path)}`);

// ---------------------------------------------------------------------------
// The Settings frame, shared with members.ts, rules.ts, watching.ts and
// diagnostics.ts: every page in it is titled "Settings", with a breadcrumb
// vault / Settings / section and a sub-nav beside the content. The groups
// keep the vault's own settings, the person's own, and the rarely needed
// apart. Export is an owner's only, so only owners see it.

export type SettingsTab = "general" | "members" | "rules" | "usage" | "watching" | "diagnostics" | "export";
type NavItem = [SettingsTab, string, (id: string) => string];
const NAV: [string, NavItem[]][] = [
  [
    "Vault",
    [
      ["general", "General", (id) => settingsPath(id)],
      ["members", "Members", (id) => settingsPath(id, "/members")],
      ["rules", "Rules", (id) => vaultPath(id, "/rules")],
      ["usage", "Usage", (id) => settingsPath(id, "/usage")],
    ],
  ],
  ["You", [["watching", "Watching", (id) => settingsPath(id, "/watching")]]],
  [
    "Advanced",
    [
      ["diagnostics", "Diagnostics", (id) => vaultPath(id, "/diagnostics")],
      ["export", "Export", (id) => settingsPath(id, "/export")],
    ],
  ],
];
export const settingsTabLabel = (t: SettingsTab) => NAV.flatMap(([, items]) => items).find(([k]) => k === t)![1];
// Leave and Delete sit at the foot of General; their confirm pages come back here.
export const dangerPath = (id: string) => `${settingsPath(id)}#danger`;

function settingsNav(id: string, role: string, current: SettingsTab): Raw {
  return html`<nav class="settings-nav" aria-label="Settings">${NAV.map(
    ([group, items]) => html`<div class="settings-nav-group"><p class="settings-nav-label">${group}</p><ul>${items
      .filter(([k]) => k !== "export" || role === "owner")
      .map(([k, label, href]) => html`<li><a href="${href(id)}"${k === current ? raw(' aria-current="page"') : ""}>${label}</a></li>`)}</ul></div>`,
  )}</nav>`;
}

// Breadcrumb parts for a page under Settings: vault / Settings / ...rest.
export function settingsCrumb(id: string, v: Vault, ...rest: CrumbPart[]): CrumbPart[] {
  return [{ label: v.name, href: vaultPath(id) }, { label: "Settings", href: settingsPath(id) }, ...rest];
}

// A Settings page: the header across the top, so the flash and the primary
// action keep their usual place, then the sub-nav beside the section's body.
export function settingsPage(
  id: string,
  v: Vault,
  tab: SettingsTab,
  o: { description?: Raw | string; primary?: Raw | ""; meta?: Raw },
  body: Raw,
): Raw {
  return html`${pageHeader({
    crumb: tab === "general" ? [{ label: v.name, href: vaultPath(id) }, { label: "Settings" }] : settingsCrumb(id, v, { label: settingsTabLabel(tab) }),
    title: "Settings",
    description: o.description,
    meta: o.meta,
    primary: o.primary,
  })}<div class="settings-layout">${settingsNav(id, v.role, tab)}<div class="settings-main">${body}</div></div>`;
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

// The form's values as posted when saving was refused, with the refusal.
type GeneralForm = { name: string; policy: string; error: string };

async function settings(ctx: Ctx, id: string, d?: GeneralForm): Promise<Reply> {
  return page(ctx, id, "Settings", async (c, v) => {
    const owner = v.role === "owner";
    const policy = d?.policy ?? v.default_policy;
    const soleOwner = owner && (await ownerCount(c, id)) <= 1;
    return settingsPage(id, v, "general", {
        description: owner ? `The vault’s name, and what its files are when no rule covers them.` : `${v.name}’s name and default policy.`,
      }, html`
      ${owner
        ? html`<form method="post" action="${settingsPath(id)}" class="panel choice-form" id="general">
            ${csrfField(ctx.csrf)}
            ${d ? html`<p class="callout danger" role="alert" id="name-error">${d.error}</p>` : ""}
            <label for="vn">Name</label>
            <input id="vn" type="text" name="name" value="${d?.name ?? v.name}" required maxlength="100"${d ? html` aria-invalid="true" aria-describedby="name-error"` : ""}>
            <fieldset>
              <legend>Default policy</legend>
              <label class="choice"><input type="radio" name="default_policy" value="open"${policy === "open" ? html` checked` : ""}>
                <span><strong>Open:</strong> members and their agents write files directly. Every change is logged.</span></label>
              <label class="choice"><input type="radio" name="default_policy" value="canon"${policy === "canon" ? html` checked` : ""}>
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
          <p class="hint">Only owners rename a vault or change its default.</p>`}
      ${emailsSection(ctx, id, v, owner)}
      ${dangerZone(id, v, owner, soleOwner)}`);
  }, d ? 400 : undefined);
}

// Whether members' emails are required (public.set_require_emails: an
// owner, in person). Nobody's email is shown without their consent: a
// member who hides theirs is asked on the vault's pages (files.ts).
function emailsSection(ctx: Ctx, id: string, v: Vault, owner: boolean): Raw {
  const on = v.require_emails === true;
  return html`<section aria-labelledby="emails-title">
      <h2 id="emails-title">Members’ emails</h2>
      ${owner
        ? html`<form method="post" action="${settingsPath(id, "/emails")}" class="panel choice-form" id="emails">
            ${csrfField(ctx.csrf)}
            <fieldset>
              <legend>Who sees members’ emails</legend>
              <label class="choice"><input type="radio" name="require_emails" value="0"${on ? "" : html` checked`}>
                <span><strong>Each member decides:</strong> members who hide their email are shown by display name and a short tag.</span></label>
              <label class="choice"><input type="radio" name="require_emails" value="1"${on ? html` checked` : ""}>
                <span><strong>Required:</strong> members’ emails are visible to the other members. Anyone who hides theirs is asked to agree or leave, and stays hidden until they agree.</span></label>
            </fieldset>
            <div class="actions"><button class="primary">Save</button></div>
          </form>`
        : html`<p>${on ? "This vault requires members’ emails to be visible to the other members." : "Each member decides whether the other members see their email."} Only owners change this.</p>`}
    </section>`;
}

// POST /config/emails: the database refuses anyone but an owner.
async function saveEmails(ctx: Ctx, id: string): Promise<Reply> {
  const on = ctx.form.get("require_emails") === "1";
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.set_require_emails($1, $2)`, [id, on]));
    ctx.setFlash(on ? "Members’ emails are required now. Members who hide theirs are asked to agree or leave." : "Each member decides now whether others see their email.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: settingsPath(id) };
}

// POST /config/email-consent: a member agrees to show their email in this
// vault (public.consent_to_show_email: in person, a member only).
async function consentEmail(ctx: Ctx, id: string): Promise<Reply> {
  try {
    await asPerson(ctx.userId, (c) => c.query(`select public.consent_to_show_email($1)`, [id]));
    ctx.setFlash("Your email is visible to the people in this vault now.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id) };
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
    // Refused here, not after Confirm: a rename the database would refuse
    // must not be offered for confirmation, with the typed name gone.
    const length = [...name].length;
    if (length < 1 || length > 100) {
      const error = message(new Refusal({ status: 400, where: "web app (Settings form)", why: "A vault name is 1 to 100 characters. Nothing was saved" }));
      return settings(ctx, id, { name, policy, error });
    }
    return page(ctx, id, "Confirm changes", async (_c, v) => html`
      ${pageHeader({ crumb: settingsCrumb(id, v, { label: "Confirm changes" }), title: "Confirm changes" })}
      <ul class="changes">
        ${renamed ? html`<li>Rename <strong>${current.name}</strong> to <strong>${name}</strong>. Members see the new name at once; the activity log records both.</li>` : ""}
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
    return settingsPage(id, v, "usage", { description: `What ${v.name} holds, against its tier’s limits.` }, usagePanel(u, v.name));
  });
}

// ---------------------------------------------------------------------------
// Export

async function exportPage(ctx: Ctx, id: string): Promise<Reply> {
  return page(ctx, id, "Export", async (c, v) => {
    if (v.role !== "owner") {
      return settingsPage(id, v, "export", {}, callout("info", "Only owners export a vault."));
    }
    const n = (await c.query(`select count(*)::int as n from public.files where vault_id = $1 and deleted_at is null`, [id])).rows[0].n as number;
    return settingsPage(id, v, "export", {
        description: html`A <code>.tar.gz</code> of ${plural(n, "file")}, each at its path under <code>files/</code>, the vault’s threads under <code>threads/</code>, and a <code>${MANIFEST}</code> manifest.`,
        primary: html`<button class="primary" form="export">Download export</button>`,
      }, html`
      <form method="post" action="${settingsPath(id, "/export")}" id="export">${csrfField(ctx.csrf)}</form>
      <ul class="export-facts">
        <li>The manifest lists the vault’s name and default policy, its rules, and every file with its SHA-256, size and when it was last written.</li>
        <li><strong>Variable values are not exported.</strong> The manifest names each environment variable and the environments that have a value, nothing more.</li>
        <li>Each thread is a Markdown file with every message in order, its author, agent and time. A redacted message keeps its place, without its text.</li>
        <li>Deleted and erased files, earlier versions, proposals and their comments, tasks and the activity log are not included.</li>
        <li>The export is recorded in the vault’s activity. A vault can be exported 10 times an hour.</li>
      </ul>`);
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
// Danger zone, at the foot of General: leaving (every member but the only
// owner) and deleting (an owner). Each is a link to its confirm page.

function dangerZone(id: string, v: Vault, owner: boolean, soleOwner: boolean): Raw {
  return html`<section class="settings-danger" id="danger" aria-labelledby="danger-title">
      <h2 id="danger-title">Danger zone</h2>
      <p class="section-lede">Actions that take access away at once, or can’t be undone.</p>
      <div class="danger-rows">
        <div class="danger-row">
          <div><h3>Leave this vault</h3>
            ${soleOwner
              ? html`<p>You’re the only owner, so you can’t leave. Make someone else an owner on <a href="${settingsPath(id, "/members")}">Members</a> first, or delete the vault.</p>`
              : html`<p>You and your agents lose access to ${v.name} at once. To come back, an owner invites you again.</p>`}</div>
          ${soleOwner ? "" : html`<a class="button danger" href="${settingsPath(id, "/leave")}">Leave this vault</a>`}
        </div>
        ${owner
          ? html`<div class="danger-row">
              <div><h3>Delete this vault</h3>
                <p>Its files, history, proposals and variables are deleted at once, for every member. This can’t be undone.</p></div>
              <a class="button danger" href="${settingsPath(id, "/delete")}">Delete vault</a>
            </div>`
          : ""}
      </div>
      ${owner ? "" : html`<p class="hint">Only owners delete a vault.</p>`}
    </section>`;
}

// ---------------------------------------------------------------------------
// Delete

async function deletePage(ctx: Ctx, id: string, error?: string): Promise<Reply> {
  return page(
    ctx,
    id,
    "Delete vault",
    async (c, v) => {
      const where = settingsCrumb(id, v, { label: "Danger zone", href: dangerPath(id) }, { label: "Delete" });
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
            ? ["The other members are told once, on their Home page, within 30 days: the vault’s name, your email (unless you hide it) and the date. Nothing else is kept."]
            : []),
        ],
        action: settingsPath(id, "/delete"),
        csrf: ctx.csrf,
        typed: { value: v.name },
        button: `Delete ${v.name}`,
        cancel: dangerPath(id),
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
    return { redirect: dangerPath(id) };
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
    return { redirect: treePath(id, "") };
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
  if (rest === "/config/emails") return get ? notFound(ctx) : saveEmails(ctx, id);
  if (rest === "/config/email-consent") return get ? notFound(ctx) : consentEmail(ctx, id);
  if (rest === "/config/usage") return get ? usagePage(ctx, id) : notFound(ctx);
  if (rest === "/config/watching") return watchingRoutes(ctx, id);
  if (rest === "/config/export") return get ? exportPage(ctx, id) : exportDownload(ctx, id);
  if (rest === "/config/danger") return get ? { redirect: dangerPath(id) } : notFound(ctx);
  if (rest === "/config/delete") return get ? deletePage(ctx, id) : deleteVault(ctx, id);
  if (rest === "/erase") return get ? erasePage(ctx, id) : eraseFile(ctx, id);
  return notFound(ctx);
}
