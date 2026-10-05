// The Imports tab of the Variables page (docs/variables.md, "Web: the
// Variables page"): a .env brought in at once, pasted here or sent from the
// CLI with `reliquary env push`. Values are in plaintext here only in the
// paste form's POST body, handed straight to createImport() (sealed, stored
// as a pasted import only its author sees). No page shows one: the preview
// names what will be set or replaced, and the confirm step sends only the
// import's id, so a value never goes back to the browser. Split out of
// variablespage.ts, which keeps the shared page chrome (tabs, breadcrumbs,
// the vault frame).

import { callout, csrfField, emptyState, html, pageHeader, raw, relativeTime, time, type Raw } from "./html.js";
import { message, notFound, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { SecretsError, variablesConfigured } from "./secrets.js";
import { dotenvTooBig, parseDotenv, DOTENV_MAX_ENTRIES } from "./dotenv.js";
import { applyImport, createImport, getImport, listVariables, rejectImport, type EnvImport } from "./variables.js";
import { base, crumbs, ENV, plural, readsLog, refusal, sectionHeader, shell, theVault, waitingIn, withRef, writes } from "./variablespage.js";

// An import this long gets its Apply and Reject again under the list.
const LONG_IMPORT = 12;

export const importPath = (vaultId: string, importId: string, rest = "") => base(vaultId, `/imports/${importId}${rest}`);
const importWhat = (p: EnvImport) => `${plural(p.names.length, "variable")} for ${p.environments.join(", ")}`;

// Imports from the CLI waiting, in the Inbox (every vault; `showVault`).
export function pendingList(ctx: Ctx, pushes: (EnvImport & { vaultName: string; mayApply: boolean })[], showVault: boolean): Raw {
  return html`<section class="callout attention pending-imports" aria-label="Imports from the CLI waiting to be applied">
    <strong>${pushes.length === 1 ? "An import from the CLI is" : `${pushes.length} imports from the CLI are`} waiting to be applied</strong>
    <p class="small">Sent with <code>reliquary env push</code>. Nothing is set until a person applies it here.</p>
    <ul class="rows">${pushes.map(
      (p) => html`<li><span><a class="name" href="${importPath(p.vaultId, p.id)}">${importWhat(p)}</a>
        <span class="muted small"> · ${showVault ? `${p.vaultName} · ` : ""}from ${who(ctx, p.createdBy, null)} via the CLI · ${time(p.createdAt)} · expires ${time(p.expiresAt)}</span></span>
        <span class="row-end small">${p.mayApply ? html`<a class="button" href="${importPath(p.vaultId, p.id)}">Review</a>` : html`<span class="muted">Owners apply it</span>`}</span></li>`,
    )}</ul>
  </section>`;
}

// The Imports tab: imports from the CLI waiting in this vault. A pasted
// import opens on its own preview and is its author's alone, so it isn't
// listed here.
export async function importsPage(ctx: Ctx, id: string): Promise<Reply> {
  const v = await theVault(ctx, id);
  if (!v) return notFound(ctx);
  const pushes = await waitingIn(ctx, v);
  const { environments } = await listVariables(ctx.userId, id);
  const canSet = variablesConfigured() && environments.some((e) => writes(v.role, e));
  let content: Raw;
  if (!readsLog(v.role)) {
    content = emptyState({ title: "Only owners and editors see this vault’s imports." });
  } else if (!pushes.length) {
    content = emptyState({
      title: "No imports waiting.",
      body: html`Send a <code>.env</code> from a project with <code>npx @reliquary-ai/cli env push --env development</code>: it waits here until a person applies it. A <code>.env</code> you paste with Import .env opens straight on its preview.`,
    });
  } else {
    content = html`<div class="table-wrap"><table class="table-stack var-imports">
      <thead><tr><th scope="col">Import</th><th scope="col">From</th><th scope="col">Sent</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Review</span></th></tr></thead>
      <tbody>${pushes.map(
        (p) => html`<tr>
          <td data-label="Import"><a href="${importPath(id, p.id)}">${importWhat(p)}</a></td>
          <td data-label="From">${who(ctx, p.createdBy, null)} <span class="muted">· CLI</span></td>
          <td data-label="Sent">${time(p.createdAt)}</td>
          <td data-label="Expires">${time(p.expiresAt)}</td>
          <td data-label="">${p.mayApply ? html`<a class="button" href="${importPath(id, p.id)}">Review</a>` : html`<span class="muted small">Owners apply it</span>`}</td>
        </tr>`,
      )}</tbody></table></div>`;
  }
  const body = html`
    ${sectionHeader(v, "imports", pushes.length, {
      description: "A .env brought in at once waits here until a person applies it; nothing is set before.",
      primary: canSet ? html`<a class="button primary" href="${base(id, "/import")}">Import .env</a>` : "",
    })}
    ${content}`;
  return shell(ctx, v, "Imports · Variables", body);
}

type ImportForm = { environments?: string[]; error?: Raw | string; refused?: { line: number; name: string | null; reason: string }[] };

function refusedList(refused: { line: number; name: string | null; reason: string }[]): Raw {
  return html`<ul class="plain small import-refused">${refused.map(
    (r) => html`<li>Line ${r.line}${r.name ? html`, <code>${r.name}</code>` : ""}: ${r.reason}</li>`,
  )}</ul>`;
}

export async function importForm(ctx: Ctx, v: Vault, f: ImportForm, status = 200): Promise<Reply> {
  const { environments } = await listVariables(ctx.userId, v.id);
  const allowed = environments.filter((e) => writes(v.role, e));
  const title = "Import a .env";
  const crumb = crumbs(v, { label: "Imports", href: base(v.id, "/imports") }, { label: title });
  if (!allowed.length || !variablesConfigured()) {
    const why = variablesConfigured() ? "Your role in this vault can’t set variables. Ask an owner." : "This server has no encryption key, so values can’t be set here.";
    // A POST that lands here was refused, so it gets a reference; a GET only explains.
    const shown = ctx.method === "POST" ? withRef(403, variablesConfigured() ? "web app (the import form)" : "encryption", why) : why;
    return shell(ctx, v, title, html`${pageHeader({ crumb, title })}${callout("warning", shown)}`, 403);
  }
  const chosen = f.environments?.length ? f.environments : ["development"];
  const body = html`
    ${pageHeader({
      crumb,
      title,
      description: "Paste a .env file; you see which names are new and which replace a value, without the values, before anything is set.",
      secondary: html`<a class="button quiet" href="${base(v.id)}">Cancel</a>`,
      primary: html`<button class="primary" form="import-env">Review the import</button>`,
    })}
    ${f.error ? refusal(f.error) : ""}
    ${f.refused?.length ? callout("warning", html`<p><strong>Not taken:</strong></p>${refusedList(f.refused)}`) : ""}
    <form method="post" action="${base(v.id, "/import")}" class="panel choice-form" id="import-env" autocomplete="off">
      ${csrfField(ctx.csrf)}
      <label for="ie">Contents of the .env</label>
      <textarea id="ie" name="dotenv" class="secret-input" rows="12" required autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="STRIPE_SECRET_KEY=sk_test_...&#10;DATABASE_URL=&quot;postgres://...&quot;"></textarea>
      <details class="var-syntax">
        <summary>What’s understood</summary>
        <p class="hint">Each <code>NAME=value</code> line becomes a variable. Comments, blank lines, <code>export</code>, single and double quotes (with <code>\\n</code> escapes in double quotes) and multi-line quoted values are understood; <code>\${VAR}</code> isn’t expanded. Up to ${DOTENV_MAX_ENTRIES} variables. Names like <code>PATH</code> or <code>NODE_OPTIONS</code> are refused.</p>
      </details>
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
    <p class="small muted">From a terminal, or an agent: <code>npx @reliquary-ai/cli env push --env development</code> sends a <code>.env</code> file as an import from the CLI, which waits on the Imports tab for a person to apply it. It never sets a value by itself.</p>`;
  return shell(ctx, v, title, body, status, base(v.id));
}

export async function importPost(ctx: Ctx, v: Vault): Promise<Reply> {
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
    const db = "database (function public.create_env_import)";
    const why: Record<string, [number, string, string]> = {
      forbidden: [403, db, "Your role can’t set values in every environment you ticked."],
      not_found: [404, db, "There’s no such environment in this vault."],
      rate_limited: [429, "rate limit (imports a person may start)", "You’ve started too many imports. Apply or discard some, or try again in an hour."],
      unauthorized: [401, db, "Your session ended. Sign in and try again."],
    };
    const [status, where, text] = why[r.error] ?? [403, db, `The database refused the import (${r.error}), so nothing was imported.`];
    return again(withRef(status, where, text), status);
  } catch (err) {
    if (err instanceof SecretsError) {
      // The parser has already refused a NUL or an oversize value, so this is
      // normally the missing key, which the form explains with a reference
      // (importForm); the error's own words (they name no value) say anything
      // else.
      if (!variablesConfigured()) return again("This server has no encryption key, so values can’t be set here.", 403);
      return again(withRef(400, "encryption", `The values couldn’t be encrypted: ${err.message}.`));
    }
    return again(message(err));
  }
}

const STATUS_TEXT: Record<string, string> = {
  applied: "This import was applied.",
  rejected: "This import was rejected or discarded; its values are gone.",
  expired: "This import expired before anyone applied it; its values are gone.",
};

export async function reviewImport(ctx: Ctx, v: Vault, importId: string): Promise<Reply> {
  const found = await getImport(ctx.userId, v.id, importId);
  if (!found) return notFound(ctx);
  const { imp, existing } = found;
  const { environments } = await listVariables(ctx.userId, v.id);
  const envs = environments.filter((e) => imp.environments.includes(e.name));
  const mayApply = envs.length === imp.environments.length && envs.every((e) => writes(v.role, e));
  const pending = imp.status === "pending";
  const fromCli = imp.source === "cli";
  const title = fromCli ? "Review an import from the CLI" : "Review an import you pasted";
  const replaced = imp.names.filter((n) => existing.has(n)).length;
  // Apply and Reject (Discard for your own paste): in the header, and again
  // under a long list.
  const decide = pending && mayApply
    ? html`<span class="import-decide">
        <form method="post" action="${importPath(v.id, imp.id, "/reject")}">${csrfField(ctx.csrf)}<button class="danger">${fromCli ? "Reject" : "Discard"}</button></form>
        <form method="post" action="${importPath(v.id, imp.id, "/apply")}">${csrfField(ctx.csrf)}<button class="primary">Apply: set ${plural(imp.names.length, "variable")}</button></form>
      </span>`
    : "";
  const body = html`
    ${pageHeader({
      crumb: crumbs(v, { label: "Imports", href: base(v.id, "/imports") }, { label: fromCli ? "From the CLI" : "Pasted" }),
      title,
      meta: html`<p class="meta"><span>${fromCli ? html`Sent by ${who(ctx, imp.createdBy, null)} with the Reliquary CLI` : "Pasted by you"}, ${time(imp.createdAt)}</span>${
        pending ? html`<span>Expires ${time(imp.expiresAt)}</span>` : ""}</p>`,
      primary: decide,
    })}
    ${pending
      ? ""
      : callout(imp.status === "applied" ? "success" : "info", `${STATUS_TEXT[imp.status]}${
          imp.decidedBy && imp.status !== "expired" ? ` (${who(ctx, imp.decidedBy, null)}, ${relativeTime(imp.decidedAt!)})` : ""}`)}
    ${pending && fromCli
      ? callout("warning", `Sent from a computer signed in as ${who(ctx, imp.createdBy, null)}; an agent may have run it. Check the names before you apply. Values are set as you, and the access log records that they came from this import.`)
      : ""}
    ${pending && !mayApply
      ? html`<p class="muted small">Only owners set values in ${envs.filter((e) => !writes(v.role, e)).map((e) => e.name).join(", ")}, so an owner applies this.</p>`
      : ""}
    <p class="lede">${plural(imp.names.length, "variable")} for ${imp.environments.join(", ")}: ${
      plural(imp.names.length - replaced, "new name")}, ${plural(replaced, "replacing a value", "replacing values")}. Values aren’t shown here.</p>
    <div class="vars-wrap"><table class="vars import-preview">
      <thead><tr><th>Name</th>${envs.map((e) => html`<th>${e.name}</th>`)}</tr></thead>
      <tbody>${imp.names.map(
        (n) => html`<tr><th scope="row"><code>${n}</code></th>${envs.map((e) => {
          const replaces = !!existing.get(n)?.get(e.name);
          return html`<td data-label="${e.name}"><div>${replaces
            ? html`<span class="badge attention">Replaces a value</span>`
            : html`<span class="badge">New</span>`}</div></td>`;
        })}</tr>`,
      )}</tbody></table></div>
    ${imp.refused.length ? html`<h2>Not taken</h2><p class="small muted">Lines of the file that won’t be imported, and why.</p>${refusedList(imp.refused)}` : ""}
    ${pending && mayApply && imp.names.length > LONG_IMPORT ? html`<div class="actions import-actions">${decide}</div>` : ""}
    ${pending ? "" : html`<p><a href="${base(v.id)}">Back to variables</a></p>`}`;
  return shell(ctx, v, title, body);
}

export async function decideImport(ctx: Ctx, v: Vault, importId: string, apply: boolean): Promise<Reply> {
  const r = apply ? await applyImport(ctx.userId, importId) : await rejectImport(ctx.userId, importId);
  if (r.ok) {
    if (apply) ctx.setFlash(`Set ${plural(r.names?.length ?? 0, "variable")} in ${(r.environments ?? []).join(", ")}.`, "success");
    else ctx.setFlash("The import is discarded; its values are gone.", "success");
    return { redirect: base(v.id) };
  }
  if (r.error === "not_found") return notFound(ctx);
  if (r.error === "storage_limit" && r.message) {
    // The database's own words (20260925230000_plans.sql), with a reference.
    ctx.setFlash(withRef(403, "database (plan limits)", `${r.message.charAt(0).toUpperCase()}${r.message.slice(1)}`));
    return { redirect: importPath(v.id, importId) };
  }
  const db = `database (function public.${apply ? "apply_env_import" : "reject_env_import"})`;
  const why: Record<string, [number, string]> = {
    forbidden: [403, "Your role can’t set values in every environment of this import."],
    expired: [409, "This import expired; its values are gone. Import the file again."],
    applied: [409, "This import was already applied."],
    rejected: [409, "This import was already rejected or discarded."],
    unauthorized: [401, "Your session ended. Sign in and try again."],
  };
  const [status, text] = why[r.error] ?? [403, `The database refused to ${apply ? "apply" : "reject"} this import (${r.error}), so nothing changed.`];
  ctx.setFlash(withRef(status, db, text), "danger");
  return { redirect: importPath(v.id, importId) };
}
