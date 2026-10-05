// A vault's Links page (docs/design.md, "Links"): a credential to an
// upstream MCP server, named and reachable by an agent as `<link>.<tool>`
// once the MCP proxy exists (mcp/, not built yet -- see the note this page
// shows on an empty vault). Add, edit and delete are owners' only, in
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
// in the server log, and the link's tools simply stay empty. There is no
// rediscovery yet (discovery.ts's own header): retrying today means
// deleting and re-adding the link.
//
// A link's tool grants (an owner's per-role allow list) have their own
// page, linkgrants.ts, reached from each link's row menu below.

import type pg from "pg";
import { asPerson } from "./db.js";
import { discoverTools, discoveryAllowsLoopback, DiscoveryError } from "./discovery.js";
import { callout, confirmPage, csrfField, emptyState, html, menu, pageHeader, time, type Raw } from "./html.js";
import { fail, failure, Refusal } from "./failure.js";
import { vaultShell } from "./files.js";
import { sealLink, SecretsError, variablesConfigured } from "./secrets.js";
import { message, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";

type Link = { id: string; name: string; url: string; created_by: string; created_at: Date };

// The Add/Edit form's values, as typed, when saving was refused.
type LinkForm = { id?: string; name: string; url: string; credential?: string; error?: string; field?: "name" | "url" | "credential" };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const URL_RE = /^https:\/\/[^/?#]+/;

async function loadLinks(c: pg.PoolClient, id: string): Promise<Link[]> {
  return (
    await c.query(`select id, name, url, created_by, created_at from public.links where vault_id = $1 order by name`, [id])
  ).rows;
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
    // A refused save of an edit comes back as an edit: the form's own id
    // wins over the query, which a POST doesn't carry.
    const editingId = form?.id ?? edit;
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
            <div><label for="lu">URL</label><input id="lu" type="text" name="url" placeholder="https://api.linear.app" required maxlength="2048" value="${values?.url ?? ""}"${described("url", "lu-hint")}></div>
            ${editing
              ? ""
              : html`<div><label for="lc">Credential</label><input id="lc" type="password" name="credential" autocomplete="new-password" required maxlength="65536"${described("credential", "lc-hint")}></div>`}
          </div>
          <p class="hint" id="ln-hint">Letters, digits and underscores, not starting with a digit: an agent calls this link’s tools as <code>&lt;name&gt;.&lt;tool&gt;</code> once that’s built.</p>
          <p class="hint" id="lu-hint">The upstream MCP server’s URL. Must be https.</p>
          ${editing
            ? ""
            : html`<p class="hint" id="lc-hint">An API key or token for the upstream server. Stored encrypted, the same way environment variable values are; never shown again once saved.</p>`}
          <div class="actions"><button class="primary"${!editing && !configured ? " disabled" : ""}>${editing ? "Save changes" : "Add link"}</button>${editing ? html`<a class="button quiet" href="${vaultPath(id, "/links")}">Cancel</a>` : ""}</div>
        </form>`
      : "";

    const table = list.length
      ? html`<div class="table-wrap"><table class="table-stack rules-table">
          <thead><tr><th scope="col">Name</th><th scope="col">URL</th><th scope="col">Added by</th>${owner ? html`<th scope="col"><span class="sr-only">Actions</span></th>` : ""}</tr></thead>
          <tbody>${list.map(
            (l) => html`<tr>
              <td data-label="Name"><code>${l.name}</code></td>
              <td data-label="URL" class="small">${l.url}</td>
              <td data-label="Added by" class="small muted">${who(ctx, l.created_by, null)} · ${time(l.created_at)}</td>
              ${owner
                ? html`<td class="num rule-actions">${menu({
                    label: `Actions for ${l.name}`,
                    icon: "more",
                    items: [
                      { href: `${vaultPath(id, "/links")}?edit=${q(l.id)}#add-link`, label: "Edit", description: "Name or URL" },
                      { href: vaultPath(id, `/links/${l.id}/grants`), label: "Grants", description: "Which tools each role may call" },
                      { href: `${vaultPath(id, "/links")}?delete=${q(l.id)}`, label: "Delete", description: "Asks you to confirm first", danger: true },
                    ],
                  })}</td>`
                : ""}
            </tr>`,
          )}</tbody></table></div>`
      : emptyState({
          title: "No links yet",
          body: owner
            ? "A link holds a shared credential to an upstream MCP server, like Linear or Stripe, so a member’s agent can use it without ever seeing the key."
            : "Only owners add links. Ask an owner of this vault.",
          ...(owner ? { action: html`<a class="button" href="#add-link">Add link</a>` } : {}),
        });

    const formFirst = !!(form?.error || editing);
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Links" }],
        title: "Links",
        description: "A vault’s credentials to upstream MCP servers, shared by everyone with access, seen by no one.",
        primary: owner && !formFirst ? html`<a class="button primary" href="#add-link">Add link</a>` : "",
      })}
      ${formFirst ? addForm : ""}
      ${table}
      ${formFirst ? "" : addForm}
      <p class="hint">An agent can already list a vault’s links over MCP, and adding one discovers its tools. An owner grants a tool per role from its Grants page; calling one isn’t built yet. <a href="/docs/concepts/links">How links work</a></p>`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "links" }, body) };
  });
  if (!data) return notFound(ctx);
  return { ...render(ctx, "Links", data.shell, "vaults"), ...(form?.error ? { status: 400 } : {}) };
}

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (Links form)", why }));

export async function saveLink(ctx: Ctx, id: string): Promise<Reply> {
  const linkId = (ctx.form.get("link_id") ?? "").trim() || undefined;
  const name = (ctx.form.get("name") ?? "").trim();
  const url = (ctx.form.get("url") ?? "").trim();
  const credential = ctx.form.get("credential") ?? "";
  const again = (error: string, field: LinkForm["field"]) => links(ctx, id, { id: linkId, name, url, error, field });

  if (!NAME.test(name)) {
    return again(refuse("A link’s name is letters, digits and underscores, not starting with a digit, up to 64 characters. Nothing was saved"), "name");
  }
  if (!URL_RE.test(url) || url.length > 2048) {
    return again(refuse("A link’s URL must start with https:// and be at most 2048 characters. Nothing was saved"), "url");
  }
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
    const text = message(err);
    if ((err as { code?: string }).code === "22023") return again(text, "name");
    ctx.setFlash(text);
  }
  return { redirect: vaultPath(id, "/links") };
}

// The confirm step before a link is deleted: an agent that could call its
// tools loses that ability at once (moot today: nothing calls a link's
// tools yet, but this page is written for when that changes, not just for
// today). Owners only; anyone else, or a link that doesn't exist, is sent
// back with a note.
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

export async function linkAction(ctx: Ctx, id: string): Promise<Reply> {
  return ctx.form.get("op") === "delete" ? deleteLink(ctx, id) : saveLink(ctx, id);
}

export async function linksRoutes(ctx: Ctx, id: string): Promise<Reply> {
  return ctx.method === "GET" ? links(ctx, id) : linkAction(ctx, id);
}
