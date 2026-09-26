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
import { failure } from "./failure.js";
import { dotenvTooBig, parseDotenv, DOTENV_MAX_ENTRIES } from "./dotenv.js";
import {
  accessLog,
  applyImport,
  createEnvironment,
  createImport,
  deleteEnvironment,
  deleteVariable,
  renameEnvironment,
  getImport,
  listVariables,
  pendingPushes,
  readersSinceSet,
  rejectImport,
  revealVariable,
  setVariable,
  type AccessLogRow,
  type ReaderRow,
  type EnvImport,
  type Environment,
  type Variable,
  type VariableValue,
} from "./variables.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV = /^[a-z][a-z0-9_-]{0,31}$/;
const ACTIONS = [
  "set", "rotate", "delete", "read", "reveal", "refused", "push", "reject",
  "rotate_key", "create_environment", "rename_environment", "delete_environment",
] as const;
const ACTION_LABEL: Record<string, string> = {
  set: "Set",
  rotate: "Rotated",
  delete: "Deleted",
  read: "Read",
  reveal: "Revealed",
  refused: "Refused",
  push: "Sent for approval",
  reject: "Rejected",
  rotate_key: "Re-encrypted (key rotation)",
  create_environment: "Environment added",
  rename_environment: "Environment renamed",
  delete_environment: "Environment deleted",
};
const DEFAULT_ENVIRONMENTS = ["development", "preview", "production"];
const LOG_PAGE = 50;

const q = encodeURIComponent;
const base = (id: string, rest = "") => vaultPath(id, `/variables${rest}`);
const slotQuery = (name: string, environment: string) => `?name=${q(name)}&environment=${q(environment)}`;

// Who may do what with values, as the database decides it (docs/variables.md,
// "What holds"): owners everywhere, editors outside owners-only environments.
const writes = (role: string, e: Environment) => role === "owner" || (role === "editor" && !e.ownersOnly);
const readsLog = (role: string) => role === "owner" || role === "editor";

// The client a log row came from: the web UI (a person in person), the CLI,
// or an agent's token.
function client(r: { agent: string | null }): string {
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
      shell: ctx.shell,
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

// Who read or revealed each value since it was set, as the cells show it
// ("read by you (CLI)", "revealed by 1a2b3c4d"), newest first, once each,
// keyed by name and environment.
type Readers = Map<string, { who: string[]; read: boolean }>;
const slot = (name: string, environment: string) => `${name}\u0000${environment}`;
function readersOf(ctx: Ctx, rows: ReaderRow[]): Readers {
  const out: Readers = new Map();
  for (const r of rows) {
    const key = slot(r.name, r.environment);
    const seen = out.get(key) ?? { who: [], read: false };
    out.set(key, seen);
    seen.read ||= r.action === "read";
    const text = `${r.action === "reveal" ? "revealed by" : "read by"} ${who(ctx, r.actor, null)}${r.action === "read" ? ` (${client(r)})` : ""}`;
    if (!seen.who.includes(text)) seen.who.push(text);
  }
  return out;
}

// The environment's name as each cell carries it, for the stacked layout.
const label = (e: Environment) => (e.ownersOnly ? `${e.name} (owners)` : e.name);

function cell(ctx: Ctx, v: Vault, variable: Variable, e: Environment, readersByCell: Readers | null, keyed: boolean): Raw {
  const value = variable.values.find((x) => x.environment === e.name);
  const may = writes(v.role, e);
  if (!value) {
    return html`<td data-label="${label(e)}"><div><span class="muted small">Not set</span>${
      may && keyed ? html`<span class="var-actions"><a class="button" href="${base(v.id, "/set")}${slotQuery(variable.name, e.name)}">Set a value</a></span>` : ""
    }</div></td>`;
  }
  const readers = readersByCell?.get(slot(variable.name, e.name)) ?? { who: [], read: false };
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
  const readers = readsLog(v.role) && variables.length ? readersOf(ctx, await readersSinceSet(ctx.userId, id)) : null;
  const canSet = keyed && environments.some((e) => writes(v.role, e));
  const ownersOnly = environments.filter((e) => e.ownersOnly).map((e) => e.name);
  const pushes = readsLog(v.role) ? await pendingPushes(ctx.userId, id) : [];

  const body = html`
    ${pageHeader({
      crumb: crumb(v),
      title: "Variables",
      actions: html`${v.role === "owner" ? html`<a class="button" href="${base(id, "/environments")}">Environments</a>` : ""}${
        canSet ? html`<a class="button" href="${base(id, "/import")}">Import .env</a>` : ""}${
        readsLog(v.role) ? html`<a class="button" href="${base(id, "/log")}">Access log</a>` : ""}${
        canSet ? html`<a class="button primary" href="${base(id, "/set")}">Add a variable</a>` : ""
      }`,
    })}
    <p class="lede">Shared environment variables for this vault’s projects: API keys, database URLs, other secrets. This page shows names and who set them, never values.</p>
    ${keyed ? "" : html`<p class="callout attention">This server has no encryption key, so values can’t be set or revealed here. Names are listed as usual.</p>`}
    ${pushes.length ? pendingList(ctx, pushes, false) : ""}
    ${v.role === "viewer"
      ? html`<p class="muted small">As a viewer you see names only. Owners and editors set and use values.</p>`
      : v.role === "editor" && ownersOnly.length
        ? html`<p class="muted small">Only owners set, rotate, delete or reveal values in ${ownersOnly.join(", ")}.</p>`
        : ""}
    ${variables.length
      ? html`<div class="vars-wrap"><table class="vars">
        <thead><tr><th>Name</th>${environments.map((e) => html`<th>${e.name}${e.ownersOnly ? html` <span class="muted">(owners)</span>` : ""}</th>`)}</tr></thead>
        <tbody>${variables.map(
          (x) => html`<tr><th scope="row"><code>${x.name}</code></th>${environments.map((e) => cell(ctx, v, x, e, readers, keyed))}</tr>`,
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
      return again(
        !variablesConfigured()
          ? "This server has no encryption key, so values can’t be set here."
          : value.includes("\u0000")
            ? "A value can’t contain a NUL character."
            : "A value is at most 64 KiB.",
      );
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
// Imports: paste a .env (a draft), or review a push from the CLI. Values are
// in plaintext here only in the paste form's POST body, handed straight to
// createImport() (sealed, stored as a draft). No page shows one: the
// preview names what will be set or replaced, and the confirm step sends
// only the import's id, so a value never goes back to the browser.

const importPath = (vaultId: string, importId: string, rest = "") => base(vaultId, `/imports/${importId}${rest}`);

// Minutes or hours from now, for "expires in".
function inTime(d: Date): string {
  const s = Math.max(0, (d.getTime() - Date.now()) / 1000);
  if (s < 90) return "a minute";
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Pending pushes, on the Variables page (one vault) and in Review (all).
export function pendingList(ctx: Ctx, pushes: (EnvImport & { vaultName: string; mayApply: boolean })[], showVault: boolean): Raw {
  return html`<section class="callout attention pending-imports" aria-label="Pushes waiting for approval">
    <strong>${pushes.length === 1 ? "A push is" : `${pushes.length} pushes are`} waiting for approval</strong>
    <p class="small">Sent with <code>reliquary env push</code>. Nothing is set until a person applies it here.</p>
    <ul class="rows">${pushes.map(
      (p) => html`<li><span><a class="name" href="${importPath(p.vaultId, p.id)}">${plural(p.names.length, "variable")} for ${p.environments.join(", ")}</a>
        <span class="muted small"> · ${showVault ? `${p.vaultName} · ` : ""}from ${who(ctx, p.createdBy, null)} via the CLI · ${ago(p.createdAt)} · expires in ${inTime(p.expiresAt)}</span></span>
        <span class="row-end small">${p.mayApply ? html`<a class="button" href="${importPath(p.vaultId, p.id)}">Review</a>` : html`<span class="muted">Owners apply it</span>`}</span></li>`,
    )}</ul>
  </section>`;
}

type ImportForm = { environments?: string[]; error?: Raw | string; refused?: { line: number; name: string | null; reason: string }[] };

function refusedList(refused: { line: number; name: string | null; reason: string }[]): Raw {
  return html`<ul class="plain small import-refused">${refused.map(
    (r) => html`<li>Line ${r.line}${r.name ? html`, <code>${r.name}</code>` : ""}: ${r.reason}</li>`,
  )}</ul>`;
}

async function importForm(ctx: Ctx, v: Vault, f: ImportForm, status = 200): Promise<Reply> {
  const { environments } = await listVariables(ctx.userId, v.id);
  const allowed = environments.filter((e) => writes(v.role, e));
  const title = "Import a .env";
  if (!allowed.length || !variablesConfigured()) {
    const why = variablesConfigured() ? "Your role in this vault can’t set variables. Ask an owner." : "This server has no encryption key, so values can’t be set here.";
    return shell(ctx, v, title, html`${pageHeader({ crumb: crumb(v, "import"), title })}<p class="callout attention">${why}</p>`, 403);
  }
  const chosen = f.environments?.length ? f.environments : ["development"];
  const body = html`
    ${pageHeader({
      crumb: crumb(v, "import"),
      title,
      actions: html`<a class="button quiet" href="${base(v.id)}">Cancel</a>`,
    })}
    ${f.error ? html`<p class="callout danger" role="alert">${f.error}</p>` : ""}
    ${f.refused?.length ? html`<div class="callout attention"><p><strong>Not taken:</strong></p>${refusedList(f.refused)}</div>` : ""}
    <p class="lede">Paste a <code>.env</code> file. Each <code>NAME=value</code> line becomes a variable in the environments you tick. Next you see which names are new and which replace a value, without the values, and nothing is saved until you apply it.</p>
    <form method="post" action="${base(v.id, "/import")}" class="panel choice-form" id="import-env" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <label for="ie">Contents of the .env</label>
      <textarea id="ie" name="dotenv" class="secret-input" rows="12" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="STRIPE_SECRET_KEY=sk_test_...&#10;DATABASE_URL=&quot;postgres://...&quot;"></textarea>
      <p class="hint">Comments, blank lines, <code>export</code>, single and double quotes (with <code>\\n</code> escapes in double quotes) and multi-line quoted values are understood; <code>\${VAR}</code> isn’t expanded. Up to ${DOTENV_MAX_ENTRIES} variables. Names like <code>PATH</code> or <code>NODE_OPTIONS</code> are refused.</p>
      <fieldset>
        <legend>Environments</legend>
        ${allowed.map(
          (e) => html`<label class="choice"><input type="checkbox" name="environment" value="${e.name}"${chosen.includes(e.name) ? raw(" checked") : ""}> ${e.name}</label>`,
        )}
        ${allowed.length < environments.length ? html`<p class="hint">Only owners set values in ${environments.filter((e) => !writes(v.role, e)).map((e) => e.name).join(", ")}.</p>` : ""}
      </fieldset>
      <div class="actions"><button class="primary">Review the import</button>
        <a class="button quiet" href="${base(v.id)}">Cancel</a></div>
    </form>
    <p class="small muted">From a terminal, or an agent: <code>npx @reliquary-ai/cli env push --env development</code> sends a <code>.env</code> file for you to approve here. It never sets a value by itself.</p>`;
  return shell(ctx, v, title, body, status, base(v.id));
}

async function importPost(ctx: Ctx, v: Vault): Promise<Reply> {
  const environments = [...new Set(ctx.form.getAll("environment"))].filter((e) => ENV.test(e));
  const text = ctx.form.get("dotenv") ?? "";
  // The form again: the environments kept, the pasted text never sent back.
  const again = (error: Raw | string, status = 400, refused?: ImportForm["refused"]) => importForm(ctx, v, { environments, error, refused }, status);
  if (!environments.length) return again("Tick at least one environment.");
  if (!text.trim()) return again("Paste the contents of a .env file.");
  const big = dotenvTooBig(text);
  if (big) return again(`That can’t be imported: ${big}.`, 413);
  const { entries, refused } = parseDotenv(text);
  if (!entries.length) return again("Nothing in it could be imported.", 400, refused);
  try {
    const r = await createImport(ctx.userId, v.id, environments, entries, refused);
    if (r.ok) return { redirect: importPath(v.id, r.id) };
    const why: Record<string, string> = {
      forbidden: "Your role can’t set values in every environment you ticked.",
      not_found: "There’s no such environment in this vault.",
      rate_limited: "You’ve started too many imports. Apply or discard some, or try again in an hour.",
    };
    return again(why[r.error] ?? "That import was refused.", r.error === "rate_limited" ? 429 : r.error === "not_found" ? 404 : 403);
  } catch (err) {
    if (err instanceof SecretsError) {
      return again(variablesConfigured() ? "A value is at most 64 KiB." : "This server has no encryption key, so values can’t be set here.");
    }
    return again(message(err));
  }
}

const STATUS_TEXT: Record<string, string> = {
  applied: "This import was applied.",
  rejected: "This import was rejected or discarded; its values are gone.",
  expired: "This import expired before anyone applied it; its values are gone.",
};

async function reviewImport(ctx: Ctx, v: Vault, importId: string): Promise<Reply> {
  const found = await getImport(ctx.userId, v.id, importId);
  if (!found) return notFound(ctx);
  const { imp, existing } = found;
  const { environments } = await listVariables(ctx.userId, v.id);
  const envs = environments.filter((e) => imp.environments.includes(e.name));
  const mayApply = envs.length === imp.environments.length && envs.every((e) => writes(v.role, e));
  const pending = imp.status === "pending";
  const push = imp.source === "cli";
  const title = push ? "Review a push" : "Review your import";
  const replaced = imp.names.filter((n) => existing.has(n)).length;
  const body = html`
    ${pageHeader({
      crumb: crumb(v, "import"),
      title,
      meta: html`<p class="meta"><span>${push ? html`Sent by ${who(ctx, imp.createdBy, null)} with the Reliquary CLI` : "Pasted by you"}, ${ago(imp.createdAt)}</span>${
        pending ? html`<span>Expires in ${inTime(imp.expiresAt)}</span>` : ""}</p>`,
    })}
    ${pending
      ? ""
      : html`<p class="callout ${imp.status === "applied" ? "success" : "neutral"}" role="status">${STATUS_TEXT[imp.status]}${
          imp.decidedBy && imp.status !== "expired" ? ` (${who(ctx, imp.decidedBy, null)}, ${ago(imp.decidedAt!)})` : ""}</p>`}
    ${pending && push
      ? html`<p class="callout attention">Sent from a computer signed in as ${who(ctx, imp.createdBy, null)}; an agent may have run it. Check the names before you apply. Values are set as you, and the access log records that they came from this push.</p>`
      : ""}
    <p class="lede">${plural(imp.names.length, "variable")} for ${imp.environments.join(", ")}: ${
      plural(imp.names.length - replaced, "new name")}, ${plural(replaced, "replacing a value", "replacing values")}. Values aren’t shown here.</p>
    <div class="vars-wrap"><table class="vars import-preview">
      <thead><tr><th>Name</th>${envs.map((e) => html`<th>${e.name}</th>`)}</tr></thead>
      <tbody>${imp.names.map(
        (n) => html`<tr><th scope="row"><code>${n}</code></th>${envs.map((e) => {
          const version = existing.get(n)?.get(e.name);
          return html`<td data-label="${e.name}"><div>${version
            ? html`<span class="badge attention">Replaces v${version}</span>`
            : html`<span class="badge">New</span>`} <span class="muted small">value set, hidden</span></div></td>`;
        })}</tr>`,
      )}</tbody></table></div>
    ${imp.refused.length ? html`<h2>Not taken</h2><p class="small muted">Lines of the file that won’t be imported, and why.</p>${refusedList(imp.refused)}` : ""}
    ${pending && mayApply
      ? html`<div class="actions import-actions">
          <form method="post" action="${importPath(v.id, imp.id, "/apply")}">${csrfField(ctx.csrf)}<button class="primary">Apply: set ${plural(imp.names.length, "variable")}</button></form>
          <form method="post" action="${importPath(v.id, imp.id, "/reject")}">${csrfField(ctx.csrf)}<button class="danger">${push ? "Reject" : "Discard"}</button></form>
        </div>`
      : pending
        ? html`<p class="muted small">Only owners set values in ${envs.filter((e) => !writes(v.role, e)).map((e) => e.name).join(", ")}, so an owner applies this.</p>`
        : html`<p><a href="${base(v.id)}">Back to variables</a></p>`}`;
  return shell(ctx, v, title, body);
}

async function decideImport(ctx: Ctx, v: Vault, importId: string, apply: boolean): Promise<Reply> {
  const r = apply ? await applyImport(ctx.userId, importId) : await rejectImport(ctx.userId, importId);
  if (r.ok) {
    if (apply) ctx.setFlash(`Set ${plural(r.names?.length ?? 0, "variable")} in ${(r.environments ?? []).join(", ")}.`);
    else ctx.setFlash("The import is discarded; its values are gone.");
    return { redirect: base(v.id) };
  }
  if (r.error === "not_found") return notFound(ctx);
  if (r.error === "storage_limit" && r.message) {
    // The database's own words (20260925230000_plans.sql), with a reference.
    const f = failure({ status: 403, where: "database (plan limits)", why: `${r.message.charAt(0).toUpperCase()}${r.message.slice(1)}` });
    ctx.setFlash(`${f.why} (ref ${f.ref})`);
    return { redirect: importPath(v.id, importId) };
  }
  const why: Record<string, string> = {
    forbidden: "Your role can’t set values in every environment of this import.",
    expired: "This import expired; its values are gone. Import the file again.",
    applied: "This import was already applied.",
    rejected: "This import was already rejected or discarded.",
    unauthorized: "Your session ended. Sign in and try again.",
  };
  ctx.setFlash(why[r.error] ?? "That was refused.");
  return { redirect: importPath(v.id, importId) };
}

// ---------------------------------------------------------------------------
// Environments: owners add, rename and delete them. The database decides
// (public.create_environment and friends); this page offers what an owner
// may do and shows the database's refusal otherwise.

const envBase = (vaultId: string, rest = "") => base(vaultId, `/environments${rest}`);

async function ownersOnlyPage(ctx: Ctx, v: Vault, title: string): Promise<Reply> {
  return shell(ctx, v, title, html`${pageHeader({ crumb: crumb(v, "environments"), title })}
    <p class="callout attention">Only owners manage a vault’s environments.</p>`, 403);
}

async function environmentsPage(ctx: Ctx, v: Vault, f: { name?: string; ownersOnly?: boolean; error?: string } = {}, status = 200): Promise<Reply> {
  const title = "Environments";
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  const count = (e: string) => variables.filter((x) => x.values.some((y) => y.environment === e)).length;
  const body = html`
    ${pageHeader({ crumb: crumb(v, "environments"), title, actions: html`<a class="button" href="${base(v.id)}">Variables</a>` })}
    ${f.error ? html`<p class="callout danger" role="alert">${f.error}</p>` : ""}
    <p class="lede">Each environment holds its own value of every variable. Programs get one environment’s values: <code>reliquary run --env &lt;name&gt;</code>. Owners-only environments are set and read by owners alone.</p>
    <ul class="rows env-list">${environments.map((e) => {
      const n = count(e.name);
      const isDefault = DEFAULT_ENVIRONMENTS.includes(e.name);
      return html`<li><span><strong>${e.name}</strong>${e.ownersOnly ? html` <span class="badge">Owners only</span>` : ""}
        <span class="muted small"> · ${plural(n, "value")}${isDefault ? " · default" : ""}</span></span>
        <span class="row-end small">${isDefault ? "" : html`<a class="button" href="${envBase(v.id, "/rename")}?name=${q(e.name)}">Rename</a>`}${
          !isDefault || n === 0 ? html`<a class="button danger" href="${envBase(v.id, "/delete")}?name=${q(e.name)}">Delete</a>` : ""}</span></li>`;
    })}</ul>
    <p class="small muted">The defaults keep their names, and are deleted only when they hold no value. A vault has at most 20 environments.</p>
    <h2>Add an environment</h2>
    <form method="post" action="${envBase(v.id)}" class="panel choice-form" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <label for="en">Name</label>
      <input id="en" type="text" name="name" value="${f.name ?? ""}" placeholder="staging" required maxlength="32"
        autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="hint">Lowercase letters, digits, <code>-</code> and <code>_</code>, starting with a letter.</p>
      <label class="choice"><input type="checkbox" name="owners_only" value="1"${f.ownersOnly ? raw(" checked") : ""}> Owners only (like production)</label>
      <div class="actions"><button class="primary">Add environment</button></div>
    </form>`;
  return shell(ctx, v, title, body, status, envBase(v.id));
}

async function createEnvironmentPost(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  const ownersOnly = ctx.form.get("owners_only") === "1";
  try {
    await createEnvironment(ctx.userId, v.id, name, ownersOnly);
    ctx.setFlash(`Added ${name}${ownersOnly ? " (owners only)" : ""}.`);
    return { redirect: envBase(v.id) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return environmentsPage(ctx, v, { name: ENV.test(name) ? name : "", ownersOnly, error: message(err) }, code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
}

async function renamePage(ctx: Ctx, v: Vault, from: string, f: { to?: string; error?: string } = {}, status = 200): Promise<Reply> {
  const title = `Rename ${from}`;
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  if (!environments.some((e) => e.name === from)) return notFound(ctx);
  const n = variables.filter((x) => x.values.some((y) => y.environment === from)).length;
  const body = html`
    ${pageHeader({ crumb: crumb(v, "environments"), title, path: true })}
    ${f.error ? html`<p class="callout danger" role="alert">${f.error}</p>` : ""}
    <p class="lede">${n ? `Its ${plural(n, "value")} ${n === 1 ? "moves" : "move"} with it.` : "It holds no values."} Scripts and <code>.reliquary.json</code> files that name <strong>${from}</strong> need the new name, and pushes waiting for approval for ${from} are rejected: send them again.</p>
    <form method="post" action="${envBase(v.id, "/rename")}" class="panel" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="from" value="${from}">
      <label for="et">New name</label>
      <input id="et" type="text" name="to" value="${f.to ?? ""}" required maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="actions"><button class="primary">Rename</button><a class="button quiet" href="${envBase(v.id)}">Cancel</a></div>
    </form>`;
  return shell(ctx, v, title, body, status, envBase(v.id));
}

async function renamePost(ctx: Ctx, v: Vault): Promise<Reply> {
  const from = ctx.form.get("from") ?? "";
  const to = (ctx.form.get("to") ?? "").trim();
  if (!ENV.test(from)) return notFound(ctx);
  try {
    const r = await renameEnvironment(ctx.userId, v.id, from, to);
    ctx.setFlash(`Renamed ${from} to ${to}${r.moved ? ` with its ${plural(r.moved, "value")}` : ""}.${r.rejectedImports ? ` ${plural(r.rejectedImports, "pending import was", "pending imports were")} rejected.` : ""}`);
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

async function deleteEnvPage(ctx: Ctx, v: Vault, name: string, error?: string, status = 200): Promise<Reply> {
  const title = `Delete ${name}`;
  if (v.role !== "owner") return ownersOnlyPage(ctx, v, title);
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  if (!environments.some((e) => e.name === name)) return notFound(ctx);
  const names = variables.filter((x) => x.values.some((y) => y.environment === name)).map((x) => x.name);
  const body = html`
    ${pageHeader({ crumb: crumb(v, "environments"), title, path: true })}
    ${error ? html`<p class="callout danger" role="alert">${error}</p>` : ""}
    <p class="lede">${names.length
      ? html`This destroys the ${plural(names.length, "value")} in <strong>${name}</strong> (${names.map((n, i) => html`${i ? ", " : ""}<code>${n}</code>`)}). They can’t be recovered; other environments keep theirs. Programs run with <code>--env ${name}</code> stop getting them.`
      : html`<strong>${name}</strong> holds no values.`} Pushes waiting for approval for it are rejected. The access log keeps the record.</p>
    <form method="post" action="${envBase(v.id, "/delete")}" class="panel" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="name" value="${name}">
      <label for="ec">Type <strong>${name}</strong> to confirm</label>
      <input id="ec" type="text" name="confirm_name" required autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="actions"><button class="danger">Delete ${name}${names.length ? " and its values" : ""}</button>
        <a class="button quiet" href="${envBase(v.id)}">Cancel</a></div>
    </form>`;
  return shell(ctx, v, title, body, status, envBase(v.id));
}

async function deleteEnvPost(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const typed = (ctx.form.get("confirm_name") ?? "").trim();
  if (!ENV.test(name)) return notFound(ctx);
  try {
    const r = await deleteEnvironment(ctx.userId, v.id, name, typed);
    ctx.setFlash(`Deleted ${name}${r.deleted ? ` and its ${plural(r.deleted, "value")}` : ""}.`);
    return { redirect: envBase(v.id) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "22023") return deleteEnvPage(ctx, v, name, "That isn’t the environment’s name. Nothing was deleted.", 400);
    return deleteEnvPage(ctx, v, name, message(err), code === "42501" ? 403 : code === "P0002" ? 404 : 400);
  }
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
  const d = r.detail as { attempt?: string; reason?: string; from?: string; values?: number; imports?: number; key_ids?: string[] };
  if (r.action === "rename_environment") return `from ${d.from ?? "?"}`;
  if (r.action === "delete_environment") return `${d.values ?? 0} value${d.values === 1 ? "" : "s"} destroyed`;
  if (r.action === "rotate_key") return `${(d.values ?? 0) + (d.imports ?? 0)} to key ${(d.key_ids ?? []).join(", ")}`;
  if (r.action === "reject" && d.reason) return d.reason;
  if (r.action !== "refused") return "";
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
              <td class="small" data-label="What"><div>${r.action === "refused"
                ? html`<span class="badge danger">Refused</span> <span class="muted">${detail(r)}</span>`
                : html`${ACTION_LABEL[r.action] ?? r.action}${detail(r) ? html` <span class="muted">${detail(r)}</span>` : ""}`}</div></td>
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
  if (rest === "/variables/environments") return get ? environmentsPage(ctx, v) : createEnvironmentPost(ctx, v);
  if (rest === "/variables/environments/rename") {
    if (!get) return renamePost(ctx, v);
    const name = ctx.url.searchParams.get("name") ?? "";
    return ENV.test(name) ? renamePage(ctx, v, name) : notFound(ctx);
  }
  if (rest === "/variables/environments/delete") {
    if (!get) return deleteEnvPost(ctx, v);
    const name = ctx.url.searchParams.get("name") ?? "";
    return ENV.test(name) ? deleteEnvPage(ctx, v, name) : notFound(ctx);
  }
  if (get && rest === "/variables/import") return importForm(ctx, v, {});
  if (!get && rest === "/variables/import") return importPost(ctx, v);
  const m = /^\/variables\/imports\/([0-9a-f-]{36})(\/apply|\/reject)?$/.exec(rest);
  if (m && UUID.test(m[1])) {
    if (get && !m[2]) return reviewImport(ctx, v, m[1]);
    if (!get && m[2]) return decideImport(ctx, v, m[1], m[2] === "/apply");
  }
  return notFound(ctx);
}
