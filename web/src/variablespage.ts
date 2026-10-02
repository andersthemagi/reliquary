// The Variables page (docs/variables.md, "Web: the Variables page"). Names,
// environments and who set what, for every member; set, rotate, delete and
// reveal for people whose role allows it; and the vault's access log. Every
// call goes through src/variables.ts as the signed-in person, and the
// database decides: this page only chooses what to offer.
//
// Four tabs under one header: Values (values.ts), Environments
// (environments.ts, owners), Access log (accesslog.ts) and Imports
// (imports.ts, owners and editors, with the imports waiting as a count).
// One word for a .env brought in at once: an import, pasted in the web app
// or sent from the CLI with `reliquary env push` ("an import from the CLI").
//
// This file holds what all four share: the vault frame and page shell
// (shell, theVault), the breadcrumbs and tab bar (crumbs, sectionHeader,
// sectionTabs), the role rules (writes, readsLog), small formatting helpers
// (base, q, plural, client, OWNERS_ONLY_HELP) and the name/environment
// patterns (NAME, ENV) every section validates against -- plus
// variablesRoutes, which composes the four into the page's routes. Each
// section's own logic lives in its own file; see values.ts's header for the
// plaintext-handling note that governs the set form and the reveal
// response.

import { asPerson } from "./db.js";
import { NAME } from "./dotenv.js";
import { html, page, pageHeader, plural, type CrumbPart, type Raw, type Tab } from "./html.js";
import { notFound, UUID, vault, vaultPath, type Ctx, type Reply, type Vault } from "./pages.js";
import { vaultShell } from "./files.js";
import { pendingPushes, type Environment } from "./variables.js";
import { confirmDelete, list, remove, reveal, saveVariable, setForm } from "./values.js";
import {
  createEnvironmentPost,
  deleteEnvPage,
  deleteEnvPost,
  environmentsPage,
  renamePage,
  renamePost,
} from "./environments.js";
import { log } from "./accesslog.js";
import { decideImport, importForm, importPost, importsPage, reviewImport } from "./imports.js";

export { NAME };
export const ENV = /^[a-z][a-z0-9_-]{0,31}$/;

export const q = encodeURIComponent;
export const base = (id: string, rest = "") => vaultPath(id, `/variables${rest}`);
export { plural };

// Who may do what with values, as the database decides it (docs/variables.md,
// "What holds"): owners everywhere, editors outside owners-only environments.
export const writes = (role: string, e: Environment) => role === "owner" || (role === "editor" && !e.ownersOnly);
export const readsLog = (role: string) => role === "owner" || role === "editor";
export const OWNERS_ONLY_HELP = "Only owners set, reveal or read values here";

// The client a log row came from: the web UI (a person in person), the CLI,
// or an agent's token.
export function client(r: { agent: string | null }): string {
  if (!r.agent) return "web UI";
  if (r.agent === "Reliquary CLI") return "CLI";
  return r.agent;
}

// A page in the vault frame. `path` is where the theme switch comes back to,
// so a POST's response page (a reveal, a refused form) never sends it to a
// POST-only route.
export async function shell(ctx: Ctx, v: Vault, title: string, body: Raw, status = 200, path?: string): Promise<Reply> {
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

export const theVault = (ctx: Ctx, id: string) => asPerson(ctx.userId, (c) => vault(c, ctx, id));

// Breadcrumbs: the vault, then Variables. On the four tab pages Variables is
// the last crumb (the tab says which); below them, it links back.
export const crumbs = (v: Vault, ...here: CrumbPart[]): CrumbPart[] =>
  here.length
    ? [{ label: v.name, href: vaultPath(v.id) }, { label: "Variables", href: base(v.id) }, ...here]
    : [{ label: v.name, href: vaultPath(v.id) }, { label: "Variables" }];

// The tabs a role gets: Values for everyone, Environments for owners, Access
// log and Imports for owners and editors (with the imports waiting as a
// count). A viewer gets Values alone, so no tabs.
type Section = "values" | "environments" | "log" | "imports";
function sectionTabs(v: Vault, current: Section, waiting: number): Tab[] {
  const t: Tab[] = [{ href: base(v.id), label: "Values", current: current === "values" }];
  if (v.role === "owner") t.push({ href: base(v.id, "/environments"), label: "Environments", current: current === "environments" });
  if (readsLog(v.role)) {
    t.push({ href: base(v.id, "/log"), label: "Access log", current: current === "log" });
    t.push({ href: base(v.id, "/imports"), label: "Imports", current: current === "imports", ...(waiting ? { count: waiting } : {}) });
  }
  return t.length > 1 ? t : [];
}

// A refused form's reason, above the form: the danger callout as one
// paragraph, read out at once.
export const refusal = (why: Raw | string) => html`<p class="callout danger" role="alert">${why}</p>`;

// The imports from the CLI waiting in this vault, for the Imports tab's
// count (owners and editors see them; others get none).
export const waitingIn = (ctx: Ctx, v: Vault) => (readsLog(v.role) ? pendingPushes(ctx.userId, v.id) : Promise.resolve([]));

export function sectionHeader(v: Vault, current: Section, waiting: number, o: { description?: Raw | string; secondary?: Raw | ""; primary?: Raw | "" } = {}): Raw {
  return pageHeader({ crumb: crumbs(v), title: "Variables", tabs: sectionTabs(v, current, waiting), tabsLabel: "Variables", ...o });
}

// ---------------------------------------------------------------------------

export async function variablesRoutes(ctx: Ctx, id: string, rest: string): Promise<Reply> {
  if (!UUID.test(id)) return notFound(ctx);
  const get = ctx.method === "GET";
  if (get && rest === "/variables") return list(ctx, id);
  if (get && rest === "/variables/log") return log(ctx, id);
  if (get && rest === "/variables/imports") return importsPage(ctx, id);
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
