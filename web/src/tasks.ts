// A vault's Tasks page (issue #76; docs/public/concepts/tasks.md): the work
// plans agents are working through, and where each task in them stands. A
// plan is a file with a work_plan block; its steps are what a person sees as
// tasks. SQL and MCP keep the names work_plan and step.
//
// Nothing here works out what ready or blocked means. The plans and their
// counts come from public.list_work_plans, each task's state from
// public.work_plan_status, so this page cannot disagree with what an agent
// is told. The page also decides nothing about access: the tables are
// readable by every member of the vault (RLS), and a person's own actions
// are the database's to allow or refuse.
//
// Cancel, skip, reopen and approve are a person's only: cancel_step,
// skip_step, reopen_step and approve_step are require_human, so an agent is
// refused by the database whatever this page does. Each goes through a
// confirm page, like Break on the Claims page (claimspage.ts): a cancel
// blocks what waits on the task, a skip frees it, a reopen puts back work
// someone dropped, when a new task naming the old one is often the better
// way (the owner's call on issue #76), and an approve passes a review-gated
// task's review (issue #78). The buttons are shown to whoever can write the plan's path,
// which is what the database checks too.
//
//   GET  /v/:id/tasks                          what is open across every plan, then the plans with their progress
//   GET  /v/:id/tasks/plan?path=               one plan: every task, ready or in progress first, then who waits in line
//   GET  /v/:id/tasks/plan?path=&cancel=<key>  confirm cancelling a task
//   GET  /v/:id/tasks/plan?path=&skip=<key>    confirm skipping a task
//   GET  /v/:id/tasks/plan?path=&reopen=<key>  confirm reopening a cancelled task
//   GET  /v/:id/tasks/plan?path=&approve=<key> confirm approving a task awaiting review
//   POST /v/:id/tasks/plan                     action=cancel|skip|reopen|approve, path, key, confirm=1

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, confirmPage, emptyState, html, menu, pageHeader, plural, time, type Raw } from "./html.js";
import { openText } from "./content.js";
import { Refusal } from "./failure.js";
import { filePath, message, notFound, proposalPath, q, render, vault, vaultPath, who, writablePath, type Ctx, type Reply, type Vault } from "./pages.js";
import { vaultShell } from "./files.js";

export const tasksPath = (id: string) => vaultPath(id, "/tasks");
export const planPath = (id: string, path: string) => `${tasksPath(id)}/plan?path=${q(path)}`;

type Plan = {
  path: string;
  title: string | null;
  registered_at: Date;
  registered_by: string;
  file: "unchanged" | "changed" | "deleted";
  ready: number;
  blocked: number;
  claimed: number;
  done: number;
  cancelled: number;
  review: number;
};

type Blocker = { key: string; title: string; status: string };
type Task = {
  plan: string;
  key: string;
  title: string;
  state: "ready" | "blocked" | "blocked_by_cancelled" | "claimed" | "awaiting_review" | "done" | "cancelled";
  status: string;
  holder: string | null;
  agent: string | null;
  holder_label: string | null;
  expires_at: Date | null;
  done_at: Date | null;
  proposal_id: string | null;
  blockers: Blocker[];
  moved: string[];
  due: string | null; // YYYY-MM-DD
  priority: number | null; // 1 (highest) to 4
  notes: string | null;
  for_kind: "agents" | "people" | "member" | null;
  for_member: string | null;
};

// The title is the plan file's first "# " heading as it reads now, from its
// first few KB only: a plan with none, or whose file is gone, goes by its path.
async function loadPlans(c: pg.PoolClient, id: string): Promise<Plan[]> {
  return (
    await c.query(
      `select l.o_path as path, l.o_registered_at as registered_at, l.o_registered_by as registered_by, l.o_file as file,
              l.o_ready as ready, l.o_blocked as blocked, l.o_claimed as claimed, l.o_done as done, l.o_cancelled as cancelled,
              l.o_review as review,
              fv.body
         from public.list_work_plans($1) l
         left join public.files f on f.vault_id = $1 and f.path = l.o_path and f.deleted_at is null
         left join public.file_versions fv on fv.id = f.current_version_id
        order by l.o_path`,
      [id],
    )
  ).rows.map(({ body, ...r }) => ({ ...r, title: /^#[ \t]+(.*[^\s])/m.exec((openText(body, id) ?? "").slice(0, 4000))?.[1] ?? null }));
}

// One round trip, for one plan or (path null) every plan in the vault: the
// state from work_plan_status (the one definition), the holder and finish
// time from the step, the steps blocking it by name, and the agent that took
// it, which only the log's step.claim keeps (claimlookup.ts claimAgents,
// same reasoning: any new holder comes with a new claim).
async function loadTasks(c: pg.PoolClient, id: string, path: string | null): Promise<Task[]> {
  return (
    await c.query(
      `select p.path as plan, st.o_key as key, st.o_title as title, st.o_state as state, s.status, s.holder,
              st.o_holder_label as holder_label, st.o_expires_at as expires_at, s.done_at, st.o_moved as moved, s.proposal_id,
              to_char(st.o_due, 'YYYY-MM-DD') as due, st.o_priority as priority, st.o_notes as notes,
              st.o_for_kind as for_kind, st.o_for_member as for_member,
              coalesce((select json_agg(json_build_object('key', b.key, 'title', b.title, 'status', b.status) order by b.id)
                          from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                         where d.step_id = s.id), '[]') as blockers,
              case when st.o_state = 'claimed' then
                (select l.agent from public.log l
                  where l.vault_id = $1 and l.path = p.path and l.event = 'step.claim'
                    and l.detail ->> 'step' = s.key and l.actor = s.holder
                  order by l.seq desc limit 1) end as agent
         from public.work_plans p
         cross join lateral public.work_plan_status($1, p.path) st
         join public.work_plan_steps s on s.plan_id = p.id and s.key = st.o_key
        where p.vault_id = $1 and ($2::text is null or p.path = $2)
        order by p.path, s.id`,
      [id, path],
    )
  ).rows;
}

// Who waits in the plan's line, first first. The order and "live" are
// request_work's: created_at, id among places that haven't lapsed, so the
// place shown is the one the agent was told. Only these three columns: a
// place's label stays off the page.
type Place = { holder: string; agent: string | null; expires_at: Date };
async function loadLine(c: pg.PoolClient, id: string, path: string): Promise<Place[]> {
  return (
    await c.query(
      `select pl.holder, pl.agent, pl.expires_at
         from public.work_plan_places pl join public.work_plans p on p.id = pl.plan_id
        where p.vault_id = $1 and p.path = $2 and pl.expires_at > now()
        order by pl.created_at, pl.id`,
      [id, path],
    )
  ).rows;
}

// A path typed into a URL, said back only when it's plain (as claimspage.ts does).
const shown = (path: string) => (/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that path");

const total = (p: Plan) => p.ready + p.blocked + p.claimed + p.review + p.done + p.cancelled;

// The words, never only a colour: "2 in progress · 1 ready · 3 blocked".
function counts(p: Plan): string {
  const parts: [number, string][] = [[p.claimed, "in progress"], [p.review, "awaiting review"], [p.ready, "ready"], [p.blocked, "blocked"], [p.cancelled, "cancelled"]];
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(" · ");
}

function fileState(p: Pick<Plan, "file">): Raw {
  if (p.file === "changed") return html`<span class="badge warning">Changed since registered</span>`;
  if (p.file === "deleted") return html`<span class="badge warning">File deleted</span>`;
  return html`<span class="muted">Unchanged</span>`;
}

// A plan as a card: its title (or path), a bar and "6 of 10 done" (the bar
// is a <progress>, since the CSP allows no inline width), the rest in words,
// then the file's state and who registered it.
function planCards(ctx: Ctx, id: string, plans: Plan[]): Raw {
  return html`<ul class="plan-cards">${plans.map(
    (p) => html`<li class="plan-card">
      <h3><a href="${planPath(id, p.path)}">${p.title ?? p.path}</a></h3>
      ${p.title ? html`<p class="path small muted">${p.path}</p>` : ""}
      <progress class="task-progress" max="${Math.max(total(p), 1)}" value="${p.done}" aria-label="${p.done} of ${total(p)} done">${p.done} of ${total(p)} done</progress>
      <p class="small"><strong>${p.done} of ${total(p)} done</strong>${counts(p) ? html` <span class="muted">· ${counts(p)}</span>` : ""}</p>
      <p class="small muted">${fileState(p)} · registered by ${who(ctx, p.registered_by, null)} ${time(p.registered_at)}</p>
    </li>`,
  )}</ul>`;
}

// The page, in the vault shell; or, when it can't be shown, a note for the
// page it sends the person back to (claimspage.ts's build(), same shape).
type Built = { shell: Raw; title: string } | { back: string; note: string; tone: "warning" | "info" } | null;
type Result = { body: Raw; title: string } | { back: string; note: string; tone: "warning" | "info" } | null;

async function build(ctx: Ctx, id: string, fn: (c: pg.PoolClient, v: Vault) => Promise<Result>): Promise<Reply> {
  const out: Built = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const r = await fn(c, v);
    if (!r || "back" in r) return r;
    return { shell: await vaultShell(c, ctx, v, { section: "tasks" }, r.body), title: r.title };
  });
  if (!out) return notFound(ctx);
  if ("back" in out) {
    ctx.setFlash(out.note, out.tone);
    return { redirect: out.back };
  }
  return render(ctx, out.title, out.shell, "vaults");
}

// What is open across every plan, Todoist-style: what waits for a person,
// what is being done, what can be picked up, what is stuck. Done and cancelled tasks stay on their plan.
const OPEN: Group[] = [
  { id: "awaiting-review", title: "Awaiting review", states: ["awaiting_review"] },
  { id: "in-progress", title: "In progress", states: ["claimed"] },
  { id: "ready", title: "Ready to pick up", states: ["ready"] },
  { id: "blocked", title: "Blocked", states: ["blocked_by_cancelled", "blocked"] },
];

export async function tasks(ctx: Ctx, id: string): Promise<Reply> {
  return build(ctx, id, async (c) => {
    const plans = await loadPlans(c, id);
    const open = grouped(OPEN, plans.length ? await loadTasks(c, id, null) : [], true);
    const names = new Map(plans.map((p) => [p.path, p.title ?? p.path]));
    const body = html`
      ${pageHeader({
        title: "Tasks",
        description: "What your agents are working on, what is ready to pick up and what is stuck, across every plan.",
      })}
      ${plans.length
        ? html`${open.length
            ? open.map(
                (g) => html`<section aria-labelledby="open-${g.id}"><h2 id="open-${g.id}">${g.title} <span class="muted">${g.rows.length}</span></h2>
                  <ul class="task-list">${g.rows.map((t) => taskRow(ctx, id, t, { plan: names.get(t.plan) ?? t.plan }))}</ul></section>`,
              )
            : html`<p class="muted">Every task in every plan is done or cancelled.</p>`}
          <section aria-labelledby="plans"><h2 id="plans">Plans <span class="muted">${plans.length}</span></h2>${planCards(ctx, id, plans)}</section>
          <p class="hint">A plan is a file that lists tasks, some of which wait on others. <a href="/docs/concepts/tasks">About tasks</a></p>`
        : emptyState({
            title: "No plans yet",
            body: "A plan comes to exist when an agent registers a plan file, a file in the vault that lists tasks. Registered plans, and the tasks in them, show up here.",
            action: html`<a href="/docs/concepts/tasks">About tasks</a>`,
          })}`;
    return { body, title: "Tasks" };
  });
}

// ---------------------------------------------------------------------------
// One plan.

// What a person sees a task as, and the order the page groups them in: what
// can be worked on right now first, what is finished last.
const STATE_LABEL: Record<Task["state"], string> = {
  awaiting_review: "Awaiting review",
  claimed: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  blocked_by_cancelled: "Blocked by a cancelled task",
  cancelled: "Cancelled",
  done: "Done",
};
type Group = { id: string; title: string; states: Task["state"][] };
const GROUPS: Group[] = [
  { id: "awaiting-review", title: "Awaiting review", states: ["awaiting_review"] },
  { id: "in-progress", title: "In progress", states: ["claimed"] },
  { id: "ready", title: "Ready", states: ["ready"] },
  { id: "blocked", title: "Blocked", states: ["blocked_by_cancelled", "blocked"] },
  { id: "cancelled", title: "Cancelled", states: ["cancelled"] },
];

// The groups in use, each in its states' order (a stable sort keeps the
// plan's). Across plans there is no plan order to keep, so within a state
// the most pressing comes first: priority, then due date, none of either last.
const grouped = (groups: Group[], rows: Task[], byPlanning = false) =>
  groups
    .map((g) => ({
      ...g,
      rows: rows
        .filter((t) => g.states.includes(t.state))
        .sort((a, b) => g.states.indexOf(a.state) - g.states.indexOf(b.state) || (byPlanning ? pressing(a, b) : 0)),
    }))
    .filter((g) => g.rows.length);
const pressing = (a: Task, b: Task) =>
  (a.priority ?? 5) - (b.priority ?? 5) || (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31");

// ponytail: the page has no viewer's time zone (no script, no setting), so
// a due date counts as passed once that day has ended everywhere (UTC-12):
// never early, up to a day late east of it. A time zone setting would fix it.
const overdue = (t: Task, now = Date.now()) =>
  !!t.due && unfinished(t) && t.due < new Date(now - 12 * 3600_000).toISOString().slice(0, 10);

// A task's planning facts for its quiet line (docs/design.md item 13): the
// priority, coloured only at P1 and P2, and the due date, which says
// Overdue in words once it has passed.
function planning(t: Task): Raw[] {
  return [
    ...(t.priority ? [html`<span class="task-prio p${t.priority}" title="Priority ${t.priority}, 1 is highest">P${t.priority}</span>`] : []),
    ...(t.due
      ? [overdue(t)
          ? html`<span class="task-due overdue">Overdue, due <time datetime="${t.due}">${t.due}</time></span>`
          : html`<span class="task-due">Due <time datetime="${t.due}">${t.due}</time></span>`]
      : []),
  ];
}

// Who the plan meant a task for: a hint, never who may take it.
const meantFor = (ctx: Ctx, t: Task) =>
  t.for_kind === "member" ? html`for ${who(ctx, t.for_member, null)}` : t.for_kind ? `for ${t.for_kind}` : "";

// A task by its title only: keys are for agents and the plan file. The
// confirm pages still give the key beside it, where exactness matters.
const titles = (list: Blocker[]) => list.map((b) => `${b.title}${b.status === "review" ? " (awaiting review)" : ""}`).join(", ");
const taskName = (t: Pick<Blocker, "key" | "title">) => html`${t.title} <code>${t.key}</code>`;
const nameList = (list: Blocker[]) =>
  list.map((b, i) => html`${i ? ", " : ""}${taskName(b)}${b.status === "review" ? " (awaiting review)" : ""}`);

// The quiet line under a task: the holder's label (in quotes: it is their
// note, never proof) and time left, what it is waiting on, or when it ended.
function detail(ctx: Ctx, id: string, t: Task, canAct: boolean): Raw | string {
  switch (t.state) {
    case "awaiting_review":
      return html`Finished by ${who(ctx, t.holder, null)}, and waiting for a person who can write the plan’s file to approve it. The tasks waiting on it start only then.${
        t.proposal_id ? html` Applying <a href="${proposalPath(id, t.proposal_id)}">its proposal</a> also approves it.` : ""
      }${canAct ? " You can approve it." : ""}`;
    case "claimed":
      return html`${t.holder_label ? html`“${t.holder_label}” · ` : ""}Time left: ${time(t.expires_at)}`;
    case "ready":
      return t.status === "claimed" ? "Its last claim ran out, so it can be taken again." : "";
    case "blocked":
      return `Blocked by ${titles(t.blockers.filter((b) => b.status !== "done"))}.`;
    case "blocked_by_cancelled": {
      const others = t.blockers.filter((b) => b.status !== "done" && b.status !== "cancelled");
      return html`Blocked by a cancelled task: ${titles(t.blockers.filter((b) => b.status === "cancelled"))}. A cancelled task never counts as done, so this one stays blocked until a person reopens that task, or cancels or skips this one.${
        others.length ? ` Also blocked by ${titles(others)}.` : ""
      }`;
    }
    case "done":
      return html`Done ${time(t.done_at)}.`;
    case "cancelled":
      return "Doesn’t count as done.";
  }
}

// A file the task cites has a newer version than the one it cites
// (work_plan_status's o_moved, only ever set on a task not yet finished).
function moved(id: string, t: Task): Raw | "" {
  if (!t.moved.length) return "";
  return html`<p class="task-meta">A file it cites changed: ${t.moved.map((p, i) => html`${i ? ", " : ""}<a href="${filePath(id, p)}">${p}</a>`)} ${
    t.moved.length === 1 ? "has" : "have"} a newer version than the one this task cites.</p>`;
}

// Cancel and skip are offered on a task that isn't finished either way,
// reopen on a cancelled one.
const unfinished = (t: Task) => t.state !== "done" && t.state !== "cancelled";
const VERBS = ["cancel", "skip", "reopen", "approve"] as const;
type Verb = (typeof VERBS)[number];

// One task as a compact row: its state as the dot's shape under a heading
// that names it (never colour alone), its title, then one quiet line of
// facts: who holds it, priority, due date, who it's for, notes, what it
// waits on. On the Tasks page (`plan` given) the line starts with the plan; on a plan's page, whoever
// can write the plan file gets the row's actions (`canAct`). Approve is the
// one visible button: it is the action a task awaiting review is waiting for.
function taskRow(ctx: Ctx, id: string, t: Task, o: { plan?: string; canAct?: boolean }): Raw {
  const href = (verb: Verb) => `${planPath(id, t.plan)}&${verb}=${q(t.key)}`;
  const line = detail(ctx, id, t, !!o.canAct);
  // The notes are the plan's text: escaped like the title, never markup.
  const meta = [meantFor(ctx, t), t.notes ?? ""].filter((m) => m !== "");
  const actions = !o.canAct
    ? ""
    : unfinished(t)
      ? html`${t.state === "awaiting_review" ? html`<a class="button" href="${href("approve")}" aria-label="Approve the task ${t.title}">Approve</a>` : ""}${menu({
          label: `Actions for the task ${t.title}`,
          icon: "more",
          items: [
            { href: href("skip"), label: "Skip", description: "Mark it done without anyone doing it" },
            { href: href("cancel"), label: "Cancel", description: "Drop it from the plan", danger: true },
          ],
        })}`
      : t.state === "cancelled"
        ? html`<a class="button quiet" href="${href("reopen")}" aria-label="Reopen the task ${t.title}">Reopen</a>`
        : "";
  // The state is the group's heading and the dot's shape; its words are
  // still here for screen readers, which skip the dot.
  const facts: (Raw | string)[] = [
    ...(o.plan ? [html`<a href="${planPath(id, t.plan)}">${o.plan}</a>`] : []),
    ...(t.state === "claimed" ? [html`<span class="task-holder">${who(ctx, t.holder, t.agent)}</span>`] : []),
    ...planning(t),
    ...meta,
    ...(line ? [line] : []),
  ];
  // A key is unique only within its plan, so only a plan's page gives rows an id.
  return html`<li class="task-row"${o.plan ? "" : html` id="task-${t.key}"`}><div class="task-line">
      <span class="task-dot ${t.state}" aria-hidden="true"></span><span class="sr-only">${STATE_LABEL[t.state]}:</span>
      <strong class="task-title">${t.title}</strong>
      ${t.moved.length ? html`<span class="badge warning">A file it cites changed</span>` : ""}
      ${actions}</div>
    ${facts.length ? html`<p class="task-meta">${facts.map((f, i) => html`${i ? " · " : ""}${f}`)}</p>` : ""}
    ${moved(id, t)}</li>`;
}

function line(ctx: Ctx, places: Place[]): Raw {
  const name = (p: Place) =>
    p.agent ? (p.holder === ctx.userId ? "your agent" : html`${who(ctx, p.holder, null)}’s agent`) : who(ctx, p.holder, null);
  return html`<section aria-labelledby="g-waiting"><h2 id="g-waiting">Waiting for work <span class="muted">${places.length}</span></h2>${
    places.length
      ? html`<div class="table-wrap"><table class="table-stack member-list line-table">
    <thead><tr><th scope="col">Place in line</th><th scope="col">Waiting</th><th scope="col">Place lapses</th></tr></thead>
    <tbody>${places.map(
      (p, i) => html`<tr><td><strong>${i + 1}</strong></td><td class="small" data-label="Waiting">${name(p)}</td><td class="small" data-label="Place lapses">${time(p.expires_at)}, unless it asks again</td></tr>`,
    )}</tbody></table></div>
    <p class="hint">When a task is ready, the first in line gets it. A place lapses when its agent stops asking for work, and the next one moves up.</p>`
      : html`<p class="muted">No one is waiting for work in this plan.</p>`
  }</section>`;
}

function fileNote(id: string, p: Plan): Raw | "" {
  if (p.file === "changed")
    return callout(
      "warning",
      html`<p>This plan’s file has changed since the plan was registered. The tasks below come from the version last registered, and that is what agents work from. If the change adds tasks, an agent registers the file again to add them; tasks already here keep their state. <a href="${filePath(id, p.path, "history")}">See the file’s history</a></p>`,
    );
  if (p.file === "deleted") return callout("warning", "This plan’s file has been deleted. The tasks below stay, and agents can still work from them.");
  return "";
}

export async function plan(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  for (const verb of VERBS) {
    const key = ctx.url.searchParams.get(verb);
    if (key !== null) return confirmTask(ctx, id, path, verb, key);
  }
  return build(ctx, id, async (c, v) => {
    const p = (await loadPlans(c, id)).find((x) => x.path === path);
    if (!p) return { back: tasksPath(id), note: `There’s no plan registered at ${shown(path)}.`, tone: "warning" };
    const rows = await loadTasks(c, id, path);
    const canAct = await writablePath(c, v, path);
    const places = await loadLine(c, id, path);
    const groups = grouped(GROUPS, rows);
    const done = rows.filter((t) => t.state === "done");
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Tasks", href: tasksPath(id) }, { label: path.split("/").pop()! }],
        title: p.title ?? path,
        path: !p.title,
        description: `${p.done} of ${plural(total(p), "task")} done.`,
        meta: html`<p class="meta">${p.file === "deleted" ? "The plan file is gone" : html`<a href="${filePath(id, path)}">Open the plan file</a>`} · registered by ${who(ctx, p.registered_by, null)} ${time(p.registered_at)}</p>`,
      })}
      ${fileNote(id, p)}
      ${groups.map(
        (g) => html`<section aria-labelledby="g-${g.id}"><h2 id="g-${g.id}">${g.title} <span class="muted">${g.rows.length}</span></h2>
          <ul class="task-list">${g.rows.map((t) => taskRow(ctx, id, t, { canAct }))}</ul></section>`,
      )}
      ${line(ctx, places)}
      ${done.length
        ? html`<details class="task-done"><summary><h2 id="g-done">Done <span class="muted">${done.length}</span></h2></summary>
            <ul class="task-list">${done.map((t) => taskRow(ctx, id, t, { canAct }))}</ul></details>`
        : ""}
      <p class="hint">${canAct ? "Approve passes a finished task’s review, so the tasks waiting on it can start. Cancel and Skip are in each open task’s ⋯ menu. Cancel drops a task, and Reopen puts a cancelled one back. Skip marks a task done without anyone doing it, and can’t be undone from here. Each asks you to confirm first. " : ""}<a href="/docs/concepts/tasks">About tasks</a></p>`;
    return { body, title: path };
  });
}

// ---------------------------------------------------------------------------
// Confirm cancelling, skipping or reopening a task. A GET: nothing changes
// until its form is sent.

const LABEL: Record<Verb, { title: string; button: string }> = {
  cancel: { title: "Cancel a task", button: "Cancel" },
  skip: { title: "Skip a task", button: "Skip" },
  reopen: { title: "Reopen a task", button: "Reopen" },
  approve: { title: "Approve a task", button: "Approve" },
};

async function confirmTask(ctx: Ctx, id: string, path: string, verb: Verb, key: string): Promise<Reply> {
  return build(ctx, id, async (c, v) => {
    const back = planPath(id, path);
    if (!(await loadPlans(c, id)).some((x) => x.path === path)) return { back: tasksPath(id), note: `There’s no plan registered at ${shown(path)}.`, tone: "warning" };
    if (!(await writablePath(c, v, path)))
      return { back, note: `Only someone who can write this plan’s file ${verb === "reopen" ? "reopens" : verb === "approve" ? "approves" : "cancels or skips"} its tasks.`, tone: "warning" };
    const rows = await loadTasks(c, id, path);
    const t = rows.find((r) => r.key === key);
    if (!t) return { back, note: `There’s no task ${shown(key)} in this plan.`, tone: "warning" };
    if (verb === "reopen" && t.state !== "cancelled") return { back, note: `“${t.title}” isn’t cancelled, so there’s nothing to reopen.`, tone: "warning" };
    if (verb === "approve" && t.state !== "awaiting_review") return { back, note: `“${t.title}” isn’t awaiting review, so there’s nothing to approve.`, tone: "warning" };
    if ((verb === "cancel" || verb === "skip") && !unfinished(t)) return { back, note: `“${t.title}” is already ${t.state === "done" ? "done" : "cancelled"}, so there’s nothing to ${verb}.`, tone: "warning" };

    // What waits on it: a task that lists it as a blocker and isn't finished either way.
    const waiting = rows.filter((r) => unfinished(r) && r.blockers.some((b) => b.key === key));
    const holder = t.state === "claimed" ? html`${who(ctx, t.holder, null)}${t.holder_label ? html` (“${t.holder_label}”)` : ""} holds it now and loses it. If their agent tries to finish it, that is refused.` : "";
    const blockers = t.blockers.filter((b) => b.status !== "done");
    const consequences: (Raw | string)[] =
      verb === "approve"
        ? [
            "Approve only once you’ve checked the work: the plan counts it as done from then on.",
            waiting.length
              ? html`These tasks stop waiting on it, and any with nothing else left to wait for become ready for an agent to take: ${nameList(waiting)}.`
              : "No other task is waiting on it.",
            t.proposal_id
              ? html`Its agent linked <a href="${proposalPath(id, t.proposal_id)}">a proposal</a> as its work. Approving the task here leaves that proposal waiting for its own review.`
              : "",
            "It’s logged in the activity log as approved by you.",
          ]
        : verb === "reopen"
        ? [
            html`If the work has changed since it was cancelled, a new task that names this one (<code>${t.key}</code>) is usually better than reopening it: an agent adds it to the plan file and registers it again, and the history reads plainly. Reopen when the work really is the same task.`,
            blockers.length
              ? html`It waits on ${nameList(blockers)} again before anyone can take it.`
              : "Nothing it waits on is unfinished, so it is ready for an agent to take.",
            waiting.length
              ? html`These tasks wait on it, and wait for it to be done, the same as for any other task: ${nameList(waiting)}.`
              : "No other task is waiting on it.",
            "It’s logged in the activity log.",
          ]
        : verb === "cancel"
        ? [
            waiting.length
              ? html`These tasks wait on it and stay blocked, shown as blocked by a cancelled task, until a person reopens it, or cancels or skips each of them: ${nameList(waiting)}.`
              : "No other task is waiting on it.",
            holder,
            "A person can reopen it later from this page.",
            "It’s logged in the activity log.",
          ]
        : [
            waiting.length
              ? html`These tasks stop waiting on it, and any with nothing else left to wait for become ready: ${nameList(waiting)}.`
              : "No other task is waiting on it.",
            t.state === "blocked" || t.state === "blocked_by_cancelled" ? "Its own blockers aren’t finished. Skipping it lets what waits on it go ahead anyway." : "",
            holder,
            "The plan shows it as done. The activity log records that it was skipped.",
          ];
    const body = confirmPage({
      title: `${LABEL[verb].button} “${t.title}”?`,
      crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Tasks", href: tasksPath(id) }, { label: path.split("/").pop()!, href: back }, { label: LABEL[verb].title }],
      lede:
        verb === "approve"
          ? html`Approving <strong>${t.title}</strong> <code>${t.key}</code> passes its review. It was finished by ${who(ctx, t.holder, null)}, and has waited for a person to check the work.`
          : verb === "reopen"
          ? html`Reopening <strong>${t.title}</strong> <code>${t.key}</code> puts it back in the plan as open work, for an agent to take once what it waits on is done.`
          : verb === "cancel"
          ? html`Cancelling <strong>${t.title}</strong> <code>${t.key}</code> drops it from the plan. A cancelled task never counts as done.`
          : html`Skipping <strong>${t.title}</strong> <code>${t.key}</code> marks it done, as if someone had finished it, without anyone doing the work.`,
      consequences: consequences.filter((x) => x !== ""),
      action: `${tasksPath(id)}/plan`,
      csrf: ctx.csrf,
      fields: { path, key, action: verb, confirm: "1" },
      button: `${LABEL[verb].button} “${t.title}”`,
      cancel: back,
      ...(verb === "cancel" ? { cancelLabel: "Keep the task" } : verb === "reopen" ? { cancelLabel: "Keep it cancelled" } : verb === "approve" ? { cancelLabel: "Not yet" } : {}),
    });
    return { body, title: LABEL[verb].title };
  });
}

// ---------------------------------------------------------------------------
// POST: cancel, skip, reopen or approve, once confirmed. The database refuses anyone who can't
// write the path, an agent, a task already finished, and an unknown one; its
// refusal comes back as a flash with its reference.

const refuse = (why: string) => message(new Refusal({ status: 400, where: "web app (a vault's tasks)", why }));

export async function taskAction(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.form.get("path") ?? "";
  const key = ctx.form.get("key") ?? "";
  const action = ctx.form.get("action") ?? "";
  const back = planPath(id, path);
  if (!(VERBS as readonly string[]).includes(action)) {
    ctx.setFlash(refuse("The form didn’t say what to do, so nothing changed"));
    return { redirect: back };
  }
  // Only the confirm page's form carries this: anything else is sent there.
  if (ctx.form.get("confirm") !== "1") return { redirect: `${back}&${action}=${q(key)}` };
  try {
    const done = await asPerson(ctx.userId, async (c) => {
      if (!(await vault(c, ctx, id))) return null;
      const title = (await loadTasks(c, id, path)).find((r) => r.key === key)?.title ?? key;
      await c.query(`select public.${action}_step($1, $2, $3)`, [id, path, key]);
      return title;
    });
    if (done === null) return notFound(ctx);
    ctx.setFlash(
      action === "approve"
        ? `“${done}” is approved and counts as done. Tasks that were waiting only on it are ready now.`
        : action === "reopen"
        ? `“${done}” is reopened. Tasks that waited on it now wait for it to be done.`
        : action === "cancel"
        ? `“${done}” is cancelled. Tasks waiting on it stay blocked until a person reopens it, or cancels or skips them.`
        : `“${done}” is skipped and counts as done. Tasks that were waiting only on it are ready now.`,
      "success",
    );
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: back };
}
