// The Variables page (docs/variables.md, "Web: the Variables page"). Names,
// environments and who set what, for every member; set, rotate, delete and
// reveal for people whose role allows it; and the vault's access log. Every
// call goes through src/variables.ts as the signed-in person, and the
// database decides: this page only chooses what to offer.
//
// A value exists in plaintext here only in two places: the set form's POST
// body, handed straight to setVariable(), and the reveal response, which is a
// page rendered from one POST (never a redirect, never a GET, so never in a
// URL, history or referrer; every response is no-store). No flash, redirect,
// error page or log line carries one, and a refused set re-renders its form
// empty.

import { asPerson } from "./db.js";
import { csrfField, html, page, pageHeader, raw, when, type Raw } from "./html.js";
import { ago, message, notFound, UUID, vault, vaultPath, vaultShell, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { SecretsError, variablesConfigured } from "./secrets.js";
import {
  accessLog,
  deleteVariable,
  listVariables,
  revealVariable,
  setVariable,
  type AccessLogRow,
  type Environment,
  type Variable,
  type VariableValue,
} from "./variables.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV = /^[a-z][a-z0-9_-]{0,31}$/;
const ACTIONS = ["set", "rotate", "delete", "read", "reveal", "refused"] as const;
const ACTION_LABEL: Record<string, string> = {
  set: "Set",
  rotate: "Rotated",
  delete: "Deleted",
  read: "Read",
  reveal: "Revealed",
  refused: "Refused",
};
const LOG_PAGE = 50;
// How far back the "read since it was set" note looks.
const RECENT = 500;

const q = encodeURIComponent;
const base = (id: string, rest = "") => vaultPath(id, `/variables${rest}`);
const slotQuery = (name: string, environment: string) => `?name=${q(name)}&environment=${q(environment)}`;

// Who may do what with values, as the database decides it (docs/variables.md,
// "What holds"): owners everywhere, editors outside owners-only environments.
const writes = (role: string, e: Environment) => role === "owner" || (role === "editor" && !e.ownersOnly);
const readsLog = (role: string) => role === "owner" || role === "editor";

// The client a log row came from: the web UI (a person in person), the CLI,
// or an agent's token.
function client(r: AccessLogRow): string {
  if (!r.agent) return "web UI";
  if (r.agent === "Reliquary CLI") return "CLI";
  return r.agent;
}

// A page in the vault frame. `path` is where the theme switch comes back to,
// so a POST's response page (a reveal, a refused form) never sends it to a
// POST-only route.
async function shell(ctx: Ctx, v: Vault, title: string, body: Raw, status = 200, path?: string): Promise<Reply> {
  const framed = await asPerson(ctx.userId, (c) => vaultShell(c, ctx, v, { section: "variables" }, body));
  return {
    status,
    html: page(title, framed, {
      user: ctx.userId,
      flash: ctx.flash,
      theme: ctx.theme,
      csrf: ctx.csrf,
      path: path ?? ctx.url.pathname + ctx.url.search,
      nav: "vaults",
      reviewCount: ctx.reviewCount,
    }),
  };
}

const theVault = (ctx: Ctx, id: string) => asPerson(ctx.userId, (c) => vault(c, ctx, id));

const crumb = (v: Vault, here?: string) =>
  html`<p class="crumb"><a href="${vaultPath(v.id)}">${v.name}</a>${here
    ? html`<span aria-hidden="true"> / </span><a href="${base(v.id)}">Variables</a>`
    : ""}</p>`;

// ---------------------------------------------------------------------------
// The list

function readersSince(ctx: Ctx, recent: AccessLogRow[], name: string, value: VariableValue): { who: string[]; read: boolean } {
  const seen = new Set<string>();
  let read = false;
  for (const r of recent) {
    if (r.at <= value.updatedAt) break; // newest first: the rest are older
    if ((r.action !== "read" && r.action !== "reveal") || r.environment !== value.environment || !r.names.includes(name)) continue;
    read ||= r.action === "read";
    seen.add(`${r.action === "reveal" ? "revealed by" : "read by"} ${who(ctx, r.actor, null)}${r.action === "read" ? ` (${client(r)})` : ""}`);
  }
  return { who: [...seen], read };
}

// The environment's name as each cell carries it, for the stacked layout.
const label = (e: Environment) => (e.ownersOnly ? `${e.name} (owners)` : e.name);

function cell(ctx: Ctx, v: Vault, variable: Variable, e: Environment, recent: AccessLogRow[] | null, keyed: boolean): Raw {
  const value = variable.values.find((x) => x.environment === e.name);
  const may = writes(v.role, e);
  if (!value) {
    return html`<td data-label="${label(e)}"><div><span class="muted small">Not set</span>${
      may && keyed ? html`<span class="var-actions"><a class="button" href="${base(v.id, "/set")}${slotQuery(variable.name, e.name)}">Set a value</a></span>` : ""
    }</div></td>`;
  }
  const readers = recent ? readersSince(ctx, recent, variable.name, value) : { who: [], read: false };
  return html`<td data-label="${label(e)}"><div>
    <span class="var-set">Set</span> <span class="muted small">v${value.version} · ${who(ctx, value.updatedBy, null)}, <span title="${when(value.updatedAt)}">${ago(value.updatedAt)}</span></span>
    ${readers.who.length
      ? html`<span class="var-readers small">Since then: ${readers.who.join("; ")}.${
          readers.read ? html` <a href="/tokens">Revoke a sign-in</a>` : ""}</span>`
      : ""}
    ${may && keyed
      ? html`<span class="var-actions">
        <form method="post" action="${base(v.id, "/reveal")}">${csrfField(ctx.csrf)}<input type="hidden" name="name" value="${variable.name}"><input type="hidden" name="environment" value="${e.name}"><button>Reveal</button></form>
        <a class="button" href="${base(v.id, "/set")}${slotQuery(variable.name, e.name)}">Rotate</a>
        <a class="button danger" href="${base(v.id, "/delete")}${slotQuery(variable.name, e.name)}">Delete</a>
      </span>`
      : ""}
  </div></td>`;
}

async function list(ctx: Ctx, id: string): Promise<Reply> {
  const v = await theVault(ctx, id);
  if (!v) return notFound(ctx);
  const { environments, variables } = await listVariables(ctx.userId, id);
  const keyed = variablesConfigured();
  const recent = readsLog(v.role) && variables.length ? await accessLog(ctx.userId, id, { limit: RECENT }) : null;
  const canSet = keyed && environments.some((e) => writes(v.role, e));
  const ownersOnly = environments.filter((e) => e.ownersOnly).map((e) => e.name);

  const body = html`
    ${pageHeader({
      crumb: crumb(v),
      title: "Variables",
      actions: html`${readsLog(v.role) ? html`<a class="button" href="${base(id, "/log")}">Access log</a>` : ""}${
        canSet ? html`<a class="button primary" href="${base(id, "/set")}">Add a variable</a>` : ""
      }`,
    })}
    <p class="lede">Shared environment variables for this vault’s projects: API keys, database URLs, other secrets. This page shows names and who set them, never values.</p>
    ${keyed ? "" : html`<p class="callout attention">This server has no encryption key, so values can’t be set or revealed here. Names are listed as usual.</p>`}
    ${v.role === "viewer"
      ? html`<p class="muted small">As a viewer you see names only. Owners and editors set and use values.</p>`
      : v.role === "editor" && ownersOnly.length
        ? html`<p class="muted small">Only owners set, rotate, delete or reveal values in ${ownersOnly.join(", ")}.</p>`
        : ""}
    ${variables.length
      ? html`<div class="vars-wrap"><table class="vars">
        <thead><tr><th>Name</th>${environments.map((e) => html`<th>${e.name}${e.ownersOnly ? html` <span class="muted">(owners)</span>` : ""}</th>`)}</tr></thead>
        <tbody>${variables.map(
          (x) => html`<tr><th scope="row"><code>${x.name}</code></th>${environments.map((e) => cell(ctx, v, x, e, recent, keyed))}</tr>`,
        )}</tbody></table></div>`
      : html`<div class="empty"><strong>No variables yet.</strong>
        <p>Keep your projects’ secrets here instead of in <code>.env</code> files passed around by hand. Each value is encrypted, and every set, read and reveal is logged.</p>
        ${canSet ? html`<p><a class="button" href="${base(id, "/set")}">Add a variable</a></p>` : ""}</div>`}
    <h2>Use them</h2>
    <p>Run a command with this vault’s variables, without writing them to disk:</p>
    <pre class="code">npx @reliquary-ai/cli run --env development -- &lt;command&gt;</pre>
    <p class="small muted">The first time, <code>npx @reliquary-ai/cli login</code> signs this computer in. <code>env pull</code> writes a <code>.env</code> instead, only where git ignores it. Setup is on the <a href="/connect#cli">Connect</a> page.</p>
    <ul class="plain small muted var-caveats">
      <li><strong>Agents can read what reaches them.</strong> An agent that runs commands where a value was delivered can read it. <code>run</code> limits a value to one process; prefer short-lived, narrowly scoped keys.</li>
      <li><strong>The hosted operator can decrypt.</strong> Values are encrypted with a key the database never sees, but whoever runs this server holds both.</li>
    </ul>`;
  return shell(ctx, v, "Variables", body);
}

// ---------------------------------------------------------------------------
// Set or rotate

type SetForm = { name?: string; environment?: string; error?: string };

async function setForm(ctx: Ctx, v: Vault, f: SetForm, status = 200): Promise<Reply> {
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  const allowed = environments.filter((e) => writes(v.role, e));
  const exists = !!f.name && !!f.environment && variables.some((x) => x.name === f.name && x.values.some((y) => y.environment === f.environment));
  const title = exists ? `Rotate ${f.name}` : "Add a variable";
  const keyed = variablesConfigured();
  const lockedEnv = exists && !allowed.some((e) => e.name === f.environment);
  if (!allowed.length || !keyed || lockedEnv) {
    const why = !keyed
      ? "This server has no encryption key, so values can’t be set here."
      : lockedEnv
        ? `Only owners set values in ${f.environment}.`
        : "Your role in this vault can’t set variables. Ask an owner.";
    return shell(ctx, v, title, html`${pageHeader({ crumb: crumb(v, "set"), title })}<p class="callout attention">${why}</p>`, 403);
  }
  const envChoice = exists
    ? html`<input type="hidden" name="environment" value="${f.environment}"><p class="small"><span class="muted">Environment</span> <strong>${f.environment}</strong></p>`
    : html`<label for="ve">Environment</label>
      <select id="ve" name="environment">${allowed.map(
        (e) => html`<option value="${e.name}"${e.name === f.environment ? raw(" selected") : ""}>${e.name}</option>`,
      )}</select>
      ${allowed.length < environments.length ? html`<p class="hint">Only owners set values in ${environments.filter((e) => !writes(v.role, e)).map((e) => e.name).join(", ")}.</p>` : ""}`;
  const body = html`
    ${pageHeader({
      crumb: crumb(v, "set"),
      title,
      path: exists,
      actions: html`<a class="button quiet" href="${base(v.id)}">Cancel</a>
        <button class="primary" form="set-variable">${exists ? "Save new value" : "Save variable"}</button>`,
    })}
    ${f.error ? html`<p class="callout danger" role="alert">${f.error}</p>` : ""}
    <p class="lede">${exists
      ? html`The new value replaces the old one in <strong>${f.environment}</strong>. Anyone who already read the old value still has it: rotate it at its provider too.`
      : "Programs run with the CLI get it as an environment variable. The value is encrypted before it’s stored, and isn’t shown here again unless an owner or editor reveals it."}</p>
    <form method="post" action="${base(v.id, "/set")}" class="panel" id="set-variable" autocomplete="off">
      ${csrfField(ctx.csrf)}
      ${exists
        ? html`<input type="hidden" name="name" value="${f.name}"><p class="small"><span class="muted">Name</span> <code>${f.name}</code></p>`
        : html`<label for="vn">Name</label>
          <input id="vn" type="text" name="name" value="${f.name ?? ""}" placeholder="STRIPE_SECRET_KEY" required maxlength="128"
            pattern="[A-Za-z_][A-Za-z0-9_]*" autocomplete="off" autocapitalize="off" spellcheck="false">
          <p class="hint">Letters, digits and underscores, not starting with a digit. Names that change how programs start, like <code>PATH</code> or <code>NODE_OPTIONS</code>, are refused.</p>`}
      ${envChoice}
      <label for="vv">Value</label>
      <textarea id="vv" name="value" class="short secret-input" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <p class="hint">Up to 64 KiB of text. It isn’t shown back after you save.</p>
      <div class="actions"><button class="primary">${exists ? "Save new value" : "Save variable"}</button>
        <a class="button quiet" href="${base(v.id)}">Cancel</a></div>
    </form>`;
  return shell(ctx, v, title, body, status, base(v.id));
}

async function saveVariable(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  const environment = ctx.form.get("environment") ?? "";
  const value = ctx.form.get("value") ?? "";
  // The form again, with name and environment kept and the value dropped.
  const again = (error: string, status = 400) => setForm(ctx, v, { name, environment, error }, status);
  if (!ENV.test(environment)) return again("Choose an environment.");
  if (!value) return again("Enter a value.");
  try {
    const action = await setVariable(ctx.userId, v.id, name, environment, value);
    ctx.setFlash(action === "rotate" ? `Rotated ${name} in ${environment}.` : `Set ${name} in ${environment}.`);
    return { redirect: base(v.id) };
  } catch (err) {
    if (err instanceof SecretsError) {
      return again(variablesConfigured() ? "A value is at most 64 KiB." : "This server has no encryption key, so values can’t be set here.");
    }
    const code = (err as { code?: string }).code;
    return again(message(err), code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
}

// ---------------------------------------------------------------------------
// Delete, with a confirm step

async function confirmDelete(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.url.searchParams.get("name") ?? "";
  const environment = ctx.url.searchParams.get("environment") ?? "";
  if (!NAME.test(name) || !ENV.test(environment)) return notFound(ctx);
  const { variables } = await listVariables(ctx.userId, v.id);
  if (!variables.some((x) => x.name === name && x.values.some((y) => y.environment === environment))) return notFound(ctx);
  const title = `Delete ${name}`;
  const body = html`
    ${pageHeader({ crumb: crumb(v, "delete"), title, path: true })}
    <p class="lede">Delete the value of <code>${name}</code> in <strong>${environment}</strong>? Programs run with the CLI won’t get it any more. This can’t be undone; the access log keeps the record.</p>
    <form method="post" action="${base(v.id, "/delete")}" class="danger-zone">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="name" value="${name}"><input type="hidden" name="environment" value="${environment}">
      <p class="muted small">Other environments keep their values.</p>
      <span class="actions"><a class="button quiet" href="${base(v.id)}">Cancel</a><button class="danger">Delete this value</button></span>
    </form>`;
  return shell(ctx, v, title, body);
}

async function remove(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const environment = ctx.form.get("environment") ?? "";
  try {
    await deleteVariable(ctx.userId, v.id, name, environment);
    ctx.setFlash(`Deleted ${name} from ${environment}.`);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: base(v.id) };
}

// ---------------------------------------------------------------------------
// Reveal: one value, in this response only

async function reveal(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const environment = ctx.form.get("environment") ?? "";
  const back = base(v.id);
  const fail = (status: number, text: Raw | string) =>
    shell(ctx, v, `Reveal ${name}`, html`${pageHeader({ crumb: crumb(v, "reveal"), title: `Reveal ${name}`, path: true })}
      <p class="callout danger" role="alert">${text}</p><p><a href="${back}">Back to variables</a></p>`, status, back);
  if (!NAME.test(name) || !ENV.test(environment)) return fail(404, "There’s no such variable.");
  // Without the key nothing could be opened: don't let the database log a
  // reveal that shows nothing.
  if (!variablesConfigured()) return fail(503, "This server has no encryption key, so values can’t be revealed here.");
  const r = await revealVariable(ctx.userId, v.id, name, environment);
  if (!r.ok) {
    switch (r.error) {
      case "forbidden":
        return fail(403, `Your role can’t reveal values in ${environment}. The attempt is in the access log.`);
      case "decrypt_failed":
        return fail(500, html`<code>${name}</code> in ${environment} can’t be decrypted. Set it again to replace it.`);
      case "unauthorized":
        return fail(401, "Your session ended. Sign in and try again.");
      default:
        return fail(404, html`<code>${name}</code> has no value in ${environment}.`);
    }
  }
  const title = `${name} in ${environment}`;
  const body = html`
    ${pageHeader({
      crumb: crumb(v, "reveal"),
      title,
      path: true,
      meta: html`<p class="meta"><span>Set by ${who(ctx, r.updatedBy, null)}, ${ago(new Date(r.updatedAt))}</span></p>`,
      actions: html`<a class="button" href="${back}">Done</a>`,
    })}
    <div class="callout attention reveal" role="status">
      <strong>This reveal is logged.</strong>
      <p>Owners and editors of ${v.name} see in the access log that you revealed it. It’s shown on this page only: nothing is saved in your browser, and it won’t be shown again when you leave.</p>
      <pre class="secret">${r.value}</pre>
    </div>
    <p class="small muted">Don’t paste it into a chat with an agent: a value typed to an agent has reached a model. To use it in a program, run it with the CLI.</p>`;
  return shell(ctx, v, title, body, 200, back);
}

// ---------------------------------------------------------------------------
// Access log

function logFilters(ctx: Ctx, id: string, action: string, name: string): Raw {
  const sel = (on: boolean) => (on ? raw(" selected") : "");
  return html`<form method="get" action="${base(id, "/log")}" class="panel filters" role="search" aria-label="Filter the access log">
    <div class="filter-fields">
      <div><label for="f-action">Action</label><select id="f-action" name="action"><option value="">Any action</option>
        ${ACTIONS.map((a) => html`<option value="${a}"${sel(action === a)}>${ACTION_LABEL[a]}</option>`)}</select></div>
      <div><label for="f-name">Variable</label><input id="f-name" type="text" name="name" value="${name}" placeholder="API_KEY" autocapitalize="off" spellcheck="false"></div>
    </div>
    <div class="actions"><button>Filter</button>${action || name ? html`<a class="button quiet" href="${base(id, "/log")}">Clear filters</a>` : ""}</div>
  </form>`;
}

function detail(r: AccessLogRow): string {
  if (r.action !== "refused") return "";
  const d = r.detail as { attempt?: string; reason?: string };
  return `${d.attempt ? `${d.attempt}: ` : ""}${d.reason ?? ""}`;
}

async function log(ctx: Ctx, id: string): Promise<Reply> {
  const v = await theVault(ctx, id);
  if (!v) return notFound(ctx);
  const p = ctx.url.searchParams;
  const action = (ACTIONS as readonly string[]).includes(p.get("action") ?? "") ? p.get("action")! : "";
  const name = NAME.test(p.get("name") ?? "") ? p.get("name")! : "";
  const before = /^\d{1,18}$/.test(p.get("before") ?? "") ? p.get("before")! : undefined;
  const link = (extra: Record<string, string>) => {
    const s = new URLSearchParams({ ...(action ? { action } : {}), ...(name ? { name } : {}), ...extra }).toString();
    return s ? `${base(id, "/log")}?${s}` : base(id, "/log");
  };
  let table: Raw;
  if (!readsLog(v.role)) {
    table = html`<div class="empty">Only owners and editors can see this vault’s access log.</div>`;
  } else {
    const rows = await accessLog(ctx.userId, id, { before, limit: LOG_PAGE + 1, action, name });
    const more = rows.length > LOG_PAGE;
    const shown = rows.slice(0, LOG_PAGE);
    table = html`${logFilters(ctx, id, action, name)}
      ${shown.length
        ? html`<div class="vars-wrap"><table class="vars env-log">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Variables</th></tr></thead>
          <tbody>${shown.map(
            (r) => html`<tr${r.action === "refused" ? raw(' class="refused"') : ""}><td class="small" data-label="When"><div>${when(r.at)}</div></td>
              <td class="small" data-label="Who"><div>${who(ctx, r.actor, null)}<span class="muted token-client">from ${client(r)}</span></div></td>
              <td class="small" data-label="What"><div>${r.action === "refused" ? html`<span class="badge danger">Refused</span> <span class="muted">${detail(r)}</span>` : ACTION_LABEL[r.action] ?? r.action}</div></td>
              <td class="small path-cell" data-label="Variables"><div>${r.names.length ? r.names.map((n, i) => html`${i ? ", " : ""}<code>${n}</code>`) : html`<span class="muted">none</span>`}${
                r.environment ? html` <span class="muted">in ${r.environment}</span>` : ""}</div></td></tr>`,
          )}</tbody></table></div>`
        : html`<div class="empty">${before ? "No older entries." : action || name ? "Nothing matches these filters." : "Nothing has been set, read or revealed yet."}</div>`}
      ${more || before
        ? html`<nav class="pager" aria-label="Pages">${before ? html`<a href="${link({})}">Newest</a>` : ""}${
            more ? html`<a class="older" href="${link({ before: shown[shown.length - 1].seq })}">Older</a>` : ""
          }</nav>`
        : ""}`;
  }
  const body = html`
    ${pageHeader({ crumb: crumb(v, "log"), title: "Access log", actions: html`<a class="button" href="${base(id)}">Variables</a>` })}
    <p class="lede">Who set, rotated, deleted, read or revealed which variables, newest first, and refused attempts with the reason. Nothing here holds a value, and nothing in it is ever edited or deleted.</p>
    ${table}`;
  return shell(ctx, v, "Access log", body);
}

// ---------------------------------------------------------------------------

export async function variablesRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  if (!UUID.test(id)) return notFound(ctx);
  const get = ctx.method === "GET";
  if (get && rest === "/variables") return list(ctx, id);
  if (get && rest === "/variables/log") return log(ctx, id);
  const v = await theVault(ctx, id);
  if (!v) return notFound(ctx);
  if (get && rest === "/variables/set") {
    const name = ctx.url.searchParams.get("name") ?? "";
    const environment = ctx.url.searchParams.get("environment") ?? "";
    return setForm(ctx, v, { name: NAME.test(name) ? name : undefined, environment: ENV.test(environment) ? environment : undefined });
  }
  if (!get && rest === "/variables/set") return saveVariable(ctx, v);
  if (get && rest === "/variables/delete") return confirmDelete(ctx, v);
  if (!get && rest === "/variables/delete") return remove(ctx, v);
  if (!get && rest === "/variables/reveal") return reveal(ctx, v);
  return notFound(ctx);
}
