// Activity: the append-only log, filterable by person, agent, action, path
// and date, newest first, a page at a time. One renderer serves the account
// page (/activity, every vault you're in), a vault's Activity page, and a
// file's History tab.
//
// Reads run as the signed-in person; the log's RLS policy only returns rows
// from vaults they're a member of, and the query also joins their
// memberships. Only log columns that say who did what where are shown, and
// from `detail` only the member and role of member and invite events (never
// anything else in it, never file text or anything a variable holds).
//
// The page is a filter bar (collapsed, with the filters in use as chips that
// each remove themselves), then the events as a table that becomes a
// two-line list on phones (style.css, "Package E: activity").

import type pg from "pg";
import { emptyState, html, raw, time, type Raw } from "./html.js";
import { personRef } from "./personref.js";

export const PAGE_SIZE = 50;

// Every event the database writes to the log, in plain words, and a filter
// choice for each. web/test/activity_labels.test.mjs reads the migrations
// and the log, and fails on an event missing here.
export const EVENT_LABELS: readonly [string, string][] = [
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
  ["proposal.comment", "Commented on a proposal"],
  ["policy.set", "Changed a rule"],
  ["member.set", "Changed members"],
  ["member.leave", "Left the vault"],
  ["invite.create", "Invited someone"],
  ["invite.accept", "Joined by invite"],
  ["invite.revoke", "Withdrew an invite"],
  ["invite.decline", "Declined an invite"],
  ["member.connection_revoke", "Cut off a member’s connection"],
  ["vault.create", "Created the vault"],
  ["vault.rename", "Renamed the vault"],
  ["vault.default_policy", "Changed the default policy"],
  ["vault.export", "Exported the vault"],
  ["variable.set", "Set a variable"],
  ["variable.rotate", "Rotated a variable"],
  ["variable.delete", "Deleted a variable"],
  ["environment.create", "Added an environment"],
  ["environment.rename", "Renamed an environment"],
  ["environment.delete", "Deleted an environment"],
  ["link.create", "Added a link"],
  ["link.update", "Edited a link"],
  ["link.delete", "Deleted a link"],
  ["link.grant", "Changed a link’s tool grants"],
  ["path_owner.add", "Named a path’s owner"],
  ["path_owner.remove", "Removed a path’s owner"],
  ["claim.grant", "Claimed a path"],
  ["claim.renew", "Renewed a claim"],
  ["claim.release", "Released a claim"],
  ["claim.break", "Broke a claim"],
  ["claim_rule.set", "Changed a claim rule"],
  ["work_plan.register", "Registered a work plan"],
  ["step.claim", "Claimed a step"],
  ["step.complete", "Completed a step"],
  ["step.release", "Released a step"],
  ["step.cancel", "Cancelled a step"],
  ["step.skip", "Skipped a step"],
];
export const EVENT_GROUPS: readonly [string, string][] = [
  ["file.", "Any file change"],
  ["proposal.", "Any proposal event"],
  ["variable.", "Any variable change"],
  ["link.", "Any link change"],
  ["claim.", "Any claim event"],
  ["step.", "Any work plan step event"],
];
const EVENTS = EVENT_LABELS;
const GROUPS = EVENT_GROUPS;
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
  // Member and invite events only, from `detail`: whom it was about, their
  // role (null when a member was removed), and whether a role was recorded.
  subject?: string | null;
  role?: string | null;
  has_role?: boolean | null;
};

// The events whose `detail` names a member or a role; nothing else is read
// from `detail`.
const MEMBER_EVENTS = ["member.set", "member.leave", "member.connection_revoke", "invite.create", "invite.accept", "invite.decline"];

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
    `select l.seq::text, l.vault_id, v.name as vault, l.at, l.actor, l.agent, l.event, l.path, l.proposal_id,
            case when l.event = any($${params.length + 1}::text[]) then l.detail->>'user' end as subject,
            case when l.event = any($${params.length + 1}::text[]) then l.detail->>'role' end as role,
            case when l.event = any($${params.length + 1}::text[]) then l.detail ? 'role' end as has_role
       from public.log l
       join public.vault_members m on m.vault_id = l.vault_id and m.user_id = $1
       join public.vaults v on v.id = l.vault_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by l.seq desc
      limit $${params.length}`,
    [...params, MEMBER_EVENTS],
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

// A role as it reads after "as" or "made someone": "an editor".
const ROLE: Record<string, string> = { owner: "an owner", editor: "an editor", viewer: "a viewer" };

// What happened, in plain words. Member and invite events say whom and which
// role when the log recorded it ("Made cy@example.test an editor"); every
// other event, and any row without that detail, is its label.
export function describe(me: string, r: Pick<Row, "event" | "subject" | "role" | "has_role">): string {
  const label = LABEL.get(r.event) ?? r.event;
  const subject = r.subject && UUID.test(r.subject) ? (r.subject === me ? "you" : personRef(r.subject)) : undefined;
  const role = r.role ? ROLE[r.role] : undefined;
  switch (r.event) {
    case "member.set":
      if (subject && role) return `Made ${subject} ${role}`;
      if (subject && r.has_role && r.role === null) return `Removed ${subject} from the vault`;
      break;
    case "member.connection_revoke":
      if (subject) return subject === "you" ? "Cut off your connection" : `Cut off ${subject}’s connection`;
      break;
    case "invite.create":
      if (role) return `Invited someone as ${role}`;
      break;
    case "invite.accept":
      if (role) return `Joined by invite as ${role}`;
      break;
    case "invite.decline":
      if (role) return `Declined an invite as ${role}`;
      break;
  }
  return label;
}

export type ActivityOpts = {
  me: string;
  url: URL;
  base: string; // path the form and pager link to
  keep?: Record<string, string>; // params the base needs (file history: path, tab)
  scope: Scope;
  showVault?: boolean;
};

type Chip = { key: keyof Filters; label: string; value: string };

// The filters in use, each as a chip that names it ("Agent: Hermes on
// Linux"). Values come from the parsed filters, so only well-formed ones.
function chips(o: ActivityOpts, f: Filters, opt: Options): Chip[] {
  const out: Chip[] = [];
  if (f.vault && o.showVault) out.push({ key: "vault", label: "Vault", value: opt.vaults.find((v) => v.id === f.vault)?.name ?? "a vault you’re not in" });
  if (f.who) out.push({ key: "who", label: "Person", value: person(o.me, f.who) });
  if (f.agent)
    out.push({
      key: "agent",
      label: "Agent",
      value: f.agent === "people" ? "People only" : f.agent === "agents" ? "Agents only" : f.agent.slice(5),
    });
  if (f.action) out.push({ key: "action", label: "Action", value: LABEL.get(f.action) ?? GROUPS.find(([g]) => g === f.action)?.[1] ?? f.action });
  if (f.path && !o.scope.file) out.push({ key: "path", label: "Path", value: f.path });
  if (f.from) out.push({ key: "from", label: "From", value: f.from });
  if (f.to) out.push({ key: "to", label: "To", value: f.to });
  return out;
}

// The filter bar: a "Filters" button that opens the form, then the filters
// in use as chips (each a link to this view without it) and Clear filters.
// Closed by default, so the events follow the page header; open when the
// filters match nothing, to change them.
function filterBar(o: ActivityOpts, f: Filters, opt: Options, open: boolean): Raw {
  const sel = (on: boolean) => (on ? raw(" selected") : "");
  const agentName = f.agent?.startsWith("name:") ? f.agent.slice(5) : undefined;
  const agents = agentName && !opt.agents.includes(agentName) ? [...opt.agents, agentName] : opt.agents;
  const people = f.who && !opt.people.includes(f.who) ? [...opt.people, f.who] : opt.people;
  const { before: _before, ...current } = f;
  const inUse = chips(o, f, opt);
  const without = (k: keyof Filters): string => {
    const rest: Filters = { ...current };
    delete rest[k];
    return link(o, rest);
  };
  return html`<div class="activity-filters">
    <details class="activity-filter-panel"${open ? raw(" open") : ""}>
      <summary class="button">Filters${inUse.length ? html`<span class="count" aria-label="${inUse.length} in use">${inUse.length}</span>` : ""}</summary>
      <form method="get" action="${o.base}" class="panel filters" role="search" aria-label="Filter activity">
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
        <div class="actions"><button class="primary">Apply filters</button></div>
      </form>
    </details>
    ${inUse.length
      ? html`<ul class="filter-chips" aria-label="Filters in use">${inUse.map(
          (c) =>
            html`<li><a class="filter-chip" href="${without(c.key)}" title="Remove this filter" aria-label="Remove filter ${c.label}: ${c.value}"><span class="filter-chip-key">${c.label}:</span> ${c.value}<span class="filter-chip-x" aria-hidden="true">×</span></a></li>`,
        )}</ul>
        <a class="button quiet" href="${link(o, {})}">Clear filters</a>`
      : ""}
  </div>`;
}

// A link to this view with the given filters (and the params the base keeps).
function link(o: ActivityOpts, f: Filters): string {
  const p = new URLSearchParams(o.keep ?? {});
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${o.base}?${s}` : o.base;
}

// The events: a table on wide screens; below 640px each row is two lines,
// what and when, then who, vault and path (style.css). Each row's id is its
// place in the log ("ev-123"), for linking.
export function activityTable(o: ActivityOpts, rows: Row[]): Raw {
  const fileLink = (r: Row) => `/v/${r.vault_id}/file?path=${q(r.path ?? "")}`;
  return html`<div class="table-wrap activity-wrap"><table class="activity">
    <thead><tr><th>When</th><th>What</th>${o.showVault ? html`<th>Vault</th>` : ""}${o.scope.file ? "" : html`<th>Path</th>`}<th>By</th></tr></thead>
    <tbody>${rows.map((r) => {
      const what = describe(o.me, r);
      return html`<tr class="ev" id="ev-${r.seq}"><td class="small nowrap ev-when">${time(r.at)}</td>
        <td class="small ev-what">${r.proposal_id ? html`<a href="/v/${r.vault_id}/proposals/${r.proposal_id}">${what}</a>` : what}</td>
        ${o.showVault ? html`<td class="small ev-vault"><a href="/v/${r.vault_id}/activity">${r.vault}</a></td>` : ""}
        ${o.scope.file ? "" : html`<td class="path-cell">${r.path && r.event === "file.write" ? html`<a href="${fileLink(r)}">${r.path}</a>` : r.path ?? ""}</td>`}
        <td class="small">${who(o.me, r.actor, r.agent)}</td></tr>`;
    })}</tbody></table></div>`;
}

// What an empty page says: past the last page, filtered to nothing, or a
// log with nothing in it yet, each with the way on.
function empty(o: ActivityOpts, f: Filters, filtered: boolean): Raw {
  const { before: _before, ...current } = f;
  if (f.before)
    return emptyState({
      title: "No older events",
      body: "This is where the log begins for these filters.",
      action: html`<a class="button" href="${link(o, current)}">Back to the newest</a>`,
    });
  if (filtered)
    return emptyState({
      title: "Nothing matches these filters",
      body: `No event${o.scope.file ? " on this file" : ""} matches all of them. Remove a filter above, widen the dates, or clear them all.`,
      action: html`<a class="button" href="${link(o, {})}">Clear filters</a>`,
    });
  return emptyState({
    title: "Nothing has happened here yet",
    body: o.scope.file
      ? "Writes, proposals and decisions on this file show here as they happen."
      : "Files written, proposals and decisions, rule and member changes show here as they happen, newest first.",
  });
}

// Filter bar, the events, and the pager: the body of any activity view.
export async function activityBody(c: pg.PoolClient, o: ActivityOpts): Promise<Raw> {
  const f = parseFilters(o.url.searchParams);
  if (o.scope.vaultId) delete f.vault;
  if (o.scope.file) delete f.path;
  const opt = await options(c, o.me, o.scope.vaultId);
  const { rows, next } = await queryActivity(c, o.me, o.scope, f);
  const { before: _before, ...current } = f;
  const filtered = Object.keys(current).length > 0;
  return html`${filterBar(o, f, opt, filtered && !rows.length)}
    ${rows.length ? activityTable(o, rows) : empty(o, f, filtered)}
    ${next || (f.before && rows.length)
      ? html`<nav class="pager" aria-label="Pages">${f.before ? html`<a href="${link(o, current)}">Newest</a>` : ""}${
          next ? html`<a class="older" href="${link(o, { ...current, before: next })}">Older</a>` : ""
        }</nav>`
      : ""}`;
}
