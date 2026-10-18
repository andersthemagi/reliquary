// A vault's Links page (docs/design.md, "Links"): a credential to an
// upstream MCP server, named and reachable by an agent as `<link>.<tool>`
// through the MCP proxy (mcp/, linkcall.ts) for any tool an owner has
// granted. Add, edit and delete are owners' only, in
// person; the database enforces this (20260928120000_links.sql) and this
// page only chooses what to offer. Credentials are sealed here with the
// same VARIABLES_KEYS as environment variables (secrets.ts, sealLink/
// openLink) and never sent back to the browser once saved: the add form has
// a credential field, the edit form doesn't.
//
// Adding a link also runs discovery (discovery.ts, 20260928180000's
// set_link_tools): the credential the owner just typed calls the upstream
// server's own tools/list before it's sealed away, and the result is
// stored, in the same request, before the flash is chosen. A discovery
// failure (an unreachable or slow server, a malformed response) doesn't
// undo the link -- it's flashed as a warning naming why, with a reference
// in the server log, and the link's tools simply stay empty.
//
// An owner can also replace a link's credential (sealed here, stored in
// place by replace_link_credential) or refresh its tools (the stored
// credential, read back still sealed by link_credential_for_discovery and
// opened only here); both run discovery again and keep the link's id and
// grants (20261018120000_link_replace_credential.sql).
//
// A link's tool grants (an owner's per-role allow list) have their own
// page, linkgrants.ts, reached from each link's row menu below.

import type pg from "pg";
import { asPerson } from "./db.js";
import { discoverTools, discoveryAllowsLoopback, DiscoveryError } from "./discovery.js";
import { callout, confirmPage, csrfField, emptyState, html, menu, pageHeader, time, type Raw } from "./html.js";
import { fail, failure, Refusal } from "./failure.js";
import { vaultShell } from "./files.js";
import { fromDb, openLink, sealLink, SecretsError, variablesConfigured } from "./secrets.js";
import { message, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";

type Link = { id: string; name: string; url: string; created_by: string; created_at: Date };

// The Add/Edit form's values, as typed, when saving was refused.
type LinkForm = { id?: string; name: string; url: string; credential?: string; error?: string; field?: "name" | "url" | "credential"; replace?: boolean };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// The rules of private.check_link_url (20261009120041_link_url_shape.sql),
// in its order, so the form refuses what the database would and says which
// rule broke. A url is plain text every member and agent reads, and the log
// keeps it, so nothing that could be a credential may ride in it.
function urlProblem(url: string): string | null {
  if (!url.startsWith("https://")) return "A link’s URL must start with https://.";
  if (url.length > 2048) return "A link’s URL is at most 2048 characters.";
  const leak = "Every member and agent can read a link’s URL, and it is logged: put a key or token in the link’s credential instead.";
  if (/^https:\/\/[^/?#]*@/.test(url)) return `A link’s URL can’t hold a user name or password (user:password@). ${leak}`;
  if (/[?#]/.test(url)) return `A link’s URL can’t have a query string (?) or a fragment (#). ${leak}`;
  if (!/^https:\/\/[^/?#@]+(\/[^?#]*)?$/.test(url)) return "A link’s URL is https://, a host and an optional path.";
  return null;
}

async function loadLinks(c: pg.PoolClient, id: string): Promise<Link[]> {
  return (
    await c.query(`select id, name, url, created_by, created_at from public.links where vault_id = $1 order by name`, [id])
  ).rows;
}

type CallSummary = { last: Date | null; week: number };

// ponytail: aggregates every call of the vault per page view; a per-link
// summary table if a vault's call log grows into the millions.
async function callSummary(c: pg.PoolClient, id: string): Promise<Map<string, CallSummary>> {
  const { rows } = await c.query(
    `select link_id, max(at) as last, count(*) filter (where at > now() - interval '7 days')::int as week
       from public.link_calls where vault_id = $1 group by link_id`,
    [id],
  );
  return new Map(rows.map((r) => [r.link_id, { last: r.last, week: r.week }]));
}

export async function links(ctx: Ctx, id: string, form?: LinkForm): Promise<Reply> {
  const del = ctx.url.searchParams.get("delete");
  if (ctx.method === "GET" && del !== null) return deletePage(ctx, id, del);
  const edit = ctx.method === "GET" ? ctx.url.searchParams.get("edit") : null;
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const list = await loadLinks(c, id);
    const owner = v.role === "owner";
    // link_calls' RLS shows owners and editors their vault's calls, and no
    // one else; a viewer gets no Calls columns rather than empty ones.
    const readsCalls = owner || v.role === "editor";
    const calls = readsCalls ? await callSummary(c, id) : new Map<string, CallSummary>();
    // A refused save of an edit comes back as an edit: the form's own id
    // wins over the query, which a POST doesn't carry.
    const replacingId = form?.replace ? form.id : ctx.method === "GET" ? ctx.url.searchParams.get("replace") : null;
    const replacing = owner && replacingId ? list.find((l) => l.id === replacingId) : undefined;
    const editingId = form?.replace ? null : (form?.id ?? edit);
    const editing = editingId ? list.find((l) => l.id === editingId) : undefined;
    const values: LinkForm | undefined = form ?? (editing ? { id: editing.id, name: editing.name, url: editing.url } : undefined);
    const described = (f: LinkForm["field"], hint: string) =>
      form?.error && form.field === f ? html` aria-invalid="true" aria-describedby="link-error ${hint}"` : html` aria-describedby="${hint}"`;

    const configured = variablesConfigured();
    const addForm = owner
      ? html`<form method="post" action="${vaultPath(id, "/links")}" class="panel rule-form" id="add-link" aria-labelledby="add-link-title">
          <h2 id="add-link-title" class="form-title">${editing ? html`Edit <code>${editing.name}</code>` : "Add a link"}</h2>
          ${csrfField(ctx.csrf)}
          <input type="hidden" name="op" value="save">
          ${editing ? html`<input type="hidden" name="link_id" value="${editing.id}">` : ""}
          ${form?.error ? html`<p class="callout danger" role="alert" id="link-error">${form.error}</p>` : ""}
          ${!editing && !configured
            ? callout("warning", "This server has no key for encrypting credentials (VARIABLES_KEY), so a link can’t be added right now.")
            : ""}
          <div class="fields">
            <div><label for="ln">Name</label><input id="ln" type="text" name="name" placeholder="linear" required maxlength="64" pattern="[A-Za-z_][A-Za-z0-9_]*" value="${values?.name ?? ""}"${described("name", "ln-hint")}></div>
            <div><label for="lu">URL</label><input id="lu" type="text" name="url" placeholder="https://mcp.example.com/mcp" required maxlength="2048" value="${values?.url ?? ""}"${described("url", "lu-hint")}></div>
            ${editing
              ? ""
              : html`<div><label for="lc">Credential</label><input id="lc" type="password" name="credential" autocomplete="new-password" required maxlength="65536"${described("credential", "lc-hint")}></div>`}
          </div>
          <p class="hint" id="ln-hint">A short name like <code>linear</code>: letters, digits and underscores, not starting with a digit. Agents use it to tell this service’s tools apart from others.</p>
          <p class="hint" id="lu-hint">The address where this service offers its tools to agents, from the service’s own setup page: https://, a host and a path. Everyone in the vault can read it, so a key or token never goes here.</p>
          ${editing
            ? html`<p class="hint" id="lc-hint">The credential isn’t shown or changed here. To replace it, choose Replace credential in this link’s menu; its grants stay. Changing the URL keeps the credential, which is then sent to the new address, and keeps the tools already discovered.</p>`
            : html`<p class="hint" id="lc-hint">The service’s API key or token. It is stored encrypted and never shown again, to anyone, once saved.</p>`}
          <div class="actions"><button class="primary"${!editing && !configured ? " disabled" : ""}>${editing ? "Save changes" : "Add link"}</button><a class="button quiet" href="${vaultPath(id, "/links")}">Cancel</a></div>
        </form>`
      : "";

    const replaceForm = replacing
      ? html`<form method="post" action="${vaultPath(id, "/links")}" class="panel rule-form" id="replace-link" aria-labelledby="replace-link-title">
          <h2 id="replace-link-title" class="form-title">Replace the credential for <code>${replacing.name}</code></h2>
          ${csrfField(ctx.csrf)}
          <input type="hidden" name="op" value="replace">
          <input type="hidden" name="link_id" value="${replacing.id}">
          ${form?.error ? html`<p class="callout danger" role="alert" id="link-error">${form.error}</p>` : ""}
          <div class="fields">
            <div><label for="lr">New credential</label><input id="lr" type="password" name="credential" autocomplete="new-password" required maxlength="65536"${described("credential", "lr-hint")}></div>
          </div>
          <p class="hint" id="lr-hint">The service’s new API key or token. It replaces the stored one at once and is never shown again, to anyone. The link keeps its name, URL and grants, and its tools are discovered again with the new credential.</p>
          <div class="actions"><button class="primary"${configured ? "" : " disabled"}>Replace credential</button><a class="button quiet" href="${vaultPath(id, "/links")}">Cancel</a></div>
        </form>`
      : "";

    const table = list.length
      ? html`<div class="table-wrap"><table class="table-stack rules-table">
          <thead><tr><th scope="col">Name</th><th scope="col">URL</th><th scope="col">Added by</th>${readsCalls ? html`<th scope="col">Last call</th><th scope="col" class="num">Last 7 days</th>` : ""}${owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
          <tbody>${list.map(
            (l) => html`<tr>
              <td data-label="Name"><code>${l.name}</code></td>
              <td data-label="URL" class="small link-url">${l.url}</td>
              <td data-label="Added by" class="small muted"><div>${who(ctx, l.created_by, null)} · ${time(l.created_at)}</div></td>
              ${readsCalls
                ? html`<td data-label="Last call" class="small"><a href="${vaultPath(id, `/links/${l.id}/calls`)}">${calls.get(l.id)?.last ? time(calls.get(l.id)!.last!) : "Never"}</a></td>
                  <td data-label="Last 7 days" class="small num">${calls.get(l.id)?.week ?? 0}</td>`
                : ""}
              ${owner
                ? html`<td class="num rule-actions">${menu({
                    label: `Actions for ${l.name}`,
                    icon: "more",
                    items: [
                      { href: `${vaultPath(id, "/links")}?edit=${q(l.id)}#add-link`, label: "Edit", description: "Name or URL" },
                      { href: vaultPath(id, `/links/${l.id}/grants`), label: "Grants", description: "Which tools each role may call" },
                      { href: vaultPath(id, `/links/${l.id}/calls`), label: "Calls", description: "Who used it, with which tool, and how it went" },
                      { href: `${vaultPath(id, "/links")}?replace=${q(l.id)}#replace-link`, label: "Replace credential", description: "A new key; grants stay" },
                      { action: vaultPath(id, "/links"), csrf: ctx.csrf, fields: { op: "refresh", link_id: l.id }, label: "Refresh tools", description: "Discover its tools again" },
                      { href: `${vaultPath(id, "/links")}?delete=${q(l.id)}`, label: "Delete", description: "Asks you to confirm first", danger: true },
                    ],
                  })}</td>`
                : ""}
            </tr>`,
          )}</tbody></table></div>`
      : emptyState({
          title: "No links yet",
          body: owner
            ? "A link holds a shared key to a service like Linear or Stripe, so a member’s agent can use that service’s tools without ever seeing the key."
            : "Only owners add links. Ask an owner of this vault.",
        });

    // The list is what people come for; the form shows only when asked for
    // (Add link, Edit) or refused, and then goes first so its message is on
    // the first screen.
    const formOpen = !!(form?.error || editing || replacing || (ctx.method === "GET" && ctx.url.searchParams.has("add")));
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Links" }],
        title: "Links",
        description: "A vault’s keys to outside services, shared by everyone with access, seen by no one.",
        primary: owner && !formOpen ? html`<a class="button primary" href="${vaultPath(id, "/links")}?add=1#add-link">Add link</a>` : "",
      })}
      ${replacing ? replaceForm : formOpen ? addForm : ""}
      ${table}
      <p class="hint">Adding a link discovers its tools. An owner grants a tool per role from its Grants page, and an agent with a granted role can then call it over MCP as <code>&lt;link&gt;.&lt;tool&gt;</code>. An agent can list a vault’s links, never their credentials, with <code>list_links</code>. <a href="/docs/concepts/links">How links work</a></p>`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "links" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Links", data.shell, "vaults"), ...(form?.error ? { status: 400 } : {}) };
}

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (Links form)", why }));

async function saveLink(ctx: Ctx, id: string): Promise<Reply> {
  const linkId = (ctx.form.get("link_id") ?? "").trim() || undefined;
  const name = (ctx.form.get("name") ?? "").trim();
  const url = (ctx.form.get("url") ?? "").trim();
  const credential = ctx.form.get("credential") ?? "";
  const again = (error: string, field: LinkForm["field"]) => links(ctx, id, { id: linkId, name, url, error, field });

  if (!NAME.test(name)) {
    return again(refuse("A link’s name is letters, digits and underscores, not starting with a digit, up to 64 characters. Nothing was saved"), "name");
  }
  const problem = urlProblem(url);
  if (problem) return again(refuse(`${problem} Nothing was saved`), "url");
  if (!linkId && credential.trim().length === 0) {
    return again(refuse("A credential is required to add a link. Nothing was saved"), "credential");
  }

  try {
    if (linkId) {
      await asPerson(ctx.userId, (c) => c.query(`select public.update_link($1, $2, $3)`, [linkId, name, url]));
      ctx.setFlash(`Saved changes to ${name}.`, "success");
    } else {
      const sealed = sealLink(credential, id);
      const newLinkId = await asPerson(ctx.userId, async (c) => {
        const { rows } = await c.query(`select public.create_link($1, $2, $3, $4, $5, $6) as id`, [id, name, url, sealed.keyId, sealed.nonce, sealed.ciphertext]);
        return rows[0].id as string;
      });
      try {
        const tools = await discoverTools(url, credential, { allowLoopback: discoveryAllowsLoopback() });
        await asPerson(ctx.userId, (c) =>
          c.query(`select public.set_link_tools($1, $2::jsonb)`, [
            newLinkId,
            JSON.stringify(tools.map((t) => ({ name: t.name, is_write: t.isWrite, description: t.description }))),
          ]),
        );
        const n = tools.length;
        ctx.setFlash(`Added ${name}. Discovered ${n} tool${n === 1 ? "" : "s"}.`, "success");
      } catch (discErr) {
        const f =
          discErr instanceof DiscoveryError
            ? failure({ status: 502, where: "link discovery", why: discErr.message })
            : fail(discErr, { where: "link discovery", what: `Discovering ${name}’s tools` });
        ctx.setFlash(`Added ${name}, but its tools couldn’t be discovered. ${f.why} (ref ${f.ref})`, "warning");
      }
    }
  } catch (err) {
    if (err instanceof SecretsError) return again(refuse(err.message), "credential");
    const code = (err as { code?: string }).code;
    // (vault_id, name) is the only unique key either function can break;
    // Postgres's own words for it are the constraint's, not a person's.
    if (code === "23505") return again(refuse(`There is already a link named ${name} in this vault. Pick another name. Nothing was saved`), "name");
    const text = message(err);
    if (code === "22023") return again(text, "name");
    ctx.setFlash(text);
  }
  return { redirect: vaultPath(id, "/links") };
}

// The confirm step before a link is deleted: an agent that could call its
// tools loses that ability at once. Owners only; anyone else, or a link
// that doesn't exist, is sent back with a note.
async function deletePage(ctx: Ctx, id: string, linkId: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c): Promise<{ gone: string } | { shell: Raw } | null> => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    if (v.role !== "owner") return { gone: "Only owners delete links; ask an owner of this vault." };
    const list = await loadLinks(c, id);
    const link = list.find((l) => l.id === linkId);
    if (!link) return { gone: "That link doesn’t exist; it may have been deleted already." };
    const body = confirmPage({
      crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Links", href: vaultPath(id, "/links") }, { label: "Delete" }],
      title: `Delete the link ${link.name}?`,
      lede: html`<code>${link.name}</code> (<code>${link.url}</code>) and its stored credential are deleted at once.`,
      consequences: [
        "Any grants set for its tools are deleted with it.",
        "The removal is logged in Activity. You can add a link with the same name again later, with a fresh credential.",
      ],
      action: vaultPath(id, "/links"),
      csrf: ctx.csrf,
      fields: { op: "delete", link_id: link.id },
      button: `Delete ${link.name}`,
      cancel: vaultPath(id, "/links"),
    });
    return { shell: await vaultShell(c, ctx, v, { section: "links" }, body) };
  });
  if (!data) return notFound(ctx);
  if ("gone" in data) {
    ctx.setFlash(data.gone, "warning");
    return { redirect: vaultPath(id, "/links") };
  }
  return render(ctx, "Delete link", data.shell, "vaults");
}

async function deleteLink(ctx: Ctx, id: string): Promise<Reply> {
  const linkId = ctx.form.get("link_id") ?? "";
  try {
    const name = await asPerson(ctx.userId, async (c) => {
      const list = await loadLinks(c, id);
      const link = list.find((l) => l.id === linkId);
      if (!link) return null;
      await c.query(`select public.delete_link($1)`, [linkId]);
      return link.name;
    });
    if (name === null) {
      ctx.setFlash("That link doesn’t exist; it may have been deleted already.", "warning");
    } else {
      ctx.setFlash(`Deleted ${name}.`, "success");
    }
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/links") };
}

// Discovers a link's tools again and stores them (set_link_tools keeps an
// owner's grant choices, seeds new tools' defaults and drops the ones the
// upstream no longer lists), then flashes what changed. A failure keeps
// the link as it is and says why, with a reference, like adding does.
async function rediscover(ctx: Ctx, link: { id: string; name: string; url: string }, credential: string, done: string, failed: string): Promise<void> {
  try {
    const tools = await discoverTools(link.url, credential, { allowLoopback: discoveryAllowsLoopback() });
    const before = await asPerson(ctx.userId, async (c) => {
      const { rows } = await c.query(`select tool_name from public.link_tools where link_id = $1`, [link.id]);
      await c.query(`select public.set_link_tools($1, $2::jsonb)`, [
        link.id,
        JSON.stringify(tools.map((t) => ({ name: t.name, is_write: t.isWrite, description: t.description }))),
      ]);
      return new Set(rows.map((r) => r.tool_name as string));
    });
    const found = new Set(tools.map((t) => t.name));
    const added = [...found].filter((n) => !before.has(n)).sort();
    const removed = [...before].filter((n) => !found.has(n)).sort();
    const n = found.size;
    const change = [added.length ? `Added ${added.join(", ")}.` : "", removed.length ? `Removed ${removed.join(", ")}.` : ""].filter(Boolean).join(" ");
    ctx.setFlash(`${done} Discovered ${n} tool${n === 1 ? "" : "s"}. ${change || "No tools were added or removed."}`, "success");
  } catch (err) {
    const f =
      err instanceof DiscoveryError
        ? failure({ status: 502, where: "link discovery", why: err.message })
        : fail(err, { where: "link discovery", what: `Discovering ${link.name}’s tools` });
    ctx.setFlash(`${failed} ${f.why} (ref ${f.ref})`, "warning");
  }
}

async function replaceCredential(ctx: Ctx, id: string): Promise<Reply> {
  const linkId = ctx.form.get("link_id") ?? "";
  const credential = ctx.form.get("credential") ?? "";
  const again = (error: string) => links(ctx, id, { id: linkId, name: "", url: "", error, field: "credential", replace: true });
  if (credential.trim().length === 0) return again(refuse("Type the new credential. Nothing was changed"));
  let link: Link | undefined;
  try {
    const sealed = sealLink(credential, id);
    link = await asPerson(ctx.userId, async (c) => {
      const found = (await loadLinks(c, id)).find((l) => l.id === linkId);
      if (found) await c.query(`select public.replace_link_credential($1, $2, $3, $4)`, [linkId, sealed.keyId, sealed.nonce, sealed.ciphertext]);
      return found;
    });
  } catch (err) {
    if (err instanceof SecretsError) return again(refuse(err.message));
    ctx.setFlash(message(err));
    return { redirect: vaultPath(id, "/links") };
  }
  if (!link) ctx.setFlash("That link doesn’t exist; it may have been deleted.", "warning");
  else await rediscover(ctx, link, credential, `Replaced ${link.name}’s credential.`, `Replaced ${link.name}’s credential, but its tools couldn’t be discovered, so they are as they were.`);
  return { redirect: vaultPath(id, "/links") };
}

async function refreshTools(ctx: Ctx, id: string): Promise<Reply> {
  const linkId = ctx.form.get("link_id") ?? "";
  try {
    const found = await asPerson(ctx.userId, async (c) => {
      const link = (await loadLinks(c, id)).find((l) => l.id === linkId);
      if (!link) return null;
      const { rows } = await c.query(`select public.link_credential_for_discovery($1) as s`, [linkId]);
      return { link, sealed: rows[0].s };
    });
    if (!found) {
      ctx.setFlash("That link doesn’t exist; it may have been deleted.", "warning");
    } else {
      const { link } = found;
      await rediscover(ctx, link, openLink(fromDb(found.sealed), id), `Refreshed ${link.name}’s tools.`, `Couldn’t refresh ${link.name}’s tools, so they are as they were.`);
    }
  } catch (err) {
    if (err instanceof SecretsError) {
      const f = failure({ status: 500, where: "web app (Links)", why: err.message, what: "Opening a link’s stored credential" });
      ctx.setFlash(`${f.why} (ref ${f.ref})`);
    } else ctx.setFlash(message(err));
  }
  return { redirect: vaultPath(id, "/links") };
}

async function linkAction(ctx: Ctx, id: string): Promise<Reply> {
  const op = ctx.form.get("op");
  if (op === "delete") return deleteLink(ctx, id);
  if (op === "replace") return replaceCredential(ctx, id);
  if (op === "refresh") return refreshTools(ctx, id);
  return saveLink(ctx, id);
}

export async function linksRoutes(ctx: Ctx, id: string): Promise<Reply> {
  return ctx.method === "GET" ? links(ctx, id) : linkAction(ctx, id);
}
