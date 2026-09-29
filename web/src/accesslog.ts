// The Access log tab of the Variables page (docs/variables.md, "Web: the
// Variables page"): who set, rotated, deleted, read or revealed which
// variables, and refused attempts, newest first, filterable by action and
// name. Split out of variablespage.ts, which keeps the shared page chrome
// (tabs, breadcrumbs, the vault frame).

import { emptyState, html, raw, time, type Raw } from "./html.js";
import { notFound, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { accessLog, type AccessLogRow } from "./variables.js";
import { base, client, NAME, readsLog, sectionHeader, shell, theVault, waitingIn } from "./variablespage.js";

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
  push: "Import sent from the CLI",
  reject: "Import rejected",
  rotate_key: "Re-encrypted (key rotation)",
  create_environment: "Environment added",
  rename_environment: "Environment renamed",
  delete_environment: "Environment deleted",
};
const LOG_PAGE = 50;

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

// An empty cell: a dash, read out as "none".
const NONE = raw('<span class="muted" aria-label="none">—</span>');

export async function log(ctx: Ctx, id: string): Promise<Reply> {
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
  const pushes = await waitingIn(ctx, v);
  let table: Raw;
  if (!readsLog(v.role)) {
    table = emptyState({ title: "Only owners and editors can see this vault’s access log." });
  } else {
    const rows = await accessLog(ctx.userId, id, { before, limit: LOG_PAGE + 1, action, name });
    const more = rows.length > LOG_PAGE;
    const shown = rows.slice(0, LOG_PAGE);
    table = html`${logFilters(ctx, id, action, name)}
      ${shown.length
        ? html`<div class="table-wrap"><table class="table-stack env-log">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Variables</th><th>Environment</th></tr></thead>
          <tbody>${shown.map(
            (r) => html`<tr${r.action === "refused" ? raw(' class="refused"') : ""}><td class="small" data-label="When"><div>${time(r.at)}</div></td>
              <td class="small" data-label="Who"><div>${who(ctx, r.actor, null)} <span class="muted">· ${client(r)}</span></div></td>
              <td class="small" data-label="What"><div>${r.action === "refused"
                ? html`<span class="badge danger">Refused</span> <span class="muted">${detail(r)}</span>`
                : html`${ACTION_LABEL[r.action] ?? r.action}${detail(r) ? html` <span class="muted">${detail(r)}</span>` : ""}`}</div></td>
              <td class="small path-cell" data-label="Variables"><div>${r.names.length ? r.names.map((n, i) => html`${i ? ", " : ""}<code>${n}</code>`) : NONE}</div></td>
              <td class="small" data-label="Environment"><div>${r.environment ? r.environment : NONE}</div></td></tr>`,
          )}</tbody></table></div>`
        : emptyState({ title: before ? "No older entries." : action || name ? "Nothing matches these filters." : "Nothing has been set, read or revealed yet." })}
      ${more || before
        ? html`<nav class="pager" aria-label="Pages">${before ? html`<a href="${link({})}">Newest</a>` : ""}${
            more ? html`<a class="older" href="${link({ before: shown[shown.length - 1].seq })}">Older</a>` : ""
          }</nav>`
        : ""}`;
  }
  const body = html`
    ${sectionHeader(v, "log", pushes.length, {
      description: "Who set, rotated, deleted, read or revealed which variables, and refused attempts, newest first. It never holds a value, and nothing in it is edited or deleted.",
    })}
    ${table}`;
  return shell(ctx, v, "Access log · Variables", body);
}
