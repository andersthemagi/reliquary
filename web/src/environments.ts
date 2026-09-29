// The Environments tab of the Variables page (docs/variables.md, "Web: the
// Variables page"): owners add, rename and delete a vault's environments.
// The database decides (public.create_environment and friends); this file
// only offers what an owner may do and shows the database's refusal
// otherwise. Split out of variablespage.ts, which keeps the shared page
// chrome (tabs, breadcrumbs, the vault frame).

import { callout, confirmPage, csrfField, html, menu, pageHeader, raw, type MenuItem } from "./html.js";
import { message, notFound, type Ctx, type Reply, type Vault } from "./pages.js";
import { SecretsError, variablesConfigured } from "./secrets.js";
import { createEnvironment, deleteEnvironment, listVariables, renameEnvironment } from "./variables.js";
import { base, crumbs, ENV, OWNERS_ONLY_HELP, plural, q, refusal, sectionHeader, shell, waitingIn } from "./variablespage.js";

const DEFAULT_ENVIRONMENTS = ["development", "preview", "production"];

const envBase = (vaultId: string, rest = "") => base(vaultId, `/environments${rest}`);

async function ownersOnlyPage(ctx: Ctx, v: Vault, title: string): Promise<Reply> {
  return shell(ctx, v, title, html`${pageHeader({ crumb: crumbs(v, { label: title }), title })}
    ${callout("warning", "Only owners manage a vault’s environments.")}`, 403);
}

export async function environmentsPage(ctx: Ctx, v: Vault, f: { name?: string; ownersOnly?: boolean; error?: string } = {}, status = 200): Promise<Reply> {
  const title = "Environments";
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  const pushes = await waitingIn(ctx, v);
  const count = (e: string) => variables.filter((x) => x.values.some((y) => y.environment === e)).length;
  const body = html`
    ${sectionHeader(v, "environments", pushes.length, {
      description: html`Each environment holds its own value of every variable; programs get one environment’s values with <code>reliquary run --env &lt;name&gt;</code>.`,
      primary: html`<a class="button primary" href="#add-environment">Add environment</a>`,
    })}
    ${f.error ? refusal(f.error) : ""}
    <div class="table-wrap"><table class="table-stack var-envtable">
      <thead><tr><th scope="col">Environment</th><th scope="col">Values</th><th scope="col">Who can set</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${environments.map((e) => {
        const n = count(e.name);
        const isDefault = DEFAULT_ENVIRONMENTS.includes(e.name);
        const items: MenuItem[] = [
          ...(isDefault ? [] : [{ href: `${envBase(v.id, "/rename")}?name=${q(e.name)}`, label: "Rename", description: "Its values move with it" }]),
          ...(!isDefault || n === 0
            ? [{ href: `${envBase(v.id, "/delete")}?name=${q(e.name)}`, label: "Delete", description: n ? "Destroys its values" : "It holds no values", danger: true }]
            : []),
        ];
        return html`<tr>
          <th scope="row" data-label="Environment"><strong>${e.name}</strong>${isDefault ? html` <span class="badge">Default</span>` : ""}</th>
          <td data-label="Values">${plural(n, "value")}</td>
          <td data-label="Who can set">${e.ownersOnly ? html`<span class="badge var-owners" title="${OWNERS_ONLY_HELP}">Owners only</span>` : "Owners and editors"}</td>
          <td data-label="" class="var-row-end">${items.length ? menu({ label: `Actions for ${e.name}`, icon: "more", items, className: "var-menu" }) : ""}</td>
        </tr>`;
      })}</tbody></table></div>
    <p class="small muted">The defaults keep their names, and are deleted only when they hold no value. A vault has at most 20 environments.</p>
    <h2 id="add-environment">Add an environment</h2>
    <form method="post" action="${envBase(v.id)}" class="panel choice-form" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <label for="en">Name</label>
      <input id="en" type="text" name="name" value="${f.name ?? ""}" placeholder="staging" required maxlength="32"
        autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="hint">Lowercase letters, digits, <code>-</code> and <code>_</code>, starting with a letter.</p>
      <label class="choice"><input type="checkbox" name="owners_only" value="1"${f.ownersOnly ? raw(" checked") : ""}> Owners only (like production)</label>
      <div class="actions"><button class="primary">Add environment</button></div>
    </form>`;
  return shell(ctx, v, "Environments · Variables", body, status, envBase(v.id));
}

export async function createEnvironmentPost(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  const ownersOnly = ctx.form.get("owners_only") === "1";
  try {
    await createEnvironment(ctx.userId, v.id, name, ownersOnly);
    ctx.setFlash(`Added ${name}${ownersOnly ? " (owners only)" : ""}.`, "success");
    return { redirect: envBase(v.id) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return environmentsPage(ctx, v, { name: ENV.test(name) ? name : "", ownersOnly, error: message(err) }, code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
}

export async function renamePage(ctx: Ctx, v: Vault, from: string, f: { to?: string; error?: string } = {}, status = 200): Promise<Reply> {
  const title = `Rename ${from}`;
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  if (!environments.some((e) => e.name === from)) return notFound(ctx);
  const n = variables.filter((x) => x.values.some((y) => y.environment === from)).length;
  const body = html`
    ${pageHeader({
      crumb: crumbs(v, { label: "Environments", href: envBase(v.id) }, { label: title }),
      title,
      path: true,
      secondary: html`<a class="button quiet" href="${envBase(v.id)}">Cancel</a>`,
      primary: html`<button class="primary" form="rename-environment">Rename</button>`,
    })}
    ${f.error ? refusal(f.error) : ""}
    <p class="lede">${n ? `Its ${plural(n, "value")} ${n === 1 ? "moves" : "move"} with it.` : "It holds no values."} Scripts and <code>.reliquary.json</code> files that name <strong>${from}</strong> need the new name, and imports from the CLI waiting to be applied to ${from} are rejected: send them again.</p>
    <form method="post" action="${envBase(v.id, "/rename")}" class="panel" id="rename-environment" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="from" value="${from}">
      <label for="et">New name</label>
      <input id="et" type="text" name="to" value="${f.to ?? ""}" required maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="actions"><button class="primary">Rename</button><a class="button quiet" href="${envBase(v.id)}">Cancel</a></div>
    </form>`;
  return shell(ctx, v, title, body, status, envBase(v.id));
}

export async function renamePost(ctx: Ctx, v: Vault): Promise<Reply> {
  const from = ctx.form.get("from") ?? "";
  const to = (ctx.form.get("to") ?? "").trim();
  if (!ENV.test(from)) return notFound(ctx);
  try {
    const r = await renameEnvironment(ctx.userId, v.id, from, to);
    ctx.setFlash(`Renamed ${from} to ${to}${r.moved ? ` with its ${plural(r.moved, "value")}` : ""}.${r.rejectedImports ? ` ${plural(r.rejectedImports, "waiting import was", "waiting imports were")} rejected.` : ""}`, "success");
    return { redirect: envBase(v.id) };
  } catch (err) {
    if (err instanceof SecretsError) {
      return renamePage(ctx, v, from, { to, error: variablesConfigured()
        ? "A value in it can’t be decrypted, so nothing was renamed. Set that value again, then rename."
        : "This server has no encryption key, and renaming seals each value again for the new name. Nothing was renamed." }, 409);
    }
    const code = (err as { code?: string }).code;
    return renamePage(ctx, v, from, { to: ENV.test(to) ? to : "", error: message(err) }, code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
}

export async function deleteEnvPage(ctx: Ctx, v: Vault, name: string, error?: string, status = 200): Promise<Reply> {
  const title = `Delete ${name}`;
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  if (!environments.some((e) => e.name === name)) return notFound(ctx);
  const names = variables.filter((x) => x.values.some((y) => y.environment === name)).map((x) => x.name);
  const body = html`<div class="var-confirm">${confirmPage({
    title,
    crumb: crumbs(v, { label: "Environments", href: envBase(v.id) }, { label: title }),
    lede: names.length
      ? html`This destroys the ${plural(names.length, "value")} in <strong>${name}</strong> (${names.map((n, i) => html`${i ? ", " : ""}<code>${n}</code>`)}). They can’t be recovered; other environments keep theirs.`
      : html`<strong>${name}</strong> holds no values.`,
    consequences: [
      ...(names.length ? [html`Programs run with <code>--env ${name}</code> stop getting them.`] : []),
      "Imports from the CLI waiting to be applied to it are rejected.",
      "The access log keeps the record.",
    ],
    action: envBase(v.id, "/delete"),
    csrf: ctx.csrf,
    fields: { name },
    typed: { value: name },
    button: `Delete ${name}${names.length ? " and its values" : ""}`,
    cancel: envBase(v.id),
    error,
  })}</div>`;
  return shell(ctx, v, title, body, status, envBase(v.id));
}

export async function deleteEnvPost(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const typed = (ctx.form.get("confirm_name") ?? "").trim();
  if (!ENV.test(name)) return notFound(ctx);
  try {
    const r = await deleteEnvironment(ctx.userId, v.id, name, typed);
    ctx.setFlash(`Deleted ${name}${r.deleted ? ` and its ${plural(r.deleted, "value")}` : ""}.`, "success");
    return { redirect: envBase(v.id) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "22023") return deleteEnvPage(ctx, v, name, "That isn’t the environment’s name. Nothing was deleted.", 400);
    return deleteEnvPage(ctx, v, name, message(err), code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
}
