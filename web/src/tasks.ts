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
//   GET  /v/:id/tasks               the plans, with counts and a marker when a plan file changed
//   GET  /v/:id/tasks/plan?path=    one plan: every task, ready or in progress first

import type pg from "pg";
import { asPerson } from "./db.js";
import { callout, emptyState, html, pageHeader, plural, time, type Raw } from "./html.js";
import { filePath, notFound, q, render, vault, vaultPath, who, type Ctx, type Reply, type Vault } from "./pages.js";
import { vaultShell } from "./files.js";

export const tasksPath = (id: string) => vaultPath(id, "/tasks");
export const planPath = (id: string, path: string) => `${tasksPath(id)}/plan?path=${q(path)}`;

type Plan = {
  path: string;
  registered_at: Date;
  registered_by: string;
  file: "unchanged" | "changed" | "deleted";
  ready: number;
  blocked: number;
  claimed: number;
  done: number;
  cancelled: number;
};

type Blocker = { key: string; title: string; status: string };
type Task = {
  key: string;
  title: string;
  state: "ready" | "blocked" | "blocked_by_cancelled" | "claimed" | "done" | "cancelled";
  status: string;
  holder: string | null;
  holder_label: string | null;
  expires_at: Date | null;
  done_at: Date | null;
  blockers: Blocker[];
};

async function loadPlans(c: pg.PoolClient, id: string): Promise<Plan[]> {
  return (
    await c.query(
      `select o_path as path, o_registered_at as registered_at, o_registered_by as registered_by, o_file as file,
              o_ready as ready, o_blocked as blocked, o_claimed as claimed, o_done as done, o_cancelled as cancelled
         from public.list_work_plans($1)`,
      [id],
    )
  ).rows;
}

// One round trip: the state from work_plan_status (the one definition), the
// holder and finish time from the step, and the steps blocking it by name.
async function loadTasks(c: pg.PoolClient, id: string, path: string): Promise<Task[]> {
  return (
    await c.query(
      `select st.o_key as key, st.o_title as title, st.o_state as state, s.status, s.holder,
              st.o_holder_label as holder_label, st.o_expires_at as expires_at, s.done_at,
              coalesce((select json_agg(json_build_object('key', b.key, 'title', b.title, 'status', b.status) order by b.id)
                          from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                         where d.step_id = s.id), '[]') as blockers
         from public.work_plan_status($1, $2) st
         join public.work_plans p on p.vault_id = $1 and p.path = $2
         join public.work_plan_steps s on s.plan_id = p.id and s.key = st.o_key
        order by s.id`,
      [id, path],
    )
  ).rows;
}

// A path typed into a URL, said back only when it's plain (as claimspage.ts does).
const shown = (path: string) => (/^[^\u0000-\u001f\u007f]{1,200}$/.test(path) ? path : "that path");

const total = (p: Plan) => p.ready + p.blocked + p.claimed + p.done + p.cancelled;

// The words, never only a colour: "2 in progress · 1 ready · 3 blocked".
function counts(p: Plan): string {
  const parts: [number, string][] = [[p.claimed, "in progress"], [p.ready, "ready"], [p.blocked, "blocked"], [p.cancelled, "cancelled"]];
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(" · ");
}

function fileState(p: Pick<Plan, "file">): Raw {
  if (p.file === "changed") return html`<span class="badge warning">Changed since registered</span>`;
  if (p.file === "deleted") return html`<span class="badge warning">File deleted</span>`;
  return html`<span class="muted">Unchanged</span>`;
}

function plansTable(ctx: Ctx, id: string, plans: Plan[]): Raw {
  return html`<div class="table-wrap"><table class="table-stack member-list">
    <thead><tr><th scope="col">Plan</th><th scope="col">Tasks</th><th scope="col">Plan file</th><th scope="col">Registered</th></tr></thead>
    <tbody>${plans.map(
      (p) => html`<tr><td><a href="${planPath(id, p.path)}">${p.path}</a></td>
        <td class="small" data-label="Tasks"><strong>${p.done} of ${total(p)} done</strong>${counts(p) ? html`<span class="token-client">${counts(p)}</span>` : ""}</td>
        <td class="small" data-label="Plan file">${fileState(p)}</td>
        <td class="small" data-label="Registered">${who(ctx, p.registered_by, null)} ${time(p.registered_at)}</td></tr>`,
    )}</tbody></table></div>`;
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

export async function tasks(ctx: Ctx, id: string): Promise<Reply> {
  return build(ctx, id, async (c) => {
    const plans = await loadPlans(c, id);
    const body = html`
      ${pageHeader({
        title: "Tasks",
        description: "The plans your agents are working through, and where each task in them stands.",
      })}
      ${plans.length
        ? html`${plansTable(ctx, id, plans)}
          <p class="hint">A plan is a file that lists tasks, some of which wait on others. <a href="/docs/concepts/tasks">About tasks</a></p>`
        : emptyState({
            title: "No plans yet",
            body: html`A plan comes to exist when an agent registers a plan file that holds a <code>work_plan</code> block. Registered plans, and the tasks in them, show up here.`,
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
  claimed: "In progress",
  ready: "Ready",
  blocked: "Blocked",
  blocked_by_cancelled: "Blocked by a cancelled task",
  cancelled: "Cancelled",
  done: "Done",
};
const STATE_TONE: Record<Task["state"], string> = {
  claimed: "info",
  ready: "success",
  blocked: "warning",
  blocked_by_cancelled: "danger",
  cancelled: "",
  done: "",
};
const GROUPS: { id: string; title: string; states: Task["state"][] }[] = [
  { id: "in-progress", title: "In progress", states: ["claimed"] },
  { id: "ready", title: "Ready", states: ["ready"] },
  { id: "blocked", title: "Blocked", states: ["blocked_by_cancelled", "blocked"] },
  { id: "cancelled", title: "Cancelled", states: ["cancelled"] },
  { id: "done", title: "Done", states: ["done"] },
];

const taskName = (t: Pick<Blocker, "key" | "title">) => html`${t.title} <code>${t.key}</code>`;
const nameList = (list: Pick<Blocker, "key" | "title">[]) => list.map((b, i) => html`${i ? ", " : ""}${taskName(b)}`);

// What a task is waiting on, or who has it, in words.
function detail(ctx: Ctx, t: Task): Raw {
  switch (t.state) {
    case "claimed":
      return html`Held by ${who(ctx, t.holder, null)}
        ${t.holder_label ? html`<span class="token-client">“${t.holder_label}”</span>` : ""}
        <span class="token-client">Time left: ${time(t.expires_at)}</span>`;
    case "ready":
      return t.status === "claimed" ? html`Its last claim ran out, so it can be taken again.` : html`Nobody has taken it yet.`;
    case "blocked": {
      const open = t.blockers.filter((b) => b.status !== "done");
      return html`Waiting on ${nameList(open)}.`;
    }
    case "blocked_by_cancelled": {
      const cancelled = t.blockers.filter((b) => b.status === "cancelled");
      const others = t.blockers.filter((b) => b.status !== "done" && b.status !== "cancelled");
      return html`Blocked by a cancelled task: ${nameList(cancelled)}. A cancelled task never counts as done, so this one stays blocked until a person cancels or skips it.${
        others.length ? html`<span class="token-client">Also waiting on ${nameList(others)}.</span>` : ""
      }`;
    }
    case "done":
      return html`Done ${time(t.done_at)}.`;
    case "cancelled":
      return html`Doesn’t count as done.`;
  }
}

function taskTable(ctx: Ctx, rows: Task[]): Raw {
  return html`<div class="table-wrap"><table class="table-stack member-list task-table">
    <thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Details</th></tr></thead>
    <tbody>${rows.map(
      (t) => html`<tr><td><strong>${t.title}</strong><span class="token-client"><code>${t.key}</code></span></td>
        <td class="small" data-label="State"><span class="badge${STATE_TONE[t.state] ? ` ${STATE_TONE[t.state]}` : ""}">${STATE_LABEL[t.state]}</span></td>
        <td class="small" data-label="Details">${detail(ctx, t)}</td></tr>`,
    )}</tbody></table></div>`;
}

function fileNote(id: string, p: Plan): Raw | "" {
  if (p.file === "changed")
    return callout(
      "warning",
      html`<p>This plan’s file has changed since the plan was registered. The tasks below come from the version it was registered from, and that is what agents work from. A plan is registered once, so they don’t follow the change. <a href="${filePath(id, p.path, "history")}">See the file’s history</a></p>`,
    );
  if (p.file === "deleted") return callout("warning", "This plan’s file has been deleted. The tasks below stay, and agents can still work from them.");
  return "";
}

export async function plan(ctx: Ctx, id: string): Promise<Reply> {
  const path = ctx.url.searchParams.get("path") ?? "";
  return build(ctx, id, async (c, v) => {
    const p = (await loadPlans(c, id)).find((x) => x.path === path);
    if (!p) return { back: tasksPath(id), note: `There’s no plan registered at ${shown(path)}.`, tone: "warning" };
    const rows = await loadTasks(c, id, path);
    const groups = GROUPS.map((g) => ({
      ...g,
      rows: rows.filter((t) => g.states.includes(t.state)).sort((a, b) => g.states.indexOf(a.state) - g.states.indexOf(b.state)),
    })).filter((g) => g.rows.length);
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Tasks", href: tasksPath(id) }, { label: path.split("/").pop()! }],
        title: path,
        path: true,
        description: `${p.done} of ${plural(total(p), "task")} done.`,
        meta: html`<p class="meta">${p.file === "deleted" ? "The plan file is gone" : html`<a href="${filePath(id, path)}">Open the plan file</a>`} · registered by ${who(ctx, p.registered_by, null)} ${time(p.registered_at)}</p>`,
      })}
      ${fileNote(id, p)}
      ${groups.map((g) => html`<section aria-labelledby="g-${g.id}"><h2 id="g-${g.id}">${g.title} <span class="muted">${g.rows.length}</span></h2>${taskTable(ctx, g.rows)}</section>`)}
      <p class="hint"><a href="/docs/concepts/tasks">About tasks</a></p>`;
    return { body, title: path };
  });
}
