// Files and folders: the vault shell (sidebar, search box and folder tree,
// and the section tabs on phones), folder and file pages, the editor, New
// file, deleting a file behind a confirm page, and the file form's actions.
// Each handler runs its queries as the signed-in person through asPerson();
// the database decides what they may see and do.

import type pg from "pg";
import { asPerson } from "./db.js";
import { activityBody } from "./activity.js";
import {
  callout,
  confirmPage,
  csrfField,
  emptyState,
  html,
  menu,
  pageHeader,
  plural,
  policyBadge,
  raw,
  tabs,
  textareaText,
  time,
  type CrumbPart,
  type MenuItem,
  type Raw,
} from "./html.js";
import { claimBanner } from "./claimbanner.js";
import { siteHref } from "./hosts.js";
import { renderMarkdown } from "./markdown.js";
import { errorPage, typed as echoable } from "./errorpage.js";
import { loadShell } from "./inbox.js";
import { failure, Refusal } from "./failure.js";
import { watchControl, watchState } from "./watching.js";
import {
  filePath,
  message,
  notFound,
  proposalPath,
  q,
  render,
  treePath,
  vault,
  vaultPath,
  who,
  writablePath,
  type Ctx,
  type Reply,
  type Vault,
} from "./pages.js";

// Vault shell: sidebar with search, links and the folder tree.

type TreeNode = { dirs: Map<string, TreeNode>; files: { name: string; path: string; policy: string }[] };
export type Section = "files" | "proposals" | "threads" | "tasks" | "changes" | "diagnostics" | "rules" | "search" | "variables" | "links" | "settings";

export async function vaultShell(c: pg.PoolClient, ctx: Ctx, v: Vault, current: { path?: string; section?: Section }, body: Raw): Promise<Raw> {
  // A GET has the top bar's summary already. A POST that answers with a page
  // (a refused save is the form again) doesn't, and without it the bar loses
  // its vault switcher and inbox count; one that redirects never gets here,
  // so it still pays nothing for it.
  ctx.shell ??= await loadShell(c);
  // One round trip: the live files, every folder above them, each one's
  // rule in one set-based call (one membership check, not rule_for() per
  // row), and the open proposals' count.
  const shell = (
    await c.query(
      `with p as (select path from public.files where vault_id = $1 and deleted_at is null),
            d as (select distinct array_to_string(s[1:i], '/') || '/' as path
                    from (select string_to_array(path, '/') as s from p) x, generate_series(1, cardinality(s) - 1) i),
            r as (select * from private.rules_for($1, array(select path from p union all select path from d)))
       select (select coalesce(json_agg(json_build_array(p.path, coalesce(r.policy, 'open')) order by p.path), '[]')
                 from p left join r on r.path = p.path) as files,
              (select coalesce(json_object_agg(d.path, coalesce(r.policy, 'open')), '{}')
                 from d left join r on r.path = d.path) as dirs,
              (select count(*)::int from public.proposals where vault_id = $1 and status = 'open') as open`,
      [v.id],
    )
  ).rows[0] as { files: [string, string][]; dirs: Record<string, string>; open: number };
  const files = shell.files.map(([path, policy]) => ({ path, policy }));
  const dirPolicy = new Map<string, string>(Object.entries(shell.dirs));
  const open = shell.open;

  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path, policy: f.policy });
  }
  const here = current.path ?? "";
  const renderNode = (node: TreeNode, prefix: string): Raw =>
    html`<ul>${[...node.dirs.entries()].map(([name, child]) => {
      const dir = `${prefix}${name}/`;
      const policy = dirPolicy.get(dir) ?? "open";
      return html`<li><details${here.startsWith(dir) ? raw(" open") : ""}><summary><span class="mark ${policy}" title="${policy}"></span><a href="${treePath(v.id, dir)}"${here === dir ? raw(' aria-current="page"') : ""}>${name}</a></summary>${renderNode(child, dir)}</details></li>`;
    })}${node.files.map(
      (f) => html`<li class="leaf"><a href="${filePath(v.id, f.path)}"${here === f.path ? raw(' aria-current="page"') : ""}>${f.name}</a></li>`,
    )}</ul>`;

  // The vault's sections: the sidebar's links on wide screens, a row of tabs
  // on phones (always visible, with the open proposals' count), so no
  // section hides behind the folder tree.
  const sections: { section: Section; href: string; label: string; count?: number }[] = [
    { section: "files", href: vaultPath(v.id), label: "Files" },
    { section: "proposals", href: vaultPath(v.id, "/proposals"), label: "Proposals", count: open || undefined },
    { section: "threads", href: vaultPath(v.id, "/threads"), label: "Threads" },
    { section: "tasks", href: vaultPath(v.id, "/tasks"), label: "Tasks" },
    { section: "changes", href: vaultPath(v.id, "/changes"), label: "Changes" },
    { section: "variables", href: vaultPath(v.id, "/variables"), label: "Variables" },
    { section: "links", href: vaultPath(v.id, "/links"), label: "Links" },
    { section: "settings", href: vaultPath(v.id, "/config"), label: "Settings" },
  ];
  // Settings holds Rules and Diagnostics, so their pages mark Settings as current.
  const isCurrent = (s: Section) => current.section === s || (s === "settings" && (current.section === "rules" || current.section === "diagnostics"));
  const link = (s: (typeof sections)[number]) =>
    html`<a href="${s.href}"${isCurrent(s.section) ? raw(' aria-current="page"') : ""}>${s.label}${s.count ? html`<span class="count">${s.count}</span>` : ""}</a>`;
  const tree = files.length ? renderNode(root, "") : html`<p class="muted small tree-empty">No files yet.</p>`;
  return html`<div class="vault">
    <aside class="side">
      <a class="side-title" href="${vaultPath(v.id)}">${v.name}</a>
      <form class="side-search" method="get" action="${vaultPath(v.id, "/search")}" role="search">
        <input type="search" name="q" placeholder="Search this vault" aria-label="Search this vault" value="${current.section === "search" ? ctx.url.searchParams.get("q") ?? "" : ""}">
      </form>
      <nav class="side-links" aria-label="Vault">${sections.map(link)}</nav>
      <nav class="tree" aria-label="Files">${tree}</nav>
    </aside>
    <div class="vault-tabs">${tabs(
      sections.map((s) => ({ href: s.href, label: s.label, count: s.count, current: isCurrent(s.section) })),
      "Vault (phone)",
    )}</div>
    <details class="tree-mobile"><summary>Browse files</summary>
      <nav class="tree" aria-label="Files (phone)">${tree}</nav></details>
    <div class="content">${body}</div>
  </div>`;
}

export type RuleInfo = {
  rule?: { path: string; policy: string; quorum: number; set_by: string | null; set_at: Date | null };
  def: string;
};

export async function ruleFor(c: pg.PoolClient, id: string, path: string): Promise<RuleInfo> {
  const rule = (
    await c.query(
      `select pp.path, pp.policy, pp.quorum,
              (select l.actor from public.log l where l.vault_id = $1 and l.event = 'policy.set' and l.path = pp.path
                order by l.seq desc limit 1) as set_by,
              (select l.at from public.log l where l.vault_id = $1 and l.event = 'policy.set' and l.path = pp.path
                order by l.seq desc limit 1) as set_at
         from public.path_policies pp
        where pp.vault_id = $1
          and (pp.path = $2 or (right(pp.path, 1) = '/' and starts_with($2, pp.path)))
        order by (pp.path = $2) desc, length(pp.path) desc
        limit 1`,
      [id, path],
    )
  ).rows[0];
  const def = (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy;
  return { rule, def };
}

export function ruleLine(ctx: Ctx, id: string, r: RuleInfo): Raw {
  if (!r.rule) return html`<p class="rule">${policyBadge(r.def)} <span>The vault default. <a href="${vaultPath(id, "/rules")}">Rules</a></span></p>`;
  const needs = r.rule.policy === "canon" ? ` Changes need ${r.rule.quorum} approval${r.rule.quorum > 1 ? "s" : ""}.` : "";
  return html`<p class="rule">${policyBadge(r.rule.policy)} <span>From the rule on <a href="${vaultPath(id, "/rules")}"><code>${r.rule.path}</code></a>${
    r.rule.set_at ? html`, set by ${who(ctx, r.rule.set_by, null)} ${time(r.rule.set_at)}` : ""
  }.${needs}</span></p>`;
}

// The vault root's rule line: what a file with no rule is, how many rules
// there are, and where the terms are explained.
function rootRuleLine(id: string, def: string, rules: number): Raw {
  return html`<p class="rule root-rule"><span>Files without a rule are</span> ${policyBadge(def)} <span>${
    rules ? `${rules} rule${rules === 1 ? "" : "s"} set` : "No rules set"
  } · <a href="${vaultPath(id, "/rules")}">Rules</a> · <a href="${siteHref("/docs/concepts/canon-and-rules")}">What’s canon?</a></span></p>`;
}

// Breadcrumb parts from the vault down: vault / folder / … / the file or
// folder, then `here` (Edit, Delete, Erase, New file) when the page is one
// step further. The last part is the current page (crumb() in html.ts).
export function crumbs(id: string, v: Vault, path: string, isDir: boolean, here?: string): CrumbPart[] {
  const parts = path.split("/").filter(Boolean);
  const out: CrumbPart[] = [{ label: v.name, href: vaultPath(id) }];
  parts.forEach((name, i) => {
    const file = !isDir && i === parts.length - 1;
    out.push({ label: name, href: file ? filePath(id, path) : treePath(id, parts.slice(0, i + 1).join("/") + "/") });
  });
  if (here) out.push({ label: here });
  return out;
}

export const deletePath = (id: string, path: string) => `${filePath(id, path)}&confirm=delete`;
const erasePath = (id: string, path: string) => vaultPath(id, `/erase?path=${q(path)}`);

// ---------------------------------------------------------------------------
// Folders and files

// A first-run step, not a status: a writer of a young vault who has no
// connection of any kind yet. The age bound is the dismiss, so someone who
// never connects an agent isn't pointed at Connect on every visit, forever.
const NUDGE_DAYS = 14;
const CONNECT_NUDGE = callout(
  "info",
  html`<p>Your agents read and propose to your vaults once they’re connected. It takes about a minute.</p>
    <p class="callout-actions"><a class="button primary" href="/connect">Connect an agent</a></p>`,
  { title: "Next: connect an agent" },
);

export async function folder(ctx: Ctx, id: string, rawDir: string): Promise<Reply> {
  const dir = rawDir ? rawDir.replace(/^\/+/, "").replace(/\/*$/, "/") : "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const children = (
      await c.query(
        // Every file under the folder, but only the README's text: the rest
        // is listing, and a folder of large files shouldn't be read whole.
        `with here as (
           select f.path, f.updated_at,
                  case when lower(f.path) = lower($2 || 'readme.md') then fv.body end as body
             from public.files f left join public.file_versions fv on fv.id = f.current_version_id
            where f.vault_id = $1 and f.deleted_at is null and starts_with(f.path, $2))
         select here.path, r.policy, here.updated_at, here.body
           from here join private.rules_for($1, array(select path from here)) r using (path)
          order by here.path`,
        [id, dir],
      )
    ).rows;
    if (dir && children.length === 0) return null;
    const rule = dir ? await ruleFor(c, id, dir) : null;
    const subdirs = new Map<string, Date>();
    const here: typeof children = [];
    for (const f of children) {
      const rest = f.path.slice(dir.length);
      if (rest.includes("/")) {
        const name = rest.split("/")[0];
        const prev = subdirs.get(name);
        if (!prev || prev < f.updated_at) subdirs.set(name, f.updated_at);
      } else here.push(f);
    }
    // Each subfolder's policy, as the tree shows it (the same rules_for()).
    const dirPolicy = new Map<string, string>(
      subdirs.size
        ? (
            await c.query(`select path, policy from private.rules_for($1, $2::text[])`, [id, [...subdirs.keys()].map((n) => `${dir}${n}/`)])
          ).rows.map((r) => [r.path as string, r.policy as string])
        : [],
    );
    // The root states the vault's default and its rules; an empty vault
    // says whether a proposal waits to add the first file.
    const info = dir
      ? null
      : ((
          await c.query(
            `select v.default_policy,
                    (select count(*)::int from public.path_policies pp where pp.vault_id = v.id) as rules,
                    (select count(*)::int from public.proposals p where p.vault_id = v.id and p.status = 'open') as open,
                    exists(select 1 from public.access_tokens) as connected,
                    v.created_at > now() - interval '${NUDGE_DAYS} days' as young
               from public.vaults v where v.id = $1`,
            [id],
          )
        ).rows[0] as { default_policy: string; rules: number; open: number; connected: boolean; young: boolean });
    const readme = here.find((f) => /^readme\.md$/i.test(f.path.slice(dir.length)));
    const writer = await writablePath(c, v, dir);
    const nudge = info && writer && info.young && !info.connected ? CONNECT_NUDGE : "";
    // Any member watches a folder (watching.ts); the vault's root isn't a
    // path that can be watched.
    const watch = dir ? watchControl(ctx, id, dir, await watchState(c, ctx, id, dir)) : undefined;
    const empty = () => {
      if (info?.open) {
        return emptyState({
          title: "No files yet",
          body: `${info.open === 1 ? "1 proposal waits" : `${info.open} proposals wait`} to add the first file${info.open === 1 ? "" : "s"}.`,
          action: html`<a class="button" href="${vaultPath(id, "/proposals")}">Review ${info.open === 1 ? "it" : "them"}</a>`,
        });
      }
      return writer
        ? emptyState({
            title: "No files yet",
            body: "Create the first file, or connect an agent and ask it to write one.",
            action: html`<a class="button" href="${vaultPath(id, "/new")}">New file</a>`,
          })
        : emptyState({ title: "No files yet", body: "Nothing has been shared here yet. Files appear here once a member writes one." });
    };
    // The way to connect an agent that doesn't expire. The first-run step
    // below is for a writer of a young vault with nothing connected; an older
    // vault, a vault you were invited to, a viewer, or someone connecting a
    // second agent had no way in from here. While that step shows, its own
    // button is right under the header, so this one would be a second.
    const connect = !dir && !nudge ? html` <a class="button" href="/connect">Connect an agent</a>` : "";
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true) : undefined,
        title: dir ? dir.slice(0, -1).split("/").pop()! : v.name,
        path: !!dir,
        badge: watch?.badge,
        actions: watch?.action ?? "",
        meta: rule ? ruleLine(ctx, id, rule) : info ? rootRuleLine(id, info.default_policy, info.rules) : undefined,
        // On phones the sidebar's search box is hidden: the header offers it.
        secondary: !dir ? html`<a class="button vault-search-link" href="${vaultPath(id, "/search")}">Search</a>${connect}` : "",
        primary: writer ? html`<a class="button primary" href="${vaultPath(id, `/new${dir ? `?dir=${q(dir)}` : ""}`)}">New file${dir ? " here" : ""}</a>` : "",
      })}
      ${nudge}
      ${children.length === 0
        ? empty()
        : html`<div class="table-wrap"><table class="folder-list">
          <tr><th>Name</th><th>Policy</th><th class="num hide-sm">Updated</th></tr>
          ${[...subdirs.entries()].map(
            ([name, at]) => html`<tr><td><a class="dir" href="${treePath(id, `${dir}${name}/`)}">${name}/</a></td><td>${policyBadge(dirPolicy.get(`${dir}${name}/`) ?? "open")}</td>
              <td class="num small muted hide-sm">${time(at)}</td></tr>`,
          )}
          ${here.map(
            (f) => html`<tr><td><a href="${filePath(id, f.path)}">${f.path.slice(dir.length)}</a></td><td>${policyBadge(f.policy)}</td>
              <td class="num small muted hide-sm">${time(f.updated_at)}</td></tr>`,
          )}</table></div>`}
      ${readme?.body
        ? html`<section class="readme" aria-label="${readme.path.slice(dir.length)}"><p class="readme-head"><a href="${filePath(id, readme.path)}">${readme.path.slice(dir.length)}</a></p><div class="prose entry">${raw(renderMarkdown(readme.body))}</div></section>`
        : ""}`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, dir || data.v.name, data.shell, "vaults");
}

export async function fileView(ctx: Ctx, id: string): Promise<Reply> {
  if (ctx.url.searchParams.get("confirm") === "delete") return deletePage(ctx, id);
  const path = ctx.url.searchParams.get("path") ?? "";
  const t = ctx.url.searchParams.get("tab");
  const tab = t === "source" || t === "history" ? t : "preview";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const f = (
      await c.query(
        `select f.id, f.path, (private.rule_for(f.vault_id, f.path)).policy,
                fv.body, fv.author, fv.agent, fv.created_at, fv.erased_at
           from public.files f left join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null`,
        [id, path],
      )
    ).rows[0];
    if (!f) return null;
    const rule = await ruleFor(c, id, path);
    const pending = (
      await c.query(`select id from public.proposals where vault_id = $1 and path = $2 and status in ('open', 'changes_requested')`, [id, path])
    ).rows;
    const history =
      tab === "history"
        ? await activityBody(c, { me: ctx.userId, url: ctx.url, base: vaultPath(id, "/file"), keep: { path, tab }, scope: { vaultId: id, file: path } })
        : "";
    const canon = f.policy === "canon";
    const writable = (await writablePath(c, v, path)) && !f.erased_at;
    const watch = watchControl(ctx, id, path, await watchState(c, ctx, id, path));
    const claim = await claimBanner(c, ctx, v, path, "view", filePath(id, path, tab === "preview" ? undefined : tab));
    const tab_ = (name: string, label: string) => ({ href: filePath(id, path, name === "preview" ? undefined : name), label, current: tab === name });
    const threads = (await c.query(`select count(*)::int as n from public.threads where vault_id = $1 and anchor_path = $2`, [id, path])).rows[0].n as number;
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false),
        title: path.split("/").pop()!,
        path: true,
        badge: watch.badge,
        actions: watch.action,
        meta: html`${ruleLine(ctx, id, rule)}
          <p class="meta file-meta">Last written by ${who(ctx, f.author, f.agent)} · ${time(f.created_at)}${
            threads ? html` · <a href="${vaultPath(id, `/threads?path=${q(path)}`)}">${plural(threads, "thread")} about this file</a>` : ""
          }</p>`,
        secondary: moreMenu(id, path, { canon, writable, owner: v.role === "owner" }),
        primary: writable
          ? html`<a class="button${canon ? "" : " primary"}" href="${vaultPath(id, `/edit?path=${q(path)}`)}">${canon ? "Propose a change" : "Edit"}</a>`
          : "",
        tabs: [tab_("preview", "Preview"), tab_("source", "Source"), tab_("history", "History")],
        tabsLabel: "File view",
      })}
      ${claim}
      ${pending.length
        ? callout(
            canon ? "warning" : "info",
            pending.length === 1
              ? html`<p>A proposed change to this file is waiting for review. <a href="${proposalPath(id, pending[0].id)}">Review it</a></p>`
              : html`<p>${pending.length} proposed changes to this file are waiting for review. <a href="${vaultPath(id, "/proposals")}">Review them</a></p>`,
          )
        : ""}
      ${f.erased_at
        ? html`<div class="empty">This file’s content was erased.</div>`
        : tab === "preview"
          ? html`<div class="prose entry">${raw(renderMarkdown(f.body ?? ""))}</div>`
          : tab === "source"
            ? html`<div class="file">${f.body}</div>`
            : history}`;
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, path, data.shell, "vaults");
}

// The file page's "More" menu: the rare and destructive actions, each through
// its own confirm page. Writers delete (canon: propose deleting); owners also
// erase. Nothing for a viewer.
function moreMenu(id: string, path: string, o: { canon: boolean; writable: boolean; owner: boolean }): Raw | "" {
  const items: MenuItem[] = [];
  if (o.writable) {
    items.push(
      o.canon
        ? { href: deletePath(id, path), label: "Propose deleting…", description: "A proposal: the file stays until it’s approved" }
        : { href: deletePath(id, path), label: "Delete file…", description: "Removes the file; its history stays", danger: true },
    );
  }
  if (o.owner) items.push({ href: erasePath(id, path), label: "Erase file…", description: "Blanks every version, then removes the file; for personal data", danger: true });
  return items.length ? menu({ label: "More", items, className: "file-more" }) : "";
}

// A file form the database refused, shown again on its own page (answered
// 400) with the reason and what was typed. A redirect would lose the text
// and, for a path that doesn't exist yet, land on Not found.
type Refused = { error: string; path: string; content: string; reason: string; expectedVersion: string | null };

// Delete a file, or propose deleting a canon one, behind a confirm page
// reached from the More menu (GET /v/:id/file?path=…&confirm=delete). The
// post is the file form's delete or propose-delete; the database decides.
async function deletePage(ctx: Ctx, id: string, refused?: Refused): Promise<Reply> {
  const path = refused?.path ?? ctx.url.searchParams.get("path") ?? "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !(await writablePath(c, v, path))) return null;
    const f = (
      await c.query(
        `select (private.rule_for(f.vault_id, f.path)).policy, fv.id as version,
                (select count(*)::int from public.file_versions x where x.file_id = f.id) as versions
           from public.files f join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null and fv.erased_at is null`,
        [id, path],
      )
    ).rows[0] as { policy: string; version: string; versions: number } | undefined;
    if (!f) return null;
    const name = path.split("/").pop()!;
    const canon = f.policy === "canon";
    const body = canon
      ? html`${pageHeader({ crumb: crumbs(id, v, path, false, "Propose deleting"), title: `Propose deleting ${name}`, path: true })}
        ${refused ? callout("danger", refused.error) : ""}
        <p class="lede confirm-lede">This file is canon, so deleting it is a proposal. The file stays, unchanged, until enough people approve it.</p>
        <ul class="consequences">
          <li>Once approved, <code>${path}</code> leaves the folder, search and agents’ reads. Its ${plural(f.versions, "version")} and the activity log stay.</li>
          <li>Reviewers see your reason with the proposal.</li>
        </ul>
        <form method="post" action="${vaultPath(id, "/file")}" class="panel confirm">
          ${csrfField(ctx.csrf)}<input type="hidden" name="path" value="${path}"><input type="hidden" name="action" value="propose-delete">
          <label for="why">Why delete it</label>
          <input id="why" type="text" name="reason" required value="${refused?.reason || `Delete ${path}`}">
          <div class="actions"><button class="danger">Propose deleting ${name}</button><a class="button quiet" href="${filePath(id, path)}">Cancel</a></div>
        </form>`
      : confirmPage({
          title: `Delete ${name}`,
          crumb: crumbs(id, v, path, false, "Delete"),
          lede: html`Deleting <code>${path}</code> removes it from the vault: it leaves the folder, search and agents’ reads at once.`,
          consequences: [
            `Its ${plural(f.versions, "version")} and the activity log stay: who wrote what, and when.`,
            "The path is free again: a file written there later starts fresh.",
            v.role === "owner"
              ? html`To blank the text as well, for example personal data, <a href="${erasePath(id, path)}">erase it</a> instead.`
              : "To blank the text as well, ask an owner to erase it instead.",
          ],
          action: vaultPath(id, "/file"),
          csrf: ctx.csrf,
          // The version this page shows, so a delete confirmed after someone
          // saved the file is refused instead of deleting text nobody here saw.
          // A refusal for another reason keeps the version that was sent.
          fields: { path, action: "delete", expected_version: refused?.expectedVersion ?? f.version },
          button: `Delete ${name}`,
          cancel: filePath(id, path),
          error: refused?.error,
        });
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, `Delete ${path}`, data.shell, "vaults"), ...(refused ? { status: 400 } : {}) };
}

export async function editView(ctx: Ctx, id: string, refused?: Refused): Promise<Reply> {
  const path = refused?.path ?? ctx.url.searchParams.get("path") ?? "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !(await writablePath(c, v, path))) return null;
    // A refused save shows the form as it was sent, with the version it
    // loaded: reloading the file here would drop the text, and would let the
    // next Save pass the stale-save check against a version never seen.
    let f: { policy: string; version: string | null; body: string } | undefined;
    if (refused) {
      const rule = await ruleFor(c, id, path);
      f = { policy: rule.rule?.policy ?? rule.def, version: refused.expectedVersion, body: refused.content };
    } else {
      f = (
        await c.query(
          `select f.path, (private.rule_for(f.vault_id, f.path)).policy, fv.id as version, fv.body
             from public.files f join public.file_versions fv on fv.id = f.current_version_id
            where f.vault_id = $1 and f.path = $2 and f.deleted_at is null and fv.erased_at is null`,
          [id, path],
        )
      ).rows[0];
    }
    if (!f) return null;
    const canon = f.policy === "canon";
    const claim = await claimBanner(c, ctx, v, path, canon ? "propose" : "write", filePath(id, path));
    // No delete here: it lives in the file page's More menu, behind a
    // confirm page, away from Save. On canon the required "Why" comes before
    // the text, so it's on screen with the header's button. expected_version
    // is the version the form loaded: an open file's Save compares it
    // against the current one (public.write_file), so a save from a stale
    // copy is refused instead of silently overwriting someone else's edit
    // (a proposal's staleness already goes through base_version_id, so
    // canon carries no expected_version here).
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false, canon ? "Propose a change" : "Edit"),
        title: `${canon ? "Propose a change to" : "Edit"} ${path.split("/").pop()}`,
        path: true,
        description: canon ? "This file is canon, so your edit becomes a proposal that people approve." : undefined,
        secondary: html`<a class="button quiet" href="${filePath(id, path)}">Cancel</a>`,
        primary: html`<button class="primary" form="edit-file">${canon ? "Propose change" : "Save"}</button>`,
      })}
      ${refused ? callout("danger", refused.error) : ""}
      ${claim}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="edit-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="${canon ? "propose" : "write"}">
        ${canon || !f.version ? "" : html`<input type="hidden" name="expected_version" value="${f.version}">`}
        ${canon ? html`<label for="r">Why this change</label>
          <p class="hint" id="r-hint">Reviewers see this after the diff.</p>
          <input id="r" type="text" name="reason" required aria-describedby="r-hint" value="${refused?.reason ?? ""}">` : ""}
        <label for="content">Text</label>
        <textarea id="content" name="content">${textareaText(f.body)}</textarea>
        <div class="actions"><button class="primary">${canon ? "Propose change" : "Save"}</button>
          <a class="button quiet" href="${filePath(id, path)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, `Edit ${path}`, data.shell, "vaults"), ...(refused ? { status: 400 } : {}) };
}

export async function newFile(ctx: Ctx, id: string, refused?: Refused): Promise<Reply> {
  // A refused create is shown again in the folder of the path that was typed.
  const typedDir = refused?.path.slice(0, refused.path.lastIndexOf("/") + 1);
  const given = (typedDir ?? ctx.url.searchParams.get("dir") ?? "").replace(/^\/+/, "");
  const dir = given ? given.replace(/\/*$/, "/") : "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !(await writablePath(c, v, dir))) return null;
    // The folder's rule decides the form: canon asks why and proposes; open
    // creates. A path typed into another folder still follows that folder's
    // rule when posted (fileAction), so the open form carries a reason too.
    const rule = await ruleFor(c, id, dir);
    const canon = (rule.rule?.policy ?? rule.def) === "canon";
    const verb = canon ? "Propose file" : "Create file";
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true, "New file") : [{ label: v.name, href: vaultPath(id) }, { label: "New file" }],
        title: "New file",
        description: canon ? "Files here are canon, so a new file becomes a proposal that people approve." : undefined,
        meta: ruleLine(ctx, id, rule),
        secondary: html`<a class="button quiet" href="${treePath(id, dir)}">Cancel</a>`,
        primary: html`<button class="primary" form="new-file">${verb}</button>`,
      })}
      ${refused ? callout("danger", refused.error) : ""}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="new-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="action" value="create">
        <label for="p">Path</label>
        <p class="hint" id="p-hint">Folders are part of the path. A path under a canon folder becomes a proposal.</p>
        <input id="p" type="text" name="path" value="${refused?.path ?? dir}" placeholder="${dir}new-file.md" required aria-describedby="p-hint">
        ${canon
          ? html`<label for="r">Why this file</label>
            <p class="hint" id="r-hint">Reviewers see this with the proposal.</p>
            <input id="r" type="text" name="reason" required aria-describedby="r-hint" value="${refused?.reason ?? ""}">`
          : html`<input type="hidden" name="reason" value="New file">`}
        <label for="c">Text</label><textarea id="c" name="content">${textareaText(refused?.content)}</textarea>
        <div class="actions"><button class="primary">${verb}</button>
          <a class="button quiet" href="${treePath(id, dir)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "New file", data.shell, "vaults"), ...(refused ? { status: 400 } : {}) };
}

// A stale save (public.write_file's RLF01): the file's current text and who
// saved it, next to the edit the person just tried to make, still in an
// editable box with the current version so Save tries again from there.
// Nothing typed is lost; nothing is written until they choose to.
async function conflictReply(ctx: Ctx, id: string, path: string, typed: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !(await writablePath(c, v, path))) return null;
    const cur = (
      await c.query(
        `select fv.id as version, fv.body, fv.author, fv.agent, f.updated_at
           from public.files f join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null and fv.erased_at is null`,
        [id, path],
      )
    ).rows[0];
    if (!cur) return { gone: true as const };
    const body = html`
      ${pageHeader({ crumb: crumbs(id, v, path, false, "Edit"), title: `Someone saved ${path.split("/").pop()} first`, path: true })}
      ${callout(
        "warning",
        html`${who(ctx, cur.author, cur.agent)} saved a new version of this file at ${time(cur.updated_at)}, while you were editing. Your edit hasn't been saved: it's still in the box below, unchanged. Compare it with the current version, then save again to save yours over it.`,
      )}
      <section class="panel" aria-label="Current version">
        <h2 class="pane-label">Current version, by ${who(ctx, cur.author, cur.agent)}</h2>
        <div class="file">${cur.body}</div>
      </section>
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="edit-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="write">
        <input type="hidden" name="expected_version" value="${cur.version}">
        <label for="content">Your edit, not yet saved</label>
        <textarea id="content" name="content">${textareaText(typed)}</textarea>
        <div class="actions"><button class="primary">Save over the current version</button>
          <a class="button quiet" href="${filePath(id, path)}">Discard your edit</a></div>
      </form>`;
    return { gone: false as const, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  // Deleted while they edited: a save would be creating the file again, which
  // is New file's job, so it comes back there with their text in it.
  if (data.gone) {
    const why = `${path} was deleted while you were editing it, so your edit was not saved. Your text is still below; Create file puts the file back`;
    return newFile(ctx, id, { error: message(new Refusal({ status: 409, where: "web app (the Edit form)", why })), path, content: typed, reason: "", expectedVersion: null });
  }
  return render(ctx, `Conflict editing ${path}`, data.shell, "vaults");
}

export async function fileAction(ctx: Ctx, id: string): Promise<Reply> {
  const f = ctx.form;
  const path = (f.get("path") ?? "").trim();
  const content = (f.get("content") ?? "").replaceAll("\r\n", "\n");
  const reason = f.get("reason") ?? "";
  const action = f.get("action") ?? "";
  const expectedVersion = f.get("expected_version") || null;
  if (!["create", "write", "delete", "propose", "propose-delete"].includes(action)) {
    const f = failure({ status: 400, where: "web app (the file form)", why: "The form named no action (create, write, delete, propose or propose-delete), so nothing was changed." });
    // No signed-in frame: it names the person, a lookup this refusal
    // shouldn't cost (web/test/final_sweep.test.mjs).
    return { status: 400, html: errorPage(f, { theme: ctx.theme, back: filePath(id, path) }) };
  }
  try {
    // One query in the transaction: the vault is checked inside it
    // (private.vault_ref, under RLS: RLV01 when the person can't see it), as
    // the MCP tools do. "create" follows the path's rule: a canon path
    // becomes a proposal, an open one a write (only the branch taken runs),
    // unless a file is already there: write_file would replace it with no
    // version to compare, so Create file never writes over one.
    const outcome = await asPerson(ctx.userId, async (c) => {
      const V = `(select private.vault_ref($1) as id offset 0) v`;
      if (action === "create") {
        const r = (
          await c.query(
            `select case when x.canon then public.propose(x.id, $2, $3, $4, false) end as pid,
                    case when not x.canon and not x.taken then public.write_file(x.id, $2, $3) end as written,
                    not x.canon and x.taken as taken
               from (select v.id, (private.rule_for(v.id, $2)).policy = 'canon' as canon,
                            exists (select 1 from public.files f where f.vault_id = v.id and f.path = $2 and f.deleted_at is null) as taken
                       from ${V} offset 0) x`,
            [id, path, content, reason],
          )
        ).rows[0];
        if (r.taken) {
          throw new Refusal({ status: 409, where: "web app (the New file form)", why: `A file already exists at ${path}. Open it and choose Edit, or pick another path` });
        }
        return r.pid ? ({ kind: "proposed", pid: r.pid as string } as const) : ({ kind: "write" } as const);
      }
      if (action === "write") {
        await c.query(`select public.write_file(v.id, $2, $3, $4) from ${V}`, [id, path, content, expectedVersion]);
        return { kind: "write" } as const;
      }
      if (action === "delete") {
        await c.query(`select public.delete_file(v.id, $2, $3) from ${V}`, [id, path, expectedVersion]);
        return { kind: "delete" } as const;
      }
      const del = action === "propose-delete";
      const pid = (await c.query(`select public.propose(v.id, $2, $3, $4, $5) as id from ${V}`, [id, path, del ? null : content, reason, del]))
        .rows[0].id as string;
      return { kind: "proposed", pid } as const;
    });
    if (outcome.kind === "delete") {
      ctx.setFlash(`Deleted ${path}.`, "success");
      return { redirect: vaultPath(id) };
    }
    if (outcome.kind === "proposed") {
      ctx.setFlash("Proposed. It applies once enough people approve it.", "success");
      return { redirect: proposalPath(id, outcome.pid) };
    }
    ctx.setFlash(`Saved ${path}.`, "success");
    return { redirect: filePath(id, path) };
  } catch (err) {
    if ((err as { code?: string }).code === "RLV01") return notFound(ctx);
    if ((err as { code?: string }).code === "RLF01" && action === "write") return conflictReply(ctx, id, path, content);
    const stale = (err as { code?: string }).code === "RLF01" && action === "delete";
    // The confirm page offers the file as it is now, so confirming again is a
    // choice made after this says it changed.
    const error = stale
      ? message(new Refusal({ status: 409, where: "web app (the Delete form)", why: `${path} changed after you opened this page, so it was not deleted. Open the file to see what changed, then delete it again if you still mean to` }))
      : message(err);
    // Not for a path that can't be shown back (control characters, over 200
    // characters): the page would print it in its title and breadcrumb.
    if (echoable(path)) {
      const show = action === "create" ? newFile : action === "write" || action === "propose" ? editView : deletePage;
      const again = await show(ctx, id, { error, path, content, reason, expectedVersion: stale ? null : expectedVersion });
      if (again.status === 400) return again;
    }
    ctx.setFlash(error);
    return { redirect: path ? filePath(id, path) : vaultPath(id) };
  }
}
