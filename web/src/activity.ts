// Activity: the append-only log, filterable by person, agent, action, path
// and date, newest first, a page at a time. One renderer serves the account
// page (/activity, every vault you're in), a vault's Activity page, and a
// file's History tab.
//
// Reads run as the signed-in person; the log's RLS policy only returns rows
// from vaults they're a member of, and the query also joins their
// memberships. Only log columns that say who did what where are shown: never
// `detail`, file text or anything a variable holds.

import type pg from "pg";
import { html, raw, when, type Raw } from "./html.js";
import { personRef } from "./personref.js";

export const PAGE_SIZE = 50;

const EVENTS: [string, string][] = [
  ["file.write", "Wrote"],
  ["file.delete", "Deleted"],
  ["file.erase", "Erased"],
  ["proposal.open", "Proposed"],
  ["proposal.approve", "Approved"],
  ["proposal.request_changes", "Requested changes"],
  ["proposal.reject", "Rejected"],
  ["proposal.revise", "Revised a proposal"],
  ["proposal.edit", "Edited a proposal"],
  ["proposal.stale", "Went stale"],
  ["policy.set", "Changed a rule"],
  ["member.set", "Changed members"],
  ["member.leave", "Left the vault"],
  ["invite.create", "Invited someone"],
  ["invite.accept", "Joined by invite"],
  ["invite.revoke", "Withdrew an invite"],
  ["member.connection_revoke", "Cut off a member’s connection"],
  ["vault.create", "Created the vault"],
  ["vault.rename", "Renamed the vault"],
  ["vault.default_policy", "Changed the default policy"],
  ["vault.export", "Exported the vault"],
];
const GROUPS: [string, string][] = [
  ["file.", "Any file change"],
  ["proposal.", "Any proposal event"],
];
const LABEL = new Map(EVENTS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export type Filters = {
  vault?: string; // account page only
  who?: string; // a person's id
  agent?: string; // "people", "agents", or "name:<agent>"
  action?: string; // an event, or a group ending in "."
  path?: string; // path prefix
  from?: string; // YYYY-MM-DD, UTC, inclusive
  to?: string; // YYYY-MM-DD, UTC, inclusive
  before?: string; // keyset cursor: log seq
};

// Only well-formed values survive; anything else is ignored, not an error.
export function parseFilters(p: URLSearchParams): Filters {
  const f: Filters = {};
  const v = (k: string) => (p.get(k) ?? "").trim();
  if (UUID.test(v("vault"))) f.vault = v("vault");
  if (UUID.test(v("who"))) f.who = v("who");
  const agent = v("agent");
  if (agent === "people" || agent === "agents" || (agent.startsWith("name:") && agent.length > 5)) f.agent = agent;
  if (LABEL.has(v("action")) || GROUPS.some(([g]) => g === v("action"))) f.action = v("action");
  if (v("path")) f.path = v("path").replace(/^\/+/, "").slice(0, 500);
  if (validDay(v("from"))) f.from = v("from");
  if (validDay(v("to"))) f.to = v("to");
  if (/^\d{1,18}$/.test(v("before"))) f.before = v("before");
  return f;
}

export type Scope = { vaultId?: string; file?: string };

type Row = {
  seq: string;
  vault_id: string;
  vault: string;
  at: Date;
  actor: string | null;
  agent: string | null;
  event: string;
  path: string | null;
  proposal_id: string | null;
};

// One page of events, newest first. Keyset on seq, which increases with
// every insert, so pages never skip or repeat rows as new events arrive.
export async function queryActivity(
  c: pg.PoolClient,
  me: string,
  scope: Scope,
  f: Filters,
  limit = PAGE_SIZE,
): Promise<{ rows: Row[]; next?: string }> {
  const params: unknown[] = [me];
  const where: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  const vaultId = scope.vaultId ?? f.vault;
  if (vaultId) add("l.vault_id = $?::uuid", vaultId);
  if (scope.file) add("l.path = $?", scope.file);
  if (f.who) add("l.actor = $?::uuid", f.who);
  if (f.agent === "people") where.push("l.agent is null");
  else if (f.agent === "agents") where.push("l.agent is not null");
  else if (f.agent) add("l.agent = $?", f.agent.slice(5));
  if (f.action?.endsWith(".")) add("starts_with(l.event, $?)", f.action);
  else if (f.action) add("l.event = $?", f.action);
  if (f.path && !scope.file) add("starts_with(l.path, $?)", f.path);
  if (f.from) add("l.at >= ($?::date)::timestamp at time zone 'UTC'", f.from);
  if (f.to) add("l.at < ($?::date + 1)::timestamp at time zone 'UTC'", f.to);
  if (f.before) add("l.seq < $?::bigint", f.before);
  params.push(limit + 1);
  const { rows } = await c.query(
    `select l.seq::text, l.vault_id, v.name as vault, l.at, l.actor, l.agent, l.event, l.path, l.proposal_id
       from public.log l
       join public.vault_members m on m.vault_id = l.vault_id and m.user_id = $1
       join public.vaults v on v.id = l.vault_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by l.seq desc
      limit $${params.length}`,
    params,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit) as Row[];
  return { rows: page, next: more ? page[page.length - 1].seq : undefined };
}

type Options = { vaults: { id: string; name: string }[]; people: string[]; agents: string[] };

// Choices for the filter form, from the vaults in scope. Agents come from
// recent events only, so this stays cheap on a long log.
async function options(c: pg.PoolClient, me: string, vaultId?: string): Promise<Options> {
  const vaults = (
    await c.query(
      `select v.id, v.name from public.vaults v join public.vault_members m on m.vault_id = v.id and m.user_id = $1
        order by v.name`,
      [me],
    )
  ).rows;
  const ids = vaultId ? [vaultId] : vaults.map((v) => v.id);
  const people = (
    await c.query(
      `select distinct user_id::text from public.vault_members where vault_id = any($1::uuid[]) order by 1`,
      [ids],
    )
  ).rows.map((r) => r.user_id as string);
  const agents = (
    await c.query(
      `select distinct agent from (select agent from public.log where vault_id = any($1::uuid[])
          order by seq desc limit 5000) recent where agent is not null order by agent limit 100`,
      [ids],
    )
  ).rows.map((r) => r.agent as string);
  return { vaults, people, agents };
}

const q = encodeURIComponent;
const who = (me: string, id: string | null, agent: string | null) =>
  `${id === me ? "you" : id ? personRef(id) : "system"}${agent ? ` via ${agent}` : ""}`;
const person = (me: string, id: string) => (id === me ? "You" : personRef(id));

export type ActivityOpts = {
  me: string;
  url: URL;
  base: string; // path the form and pager link to
  keep?: Record<string, string>; // params the base needs (file history: path, tab)
  scope: Scope;
  showVault?: boolean;
};

function filterForm(o: ActivityOpts, f: Filters, opt: Options): Raw {
  const sel = (on: boolean) => (on ? raw(" selected") : "");
  const agentName = f.agent?.startsWith("name:") ? f.agent.slice(5) : undefined;
  const agents = agentName && !opt.agents.includes(agentName) ? [...opt.agents, agentName] : opt.agents;
  const people = f.who && !opt.people.includes(f.who) ? [...opt.people, f.who] : opt.people;
  const active = Object.keys(f).some((k) => k !== "before");
  return html`<form method="get" action="${o.base}" class="panel filters" role="search" aria-label="Filter activity">
    ${Object.entries(o.keep ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <div class="filter-fields">
      ${o.showVault
        ? html`<div><label for="f-vault">Vault</label><select id="f-vault" name="vault"><option value="">All your vaults</option>${opt.vaults.map(
            (v) => html`<option value="${v.id}"${sel(f.vault === v.id)}>${v.name}</option>`,
          )}</select></div>`
        : ""}
      <div><label for="f-who">Person</label><select id="f-who" name="who"><option value="">Anyone</option>${people.map(
        (p) => html`<option value="${p}"${sel(f.who === p)}>${person(o.me, p)}</option>`,
      )}</select></div>
      <div><label for="f-agent">Agent</label><select id="f-agent" name="agent">
        <option value="">People and agents</option>
        <option value="people"${sel(f.agent === "people")}>People only</option>
        <option value="agents"${sel(f.agent === "agents")}>Agents only</option>
        ${agents.map((a) => html`<option value="name:${a}"${sel(agentName === a)}>${a}</option>`)}
      </select></div>
      <div><label for="f-action">Action</label><select id="f-action" name="action"><option value="">Any action</option>
        ${GROUPS.map(([g, l]) => html`<option value="${g}"${sel(f.action === g)}>${l}</option>`)}
        ${EVENTS.map(([e, l]) => html`<option value="${e}"${sel(f.action === e)}>${l}</option>`)}
      </select></div>
      ${o.scope.file
        ? ""
        : html`<div><label for="f-path">Path starts with</label><input id="f-path" type="text" name="path" value="${f.path ?? ""}" placeholder="clients/"></div>`}
      <div><label for="f-from">From</label><input id="f-from" type="date" name="from" value="${f.from ?? ""}"></div>
      <div><label for="f-to">To</label><input id="f-to" type="date" name="to" value="${f.to ?? ""}"></div>
    </div>
    <div class="actions"><button>Filter</button>${active ? html`<a class="button quiet" href="${link(o, {})}">Clear filters</a>` : ""}</div>
  </form>`;
}

// A link to this view with the given filters (and the params the base keeps).
function link(o: ActivityOpts, f: Filters): string {
  const p = new URLSearchParams(o.keep ?? {});
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${o.base}?${s}` : o.base;
}

export function activityTable(o: ActivityOpts, rows: Row[]): Raw {
  const fileLink = (r: Row) => `/v/${r.vault_id}/file?path=${q(r.path ?? "")}`;
  return html`<div class="table-wrap"><table class="activity">
    <tr><th class="num hide-sm">#</th><th>When</th><th>What</th>${o.showVault ? html`<th>Vault</th>` : ""}${o.scope.file ? "" : html`<th>Path</th>`}<th>By</th></tr>
    ${rows.map(
      (r) => html`<tr class="ev"><td class="num small muted hide-sm">${r.seq}</td><td class="small nowrap">${when(r.at)}</td>
        <td class="small">${r.proposal_id ? html`<a href="/v/${r.vault_id}/proposals/${r.proposal_id}">${LABEL.get(r.event) ?? r.event}</a>` : LABEL.get(r.event) ?? r.event}</td>
        ${o.showVault ? html`<td class="small"><a href="/v/${r.vault_id}/activity">${r.vault}</a></td>` : ""}
        ${o.scope.file ? "" : html`<td class="path-cell">${r.path && r.event === "file.write" ? html`<a href="${fileLink(r)}">${r.path}</a>` : r.path ?? ""}</td>`}
        <td class="small">${who(o.me, r.actor, r.agent)}</td></tr>`,
    )}</table></div>`;
}

// Filter form, the table, and the pager: the body of any activity view.
export async function activityBody(c: pg.PoolClient, o: ActivityOpts): Promise<Raw> {
  const f = parseFilters(o.url.searchParams);
  if (o.scope.vaultId) delete f.vault;
  if (o.scope.file) delete f.path;
  const opt = await options(c, o.me, o.scope.vaultId);
  const { rows, next } = await queryActivity(c, o.me, o.scope, f);
  const { before: _before, ...current } = f;
  return html`${filterForm(o, f, opt)}
    ${rows.length
      ? activityTable(o, rows)
      : html`<div class="empty">${f.before ? "No older events." : Object.keys(current).length ? "Nothing matches these filters." : "Nothing has happened here yet."}</div>`}
    ${next || f.before
      ? html`<nav class="pager" aria-label="Pages">${f.before ? html`<a href="${link(o, current)}">Newest</a>` : ""}${
          next ? html`<a class="older" href="${link(o, { ...current, before: next })}">Older</a>` : ""
        }</nav>`
      : ""}`;
}
