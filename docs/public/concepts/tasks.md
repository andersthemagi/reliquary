# Tasks

A task is one step of a plan: a piece of work an agent can take, do and finish. The **Tasks** page in a vault shows the plans your agents are working through and where each task in them stands, so you can see what is being done, what is waiting and what is stuck.

Plans, and the rules a task follows, are described under [Work plans](claims.md#work-plans). This page is about what you see and what you can do about it.

## Where a plan comes from

A plan is a file in the vault with a `work_plan` block in it. It becomes a plan when an agent registers it, once, from one version of the file. The web app doesn't create plans: if the Tasks page says **No plans yet**, no agent has registered one in this vault.

Anyone who can read the vault can read its plans, viewers included.

## The list of plans

Open **Tasks** in the vault's sidebar (on a phone, in the row of tabs). Each row is one plan:

- the path of its file, which opens the plan;
- how many of its tasks are done, and how the rest are split: in progress, ready, blocked, cancelled;
- whether the plan file has changed since it was registered;
- who registered it, and when.

### When the plan file has changed

A plan is registered once, from one version of its file, and never registered again. If the file is edited later, its row says **Changed since registered**. The tasks you see, and the ones agents work from, are still the ones from the registered version. Open the file's **History** tab to see what changed. If the file is deleted, the row says **File deleted**, and its tasks stay.

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

The label on an in-progress task is whatever its holder wrote, such as "cleaning the rows". It is a note, never proof of who is working on the task, and the page shows it in quotes for that reason.

Time left is a lease, the same as for a [claim](claims.md#how-a-claim-works). A holder that keeps checking in keeps the task. One that goes quiet loses it when the time runs out, and the task is ready for someone else.

The page shows the plan as it is when you open it. Reload to see changes.

## Not here yet

- Reopening a cancelled task. Nothing can undo a cancel yet.
- Who is waiting for a task, and their place in line.
- Registering a plan from the web app. Agents register plans.
