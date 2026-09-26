// Files and folders: the vault shell (sidebar, search box and folder tree),
// folder and file pages, the editor, New file, and the file form's actions.
// Each handler runs its queries as the signed-in person through asPerson();
// the database decides what they may see and do.

import type pg from "pg";
import { asPerson } from "./db.js";
import { activityBody } from "./activity.js";
import { csrfField, html, pageHeader, raw, when, type Raw } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import { errorPage } from "./errorpage.js";
import { failure } from "./failure.js";
import {
  ago,
  canWrite,
  filePath,
  message,
  notFound,
  proposalPath,
  q,
  render,
  tag,
  treePath,
  vault,
  vaultPath,
  who,
  type Ctx,
  type Reply,
  type Vault,
} from "./pages.js";

// Vault shell: sidebar with search, links and the folder tree.

type TreeNode = { dirs: Map<string, TreeNode>; files: { name: string; path: string; policy: string }[] };
export type Section = "files" | "proposals" | "activity" | "rules" | "search" | "variables" | "settings";

export async function vaultShell(c: pg.PoolClient, ctx: Ctx, v: Vault, current: { path?: string; section?: Section }, body: Raw): Promise<Raw> {
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

  const link = (section: Section, href: string, label: Raw | string) =>
    html`<a href="${href}"${current.section === section ? raw(' aria-current="page"') : ""}>${label}</a>`;
  // Settings holds Rules, so the Rules page marks Settings as current.
  const settingsLink = () => link(current.section === "rules" ? "rules" : "settings", vaultPath(v.id, "/config"), "Settings");
  const tree = files.length ? renderNode(root, "") : html`<p class="muted small tree-empty">No files yet.</p>`;
  return html`<div class="vault">
    <aside class="side">
      <a class="side-title" href="${vaultPath(v.id)}">${v.name}</a>
      <form class="side-search" method="get" action="${vaultPath(v.id, "/search")}" role="search">
        <input type="search" name="q" placeholder="Search this vault" aria-label="Search this vault" value="${current.section === "search" ? ctx.url.searchParams.get("q") ?? "" : ""}">
      </form>
      <nav class="side-links" aria-label="Vault">
        ${link("files", vaultPath(v.id), "Files")}
        ${link("proposals", vaultPath(v.id, "/proposals"), html`Proposals${open ? html`<span class="count">${open}</span>` : ""}`)}
        ${link("activity", vaultPath(v.id, "/activity"), "Activity")}
        ${link("variables", vaultPath(v.id, "/variables"), "Variables")}
        ${settingsLink()}
      </nav>
      <nav class="tree" aria-label="Files">${tree}</nav>
    </aside>
    <details class="tree-mobile"><summary>Browse ${v.name}</summary>
      <nav class="side-links" aria-label="Vault (mobile)">
        ${link("files", vaultPath(v.id), "Files")}${link("proposals", vaultPath(v.id, "/proposals"), "Proposals")}${link("activity", vaultPath(v.id, "/activity"), "Activity")}${link("variables", vaultPath(v.id, "/variables"), "Variables")}${settingsLink()}
      </nav>
      <nav class="tree" aria-label="Files (mobile)">${tree}</nav></details>
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
  if (!r.rule) return html`<p class="rule">${tag(r.def)} <span>The vault default. <a href="${vaultPath(id, "/rules")}">Rules</a></span></p>`;
  const needs = r.rule.policy === "canon" ? ` Changes need ${r.rule.quorum} approval${r.rule.quorum > 1 ? "s" : ""}.` : "";
  return html`<p class="rule">${tag(r.rule.policy)} <span>From the rule on <a href="${vaultPath(id, "/rules")}"><code>${r.rule.path}</code></a>${
    r.rule.set_at ? `, set by ${who(ctx, r.rule.set_by, null)} ${ago(r.rule.set_at)}` : ""
  }.${needs}</span></p>`;
}

export function crumbs(id: string, v: Vault, path: string, isDir: boolean): Raw {
  const parts = path.split("/").filter(Boolean);
  const links: Raw[] = [html`<a href="${vaultPath(id)}">${v.name}</a>`];
  const upto = isDir ? parts.length : parts.length - 1;
  for (let i = 0; i < upto; i++) {
    const dir = parts.slice(0, i + 1).join("/") + "/";
    links.push(html`<a href="${treePath(id, dir)}">${parts[i]}</a>`);
  }
  return html`<p class="crumb">${links.map((l, i) => html`${i ? html`<span aria-hidden="true"> / </span>` : ""}${l}`)}</p>`;
}

// ---------------------------------------------------------------------------
// Folders and files

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
    const readme = here.find((f) => /^readme\.md$/i.test(f.path.slice(dir.length)));
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true) : undefined,
        title: dir ? dir.slice(0, -1).split("/").pop()! : v.name,
        path: !!dir,
        meta: rule ? ruleLine(ctx, id, rule) : undefined,
        actions: html`${!dir ? html`<a class="button" href="/connect">Connect an agent</a>` : ""}
          ${canWrite(v) ? html`<a class="button primary" href="${vaultPath(id, `/new${dir ? `?dir=${q(dir)}` : ""}`)}">New file${dir ? " here" : ""}</a>` : ""}`,
      })}
      ${children.length === 0
        ? html`<div class="empty"><strong>This vault is empty.</strong> ${canWrite(v) ? "Create the first file, or connect an agent and ask it to write one." : "Nothing has been shared here yet."}</div>`
        : html`<div class="table-wrap"><table>
          <tr><th>Name</th><th>Policy</th><th class="num hide-sm">Updated</th></tr>
          ${[...subdirs.entries()].map(
            ([name, at]) => html`<tr><td><a class="dir" href="${treePath(id, `${dir}${name}/`)}">${name}/</a></td><td></td>
              <td class="num small muted hide-sm">${ago(at)}</td></tr>`,
          )}
          ${here.map(
            (f) => html`<tr><td><a href="${filePath(id, f.path)}">${f.path.slice(dir.length)}</a></td><td>${tag(f.policy)}</td>
              <td class="num small muted hide-sm">${ago(f.updated_at)}</td></tr>`,
          )}</table></div>`}
      ${readme?.body ? html`<h2>${readme.path.slice(dir.length)}</h2><div class="prose entry">${raw(renderMarkdown(readme.body))}</div>` : ""}`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, dir || data.v.name, data.shell, "vaults");
}

export async function fileView(ctx: Ctx, id: string): Promise<Reply> {
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
    const tabLink = (name: string, label: string) =>
      html`<a href="${filePath(id, path, name === "preview" ? undefined : name)}"${tab === name ? raw(' aria-current="page"') : ""}>${label}</a>`;
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false),
        title: path.split("/").pop()!,
        path: true,
        meta: html`${ruleLine(ctx, id, rule)}
          <p class="meta"><span>Last written by ${who(ctx, f.author, f.agent)}</span><span>${when(f.created_at)}</span></p>`,
        actions: html`${v.role === "owner" ? moreMenu(id, path) : ""}${
          canWrite(v) && !f.erased_at
            ? html`<a class="button${canon ? "" : " primary"}" href="${vaultPath(id, `/edit?path=${q(path)}`)}">${canon ? "Propose a change" : "Edit"}</a>`
            : ""
        }`,
      })}
      ${pending.length
        ? html`<p class="callout info">${pending.length === 1
            ? html`There’s an open proposal for this file. <a href="${proposalPath(id, pending[0].id)}">Review it</a>`
            : html`There are ${pending.length} open proposals for this file. <a href="${vaultPath(id, "/proposals")}">Review them</a>`}</p>`
        : ""}
      <nav class="tabs" aria-label="File view">${tabLink("preview", "Preview")}${tabLink("source", "Source")}${tabLink("history", "History")}</nav>
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

// The file page's "More" menu: rare or irreversible actions, each through
// its own confirm page.
const moreMenu = (id: string, path: string) =>
  html`<details class="menu-wrap more-menu"><summary class="button quiet">More</summary>
    <div class="menu"><a class="danger" href="${vaultPath(id, `/erase?path=${q(path)}`)}">Erase this file…</a></div></details>`;

export async function editView(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const f = (
      await c.query(
        `select f.path, (private.rule_for(f.vault_id, f.path)).policy, fv.body
           from public.files f join public.file_versions fv on fv.id = f.current_version_id
          where f.vault_id = $1 and f.path = $2 and f.deleted_at is null and fv.erased_at is null`,
        [id, path],
      )
    ).rows[0];
    if (!f) return null;
    const canon = f.policy === "canon";
    const body = html`
      ${pageHeader({
        crumb: crumbs(id, v, path, false),
        title: `${canon ? "Propose a change to" : "Edit"} ${path.split("/").pop()}`,
        path: true,
        actions: html`<a class="button quiet" href="${filePath(id, path)}">Cancel</a>
          <button class="primary" form="edit-file">${canon ? "Propose change" : "Save"}</button>`,
      })}
      ${canon ? html`<p class="lede">This file is canon, so your edit becomes a proposal that people approve.</p>` : ""}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="edit-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="${canon ? "propose" : "write"}">
        <label for="content">Text</label>
        <textarea id="content" name="content">${f.body}</textarea>
        ${canon ? html`<label for="r">Why this change</label><input id="r" type="text" name="reason" required>
          <p class="hint">Reviewers see this after the diff.</p>` : ""}
        <div class="actions"><button class="primary">${canon ? "Propose change" : "Save"}</button>
          <a class="button quiet" href="${filePath(id, path)}">Cancel</a></div>
      </form>
      <h2>Delete</h2>
      <form method="post" action="${vaultPath(id, "/file")}" class="danger-zone">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="path" value="${path}">
        <input type="hidden" name="action" value="${canon ? "propose-delete" : "delete"}">
        ${canon ? html`<input type="hidden" name="reason" value="Delete ${path}">` : ""}
        <p class="muted small">${canon ? "Deleting a canon file is a proposal too." : "The file’s history stays in the activity log."}</p>
        <button class="danger">${canon ? "Propose deleting this file" : "Delete this file"}</button>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Edit ${path}`, data.shell, "vaults");
}

export async function newFile(ctx: Ctx, id: string): Promise<Reply> {
  const dir = (ctx.url.searchParams.get("dir") ?? "").replace(/^\/+/, "");
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const body = html`
      ${pageHeader({
        crumb: dir ? crumbs(id, v, dir, true) : undefined,
        title: "New file",
        actions: html`<a class="button quiet" href="${treePath(id, dir)}">Cancel</a>
          <button class="primary" form="new-file">Create file</button>`,
      })}
      <form method="post" action="${vaultPath(id, "/file")}" class="panel" id="new-file">
        ${csrfField(ctx.csrf)}
        <input type="hidden" name="action" value="create">
        <label for="p">Path</label><input id="p" type="text" name="path" value="${dir}" placeholder="notes/standup.md" required>
        <p class="hint">Folders are part of the path. A path under a canon folder becomes a proposal.</p>
        <label for="c">Text</label><textarea id="c" name="content"></textarea>
        <label for="r">Why (only used if this becomes a proposal)</label>
        <input id="r" type="text" name="reason" value="New file">
        <div class="actions"><button class="primary">Create file</button>
          <a class="button quiet" href="${treePath(id, dir)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: dir, section: "files" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "New file", data.shell, "vaults");
}

export async function fileAction(ctx: Ctx, id: string): Promise<Reply> {
  const f = ctx.form;
  const path = (f.get("path") ?? "").trim();
  const content = (f.get("content") ?? "").replaceAll("\r\n", "\n");
  const reason = f.get("reason") ?? "";
  const action = f.get("action") ?? "";
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
    // becomes a proposal, an open one a write (only the branch taken runs).
    const outcome = await asPerson(ctx.userId, async (c) => {
      const V = `(select private.vault_ref($1) as id offset 0) v`;
      if (action === "create") {
        const r = (
          await c.query(
            `select case when x.canon then public.propose(x.id, $2, $3, $4, false) end as pid,
                    case when not x.canon then public.write_file(x.id, $2, $3) end as written
               from (select v.id, (private.rule_for(v.id, $2)).policy = 'canon' as canon from ${V} offset 0) x`,
            [id, path, content, reason],
          )
        ).rows[0];
        return r.pid ? ({ kind: "proposed", pid: r.pid as string } as const) : ({ kind: "write" } as const);
      }
      if (action === "write") {
        await c.query(`select public.write_file(v.id, $2, $3) from ${V}`, [id, path, content]);
        return { kind: "write" } as const;
      }
      if (action === "delete") {
        await c.query(`select public.delete_file(v.id, $2) from ${V}`, [id, path]);
        return { kind: "delete" } as const;
      }
      const del = action === "propose-delete";
      const pid = (await c.query(`select public.propose(v.id, $2, $3, $4, $5) as id from ${V}`, [id, path, del ? null : content, reason, del]))
        .rows[0].id as string;
      return { kind: "proposed", pid } as const;
    });
    if (outcome.kind === "delete") {
      ctx.setFlash(`Deleted ${path}.`);
      return { redirect: vaultPath(id) };
    }
    if (outcome.kind === "proposed") {
      ctx.setFlash("Proposed. It applies once enough people approve it.");
      return { redirect: proposalPath(id, outcome.pid) };
    }
    ctx.setFlash(`Saved ${path}.`);
    return { redirect: filePath(id, path) };
  } catch (err) {
    if ((err as { code?: string }).code === "RLV01") return notFound(ctx);
    ctx.setFlash(message(err));
    return { redirect: path ? filePath(id, path) : vaultPath(id) };
  }
}
