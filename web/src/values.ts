// The Values tab of the Variables page (docs/variables.md, "Web: the
// Variables page"): the grid of names by environment, and set/rotate,
// delete and reveal for people whose role allows it. Every call goes
// through src/variables.ts as the signed-in person, and the database
// decides: this file only chooses what to offer. Split out of
// variablespage.ts, which keeps the shared page chrome (tabs, breadcrumbs,
// the vault frame) and composes this with environments.ts, accesslog.ts and
// imports.ts into the Variables page's routes.
//
// A value exists in plaintext here only in two places: the set form's POST
// body, handed straight to setVariable(), and the reveal response, which is a
// page rendered from one POST (never a redirect, never a GET, so never in a
// URL, history or referrer; every response is no-store). No flash, redirect,
// error page or log line carries one, and a refused set re-renders its form
// empty.

import {
  callout,
  confirmPage,
  csrfField,
  emptyState,
  html,
  menu,
  pageHeader,
  raw,
  relativeTime,
  time,
  utc,
  type MenuItem,
  type Raw,
} from "./html.js";
import { message, notFound, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { SecretsError, variablesConfigured } from "./secrets.js";
import {
  deleteVariable,
  listVariables,
  readersSinceSet,
  revealVariable,
  setVariable,
  type ReaderRow,
  type EnvImport,
  type Environment,
  type Variable,
} from "./variables.js";
import { base, client, crumbs, ENV, NAME, OWNERS_ONLY_HELP, plural, q, readsLog, refusal, sectionHeader, shell, theVault, waitingIn, writes } from "./variablespage.js";
import { importPath } from "./imports.js";

const slotQuery = (name: string, environment: string) => `?name=${q(name)}&environment=${q(environment)}`;

// Who read or revealed each value since it was set ("read by you (CLI)",
// "revealed by 1a2b3c4d"), newest first, once each, keyed by name and
// environment.
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
const label = (e: Environment) => (e.ownersOnly ? `${e.name} (owners only)` : e.name);

// One cell: "Set 6 min ago" ("by you" is read out, and shown on a phone;
// who, the exact time and the version are in its title and at the top of
// its menu), a "Read since set" mark when someone has, and one ⋯ menu with
// Reveal, Rotate and Delete; or "Not set" with a Set link.
function cell(ctx: Ctx, v: Vault, variable: Variable, e: Environment, readersByCell: Readers | null, keyed: boolean): Raw {
  const value = variable.values.find((x) => x.environment === e.name);
  const may = keyed && writes(v.role, e);
  const where = `${variable.name} in ${e.name}`;
  if (!value) {
    return html`<td data-label="${label(e)}"><div class="var-cell"><span class="var-none">Not set</span>${
      may ? html`<a class="button ghost var-add" href="${base(v.id, "/set")}${slotQuery(variable.name, e.name)}" aria-label="Set ${where}">Set</a>` : ""
    }</div></td>`;
  }
  const readers = readersByCell?.get(slot(variable.name, e.name)) ?? { who: [], read: false };
  const setBy = who(ctx, value.updatedBy, null);
  const seen = readers.who.join("; ");
  const items: MenuItem[] = [
    { action: base(v.id, "/reveal"), csrf: ctx.csrf, fields: { name: variable.name, environment: e.name }, label: "Reveal", description: "Show it once; the reveal is logged" },
    { href: `${base(v.id, "/set")}${slotQuery(variable.name, e.name)}`, label: "Rotate", description: "Replace it with a new value" },
    ...(readers.read ? [{ href: "/connections", label: "Manage connections", description: "Revoke the Reliquary CLI that read it" }] : []),
    { href: `${base(v.id, "/delete")}${slotQuery(variable.name, e.name)}`, label: "Delete", description: `Remove it from ${e.name}`, danger: true },
  ];
  return html`<td data-label="${label(e)}"><div class="var-cell">
    <span class="var-state" title="Set by ${setBy}, ${utc(value.updatedAt)} (version ${value.version})"><span class="var-set">Set</span> <span class="var-meta"><time datetime="${value.updatedAt.toISOString()}">${relativeTime(value.updatedAt)}</time><span class="var-by"> by ${setBy}</span></span>${
      seen ? html`<span class="var-readers" title="Since it was set: ${seen}">${readers.read ? "Read since set" : "Revealed since set"}</span>` : ""}</span>
    ${may ? menu({ label: `Actions for ${where}`, icon: "more", items, heading: `Set by ${setBy}, ${utc(value.updatedAt)}.${seen ? ` Since then: ${seen}.` : ""}`, className: "var-menu" }) : ""}
  </div></td>`;
}

// Imports from the CLI waiting, as one line on the Values tab.
function waitingNotice(ctx: Ctx, v: Vault, pushes: EnvImport[]): Raw {
  if (!pushes.length) return raw("");
  const [p] = pushes;
  return callout(
    "warning",
    pushes.length === 1
      ? html`<p><strong>An import from the CLI is waiting to be applied:</strong> <a href="${importPath(v.id, p.id)}">${plural(p.names.length, "variable")} for ${p.environments.join(", ")}</a>, from ${who(ctx, p.createdBy, null)}. Nothing is set until a person applies it.</p>`
      : html`<p><strong>${pushes.length} imports from the CLI are waiting to be applied.</strong> <a href="${base(v.id, "/imports")}">Review them</a>. Nothing is set until a person applies them.</p>`,
  );
}

export async function list(ctx: Ctx, id: string): Promise<Reply> {
  const v = await theVault(ctx, id);
  if (!v) return notFound(ctx);
  const { environments, variables } = await listVariables(ctx.userId, id);
  const keyed = variablesConfigured();
  const readers = readsLog(v.role) && variables.length ? readersOf(ctx, await readersSinceSet(ctx.userId, id)) : null;
  const canSet = keyed && environments.some((e) => writes(v.role, e));
  const ownersOnly = environments.filter((e) => e.ownersOnly).map((e) => e.name);
  const pushes = await waitingIn(ctx, v);

  const body = html`
    ${sectionHeader(v, "values", pushes.length, {
      description: "Secrets for this vault’s projects, one value per environment. This page shows names and who set them, never a value.",
      secondary: canSet ? html`<a class="button" href="${base(id, "/import")}">Import .env</a>` : "",
      primary: canSet ? html`<a class="button primary" href="${base(id, "/set")}">Add a variable</a>` : "",
    })}
    ${keyed ? "" : callout("warning", "This server has no encryption key, so values can’t be set or revealed here. Names are listed as usual.")}
    ${waitingNotice(ctx, v, pushes)}
    ${v.role === "viewer"
      ? html`<p class="muted small">As a viewer you see names only. Owners and editors set and use values.</p>`
      : v.role === "editor" && ownersOnly.length
        ? html`<p class="muted small">Only owners set, rotate, delete or reveal values in ${ownersOnly.join(", ")}.</p>`
        : ""}
    ${variables.length
      ? html`<div class="var-values"><div class="var-grid-wrap"><table class="var-grid">
        <thead><tr><th scope="col">Name</th>${environments.map(
          (e) => html`<th scope="col"><span class="var-env">${e.name}</span>${e.ownersOnly ? html` <span class="badge var-owners" title="${OWNERS_ONLY_HELP}">Owners only</span>` : ""}</th>`,
        )}</tr></thead>
        <tbody>${variables.map(
          (x) => html`<tr><th scope="row"><code>${x.name}</code></th>${environments.map((e) => cell(ctx, v, x, e, readers, keyed))}</tr>`,
        )}</tbody></table></div></div>`
      : emptyState({
          title: "No variables yet.",
          body: html`Keep your projects’ secrets here instead of in <code>.env</code> files passed around by hand. Each value is encrypted, and every set, read and reveal is logged.`,
          action: canSet ? html`<a class="button" href="${base(id, "/set")}">Add a variable</a>` : undefined,
        })}
    <h2>Use them</h2>
    <p>Run a command with this vault’s variables, without writing them to disk:</p>
    <pre class="code">npx @reliquary-ai/cli run --env development -- &lt;command&gt;</pre>
    <p class="small muted">The first time, <code>npx @reliquary-ai/cli login</code> connects the Reliquary CLI to your account. <code>env pull</code> writes a <code>.env</code> instead, only where git ignores it. Setup is on the <a href="/connect?client=cli">Connect</a> page.</p>
    <div class="callout warning var-caveats">
      <p><strong>Agents can read what reaches them.</strong> An agent that runs commands where a value was delivered can read it. <code>run</code> limits a value to one process; prefer short-lived, narrowly scoped keys.</p>
      <p><strong>The hosted operator can decrypt.</strong> Values are encrypted with a key the database never sees, but whoever runs this server holds both.</p>
    </div>`;
  return shell(ctx, v, "Variables", body);
}

// ---------------------------------------------------------------------------
// Set or rotate

type SetForm = { name?: string; environment?: string; error?: string };

export async function setForm(ctx: Ctx, v: Vault, f: SetForm, status = 200): Promise<Reply> {
  const { environments, variables } = await listVariables(ctx.userId, v.id);
  const allowed = environments.filter((e) => writes(v.role, e));
  const exists = !!f.name && !!f.environment && variables.some((x) => x.name === f.name && x.values.some((y) => y.environment === f.environment));
  const title = exists ? `Rotate ${f.name}` : "Add a variable";
  const crumb = crumbs(v, { label: title });
  const keyed = variablesConfigured();
  const lockedEnv = exists && !allowed.some((e) => e.name === f.environment);
  if (!allowed.length || !keyed || lockedEnv) {
    const why = !keyed
      ? "This server has no encryption key, so values can’t be set here."
      : lockedEnv
        ? `Only owners set values in ${f.environment}.`
        : "Your role in this vault can’t set variables. Ask an owner.";
    return shell(ctx, v, title, html`${pageHeader({ crumb, title, path: exists })}${callout("warning", why)}`, 403);
  }
  // Every environment as a radio; the ones this role can't set are shown,
  // disabled, so the rule is visible where the choice is made.
  const chosen = allowed.some((e) => e.name === f.environment) ? f.environment : allowed[0].name;
  const locked = environments.filter((e) => !writes(v.role, e)).map((e) => e.name);
  const envChoice = exists
    ? html`<input type="hidden" name="environment" value="${f.environment}"><p class="small"><span class="muted">Environment</span> <strong>${f.environment}</strong></p>`
    : html`<fieldset class="var-envs">
        <legend>Environment</legend>
        ${environments.map((e) => {
          const ok = writes(v.role, e);
          return html`<label class="choice${ok ? "" : " is-disabled"}"><input type="radio" name="environment" value="${e.name}"${
            ok ? raw(e.name === chosen ? " checked required" : " required") : raw(" disabled")}> ${e.name}${
            e.ownersOnly ? html` <span class="badge var-owners" title="${OWNERS_ONLY_HELP}">Owners only</span>` : ""}</label>`;
        })}
        ${locked.length ? html`<p class="hint">Only owners set values in ${locked.join(", ")}.</p>` : ""}
      </fieldset>`;
  const button = exists ? "Save new value" : "Save variable";
  const body = html`
    ${pageHeader({
      crumb,
      title,
      path: exists,
      secondary: html`<a class="button quiet" href="${base(v.id)}">Cancel</a>`,
      primary: html`<button class="primary" form="set-variable">${button}</button>`,
    })}
    ${f.error ? refusal(f.error) : ""}
    <p class="lede">${exists
      ? html`The new value replaces the old one in <strong>${f.environment}</strong>. Anyone who already read the old value still has it: rotate it at its provider too.`
      : "Programs run with the CLI get it as an environment variable. The value is encrypted before it’s stored, and isn’t shown here again unless an owner or editor reveals it."}</p>
    <form method="post" action="${base(v.id, "/set")}" class="panel choice-form" id="set-variable" autocomplete="off">
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
      <div class="actions"><button class="primary">${button}</button>
        <a class="button quiet" href="${base(v.id)}">Cancel</a></div>
    </form>`;
  return shell(ctx, v, title, body, status, base(v.id));
}

export async function saveVariable(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = (ctx.form.get("name") ?? "").trim();
  const environment = ctx.form.get("environment") ?? "";
  const value = ctx.form.get("value") ?? "";
  // The form again, with name and environment kept and the value dropped.
  const again = (error: string, status = 400) => setForm(ctx, v, { name, environment, error }, status);
  if (!ENV.test(environment)) return again("Choose an environment.");
  if (!value) return again("Enter a value.");
  try {
    const action = await setVariable(ctx.userId, v.id, name, environment, value);
    ctx.setFlash(action === "rotate" ? `Rotated ${name} in ${environment}.` : `Set ${name} in ${environment}.`, "success");
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

export async function confirmDelete(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.url.searchParams.get("name") ?? "";
  const environment = ctx.url.searchParams.get("environment") ?? "";
  if (!NAME.test(name) || !ENV.test(environment)) return notFound(ctx);
  const { variables } = await listVariables(ctx.userId, v.id);
  if (!variables.some((x) => x.name === name && x.values.some((y) => y.environment === environment))) return notFound(ctx);
  const title = `Delete ${name}`;
  const body = html`<div class="var-confirm">${confirmPage({
    title,
    crumb: crumbs(v, { label: title }),
    lede: html`Delete the value of <code>${name}</code> in <strong>${environment}</strong>? Programs run with the CLI won’t get it any more.`,
    consequences: ["This can’t be undone; the access log keeps the record.", "Other environments keep their values."],
    action: base(v.id, "/delete"),
    csrf: ctx.csrf,
    fields: { name, environment },
    button: `Delete ${name} from ${environment}`,
    cancel: base(v.id),
  })}</div>`;
  return shell(ctx, v, title, body);
}

export async function remove(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const environment = ctx.form.get("environment") ?? "";
  try {
    await deleteVariable(ctx.userId, v.id, name, environment);
    ctx.setFlash(`Deleted ${name} from ${environment}.`, "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: base(v.id) };
}

// ---------------------------------------------------------------------------
// Reveal: one value, in this response only

export async function reveal(ctx: Ctx, v: Vault): Promise<Reply> {
  const name = ctx.form.get("name") ?? "";
  const environment = ctx.form.get("environment") ?? "";
  const back = base(v.id);
  const fail = (status: number, text: Raw | string) =>
    shell(ctx, v, `Reveal ${name}`, html`${pageHeader({ crumb: crumbs(v, { label: `Reveal ${name}` }), title: `Reveal ${name}`, path: true, primary: html`<a class="button" href="${back}">Back to variables</a>` })}
      ${refusal(text)}`, status, back);
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
      crumb: crumbs(v, { label: `Reveal ${name}` }),
      title,
      path: true,
      meta: html`<p class="meta"><span>Set by ${who(ctx, r.updatedBy, null)}, ${time(r.updatedAt)}</span></p>`,
      primary: html`<a class="button" href="${back}">Done</a>`,
    })}
    <div class="callout attention reveal" role="status">
      <strong>This reveal is logged.</strong>
      <p>Owners and editors of ${v.name} see in the access log that you revealed it. It’s shown on this page only: nothing is saved in your browser, and it won’t be shown again when you leave.</p>
      <pre class="secret">${r.value}</pre>
    </div>
    <p class="small muted">Don’t paste it into a chat with an agent: a value typed to an agent has reached a model. To use it in a program, run it with the CLI.</p>`;
  return shell(ctx, v, title, body, 200, back);
}
