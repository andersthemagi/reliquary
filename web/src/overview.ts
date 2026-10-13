// A vault's Overview, the page /v/:id opens on (issue #261): what is waiting
// on the reader, what is being worked on and by whom, what changed lately and
// who is here, each a card linking to its full page, then the root README.
// Built only from what the other pages already read (owner, 2026-10-13: no
// generated summary), as the signed-in person, so RLS decides what shows.
// Nothing here marks a flag shown: the count reads list_flags without
// advance_flags, so only the Flags page itself clears it.

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, html, pageHeader, plural, raw, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { recentChanges } from "./changes.js";
import { flagsPath } from "./flagspage.js";
import { planPath, tasksPath } from "./tasks.js";
import { renderMarkdown } from "./markdown.js";
import { filePath, notFound, proposalPath, render, vault, vaultPath, WAITING_SQL, who, writablePath, type Ctx, type Reply, type Vault } from "./pages.js";

// A first-run step, not a status: a writer of a young vault who has no
// connection of any kind yet. The age bound is the dismiss, so someone who
// never connects an agent isn't pointed at Connect on every visit, forever.
const NUDGE_DAYS = 14;
const CONNECT_NUDGE = callout(
  "info",
  html`<p>Your agents read and propose to your vaults once they’re connected. It takes about a minute.</p>
    <p class="callout-actions"><a class="button primary" href="/connect">Connect an agent</a></p>`,
  { title: "Next: connect an agent" },
);

// How many rows a card lists before its See all link is the way on.
const ROWS = 5;
const FLAG_LIMIT = 200;
const ROLES = ["owner", "editor", "viewer"];

type Waiting = { id: string; path: string; kind: string; current_body: string | null; proposed_by: string; agent: string | null; created_at: Date };
type Held = { title: string; plan: string; holder: string; agent: string | null };
type Facts = {
  waiting: Waiting[];
  waiting_n: number;
  flags: number;
  flags_more: boolean;
  ready: number;
  roles: Record<string, number>;
  connections: number;
  connected: boolean;
  young: boolean;
  readme_path: string | null;
  readme: string | null;
};

// Everything but the tasks and the changes in one round trip. Owners count
// the connections every member has to the vault (member_connections, which
// refuses anyone else); everyone else counts their own.
async function facts(c: pg.PoolClient, ctx: Ctx, v: Vault): Promise<Facts> {
  const connections =
    v.role === "owner"
      ? `(select count(*) from public.member_connections($2))::int`
      : `(select count(*) from public.access_tokens t
           where t.revoked_at is null and t.expires_at > now() and (t.all_vaults or $2 = any(t.vault_ids)))::int`;
  return (
    await c.query(
      `with w as (select q.id, q.path, q.kind, q.current_body, q.proposed_by, q.agent, q.created_at
                    from (${WAITING_SQL}) q where q.vault_id = $2),
            fl as (select public.list_flags($2, ${FLAG_LIMIT}) as r),
            readme as (select f.path, fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id
                        where f.vault_id = $2 and f.deleted_at is null and lower(f.path) = 'readme.md' limit 1)
       select coalesce((select json_agg(x order by x.created_at) from (select * from w order by w.created_at limit ${ROWS}) x), '[]') as waiting,
              (select count(*) from w)::int as waiting_n,
              (select jsonb_array_length(fl.r -> 'flags') from fl) as flags,
              (select (fl.r ->> 'more')::boolean from fl) as flags_more,
              (select coalesce(sum(l.o_ready), 0) from public.list_work_plans($2) l)::int as ready,
              (select coalesce(json_object_agg(role, n), '{}') from (select role, count(*)::int as n from public.list_members($2) group by role) r) as roles,
              ${connections} as connections,
              exists(select 1 from public.access_tokens) as connected,
              (select v.created_at > now() - interval '${NUDGE_DAYS} days' from public.vaults v where v.id = $2) as young,
              (select path from readme) as readme_path, (select body from readme) as readme`,
      [ctx.userId, v.id],
    )
  ).rows[0];
}

// The tasks someone holds right now, across every plan, with the agent that
// took each one (the log's step.claim, as tasks.ts reads it).
async function held(c: pg.PoolClient, id: string): Promise<Held[]> {
  return (
    await c.query(
      `select st.o_title as title, p.path as plan, s.holder,
              (select l.agent from public.log l
                where l.vault_id = $1 and l.path = p.path and l.event = 'step.claim'
                  and l.detail ->> 'step' = s.key and l.actor = s.holder
                order by l.seq desc limit 1) as agent
         from public.work_plans p
         cross join lateral public.work_plan_status($1, p.path) st
         join public.work_plan_steps s on s.plan_id = p.id and s.key = st.o_key
        where p.vault_id = $1 and st.o_state = 'claimed'
        order by p.path, s.id`,
      [id],
    )
  ).rows;
}

// One card: its title, a See all link to the full page, then its body.
function card(title: string, href: string, body: Raw): Raw {
  return html`<li class="card overview-card">
    <div class="card-head"><h2 class="card-title">${title}</h2><a class="see-all" href="${href}" aria-label="See all: ${title}">See all</a></div>
    ${body}
  </li>`;
}

const verb = (p: Waiting) => (p.kind === "delete" ? "Delete" : p.current_body === null ? "Create" : "Change");

export async function overview(ctx: Ctx, id: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const f = await facts(c, ctx, v);
    const tasks = await held(c, id);
    const changes = await recentChanges(c, ctx, id, ROWS);
    const writer = await writablePath(c, v, "");

    const quiet = (line: string) => html`<p class="muted">${line}</p>`;
    const waiting = html`${f.waiting.length
      ? html`<ul class="card-list">${f.waiting.map(
          (p) => html`<li><a href="${proposalPath(id, p.id)}">${verb(p)} ${p.path}</a> <span class="muted">· ${who(ctx, p.proposed_by, p.agent)} · ${time(p.created_at)}</span></li>`,
        )}</ul>${f.waiting_n > f.waiting.length ? html`<p class="small muted">and ${f.waiting_n - f.waiting.length} more</p>` : ""}`
      : f.flags ? "" : quiet("Nothing is waiting on you.")}${f.flags ? html`<p class="small"><a href="${flagsPath(id)}">${f.flags_more ? "More than " : ""}${plural(f.flags, "unread flag")}</a></p>` : ""}`;
    const progress = html`${tasks.length
      ? html`<ul class="card-list">${tasks.slice(0, ROWS).map(
          (t) => html`<li><a href="${planPath(id, t.plan)}">${t.title}</a> <span class="chip task-holder">${who(ctx, t.holder, t.agent)}</span></li>`,
        )}</ul>${tasks.length > ROWS ? html`<p class="small muted">and ${tasks.length - ROWS} more</p>` : ""}`
      : quiet("Nobody is working on a task.")}${f.ready ? html`<p class="small">${plural(f.ready, "task")} ready to pick up</p>` : ""}`;
    const members = Object.values(f.roles).reduce((a, b) => a + b, 0);
    const people = html`<p>${plural(members, "member")}: ${ROLES.filter((r) => f.roles[r]).map((r) => plural(f.roles[r], r)).join(", ")}</p>
      <p class="muted">${v.role === "owner" ? `${plural(f.connections, "agent connection")} to this vault` : `Your agents: ${plural(f.connections, "connection")} to this vault`}</p>`;

    const body = html`
      ${pageHeader({
        title: v.name,
        // On phones the sidebar's search box is hidden: the header offers it.
        // Connect an agent stays in the header even while the first-run step
        // shows (owner, 2026-10-13): the header is where people look for it.
        secondary: html`<a class="button vault-search-link" href="${vaultPath(id, "/search")}">Search</a> <a class="button" href="/connect">Connect an agent</a>`,
        primary: writer ? html`<a class="button primary" href="${vaultPath(id, "/new")}">New file</a>` : "",
      })}
      ${writer && f.young && !f.connected ? CONNECT_NUDGE : ""}
      <ul class="card-grid overview-grid">
        ${card("Waiting on you", vaultPath(id, "/proposals"), waiting)}
        ${card("Tasks in progress", tasksPath(id), progress)}
        ${card("Recent changes", vaultPath(id, "/changes"), changes ?? quiet("Nothing has changed yet."))}
        ${card("People", vaultPath(id, "/config/members"), people)}
      </ul>
      ${f.readme && f.readme_path
        ? html`<section class="readme" aria-label="${f.readme_path}"><p class="readme-head"><a href="${filePath(id, f.readme_path)}">${f.readme_path}</a></p><div class="prose entry">${raw(renderMarkdown(f.readme))}</div></section>`
        : ""}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "overview" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, data.v.name, data.shell, "vaults");
}
