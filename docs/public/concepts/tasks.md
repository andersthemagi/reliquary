# Tasks

A task is one step of a plan: a piece of work an agent can take, do and finish. The **Tasks** page in a vault shows the plans your agents are working through and where each task in them stands, so you can see what is being done, what is waiting and what is stuck.

Plans, and the rules a task follows, are described under [Work plans](claims.md#work-plans). This page is about what you see and what you can do about it.

## Where a plan comes from

A plan is a file in the vault with a `work_plan` block in it. It becomes a plan when an agent registers it from the file's current version. The web app doesn't create plans: if the Tasks page says **No plans yet**, no agent has registered one in this vault.

Anyone who can read the vault can read its plans, viewers included.

## The list of plans

Open **Tasks** in the vault's sidebar (on a phone, in the row of tabs). Each row is one plan:

- the path of its file, which opens the plan;
- how many of its tasks are done, and how the rest are split: in progress, ready, blocked, cancelled;
- whether the plan file has changed since it was registered;
- who registered it, and when.

### When the plan file has changed

If the plan file is edited after it was registered, its row says **Changed since registered**. The tasks you see, and the ones agents work from, are still the ones from the version last registered. Open the file's **History** tab to see what changed. If the file is deleted, the row says **File deleted**, and its tasks stay.

### Adding tasks to a plan

A plan can gain tasks, never lose or change them. Add the new steps to the plan file's `work_plan` block, each with a key the plan doesn't have yet, then have an agent register the file again (`register_work_plan`, the same as the first time). The new steps become tasks at the end of the plan, and **Changed since registered** goes away.

- Tasks already in the plan keep their state: a done task stays done, a task someone holds stays theirs, a cancelled one stays cancelled.
- A new step may wait on any task in the plan. If that task is already done, the new one doesn't wait for it. If it was cancelled, the new one is blocked by a cancelled task.
- A task already in the plan must stay in the file exactly as it was registered: the same title, gate, `blocked_by` and `cites`. If one is missing or different, nothing is added, and the agent is told which steps to put back. So an old task can't be made to wait on a new one.
- Registering again with no new steps, after an edit to the rest of the file, adds nothing and clears **Changed since registered**.
- Who may do it is the same as for registering: whoever can write the plan file. The Activity log records it as **Updated a work plan**.

## One plan

Select a plan to see every task in it. Tasks are grouped so what can be worked on comes first: In progress, Ready, Blocked, Cancelled, Done. Each task shows its state in words, so no state depends on colour alone.

| State | What it means |
|---|---|
| In progress | An agent holds the task and its time has not run out. The row says who holds it, the label they gave it, and how long is left. |
| Ready | Every task it waits on is done, and nobody holds it. A task whose holder ran out of time is ready again. |
| Blocked | It waits on tasks that are not done yet. The row names them. |
| Blocked by a cancelled task | One of the tasks it waits on was cancelled. A cancelled task never counts as done, so this task stays blocked until a person cancels or skips it. |
| Done | Finished, or skipped by a person. |
| Cancelled | Dropped by a person. It doesn't count as done. |

### Context moved

A task can cite files the work depends on, each at the version it was written against. When one of those files has a newer version, because someone wrote it or a proposal to change it was approved, the task shows **Context moved** beside its state, and its row names each file that moved, linked. Open the file's **History** tab to see what changed. The task's state doesn't change: it can still be ready, blocked or in progress. It means whoever works the task should read the file again first.

Only a task that isn't finished shows it. A done or cancelled task never does, and a proposal still waiting for review moves nothing. A file that was deleted, or a cited version the file never had, isn't shown as moved.

Whoever registered the plan, and whoever holds a task that cites the file, also get a [flag](flags.md) when the file changes.

The label on an in-progress task is whatever its holder wrote, such as "cleaning the rows". It is a note, never proof of who is working on the task, and the page shows it in quotes for that reason.

Time left is a lease, the same as for a [claim](claims.md#how-a-claim-works). A holder that keeps checking in keeps the task. One that goes quiet loses it when the time runs out, and the task is ready for someone else. Running out of time never counts as done: the tasks waiting on it stay blocked, and the holder that went quiet can't mark it done afterwards.

The page shows the plan as it is when you open it. Reload to see changes.

## Cancelling and skipping a task

If you can write the plan's file (an owner or editor, or a named owner of its path), each task that isn't done or cancelled has two buttons, **Cancel** and **Skip**. Each opens a confirm page that says what will happen, and nothing changes until you confirm there. On the cancel page the way out is **Keep the task**, so the only **Cancel** there is the one that cancels it. Only a person can do either: an agent is refused, the same ceiling as approving a proposal (see [Agents and the ceiling](agents.md)).

- **Cancel** drops the task. A cancelled task never counts as done, so every task waiting on it stays blocked, shown as blocked by a cancelled task, until a person cancels or skips each of them. A cancelled task can't be reopened.
- **Skip** marks the task done, as if someone had finished it, without anyone doing the work. The tasks that waited on it stop waiting, and any with nothing else left to wait for become ready. The plan shows a skipped task as done; the activity log records that it was skipped.

If an agent holds the task, it loses it either way, and if that agent then tries to finish the task, it is refused. Both actions are logged.

To get a plan moving again after cancelling a task that others wait on, cancel the tasks that are stuck behind it, or skip them.

## Not here yet

- Reopening a cancelled task. Nothing can undo a cancel yet, so cancel only what you mean to drop.
- Who is waiting for a task, and their place in line.
- Registering a plan from the web app. Agents register plans.
