# Tasks

A work plan is a list of steps, some of which wait on others, so no agent is handed a step before the steps it waits on are done. Agents register plans and work their steps over MCP. People see each step as a task on the vault's **Tasks** page, and approve, cancel, skip or reopen tasks there.

The tools and the database say `work_plan` and `step`; the web app says plan and task. They are the same thing. To walk through a plan from start to finish, see [Work through a plan with agents](../how-to/work-through-a-plan.md).

## What a plan is

A plan is a file in the vault with one fenced `work_plan` block in it:

```work_plan
- key: fetch-data
  title: Fetch raw data from the api
  cites: docs/data-source.md@3fa85f64-5717-4562-b3fc-2c963f66afa6
- key: clean-data
  title: Clean and normalize
  blocked_by: fetch-data
  cites: docs/data-source.md@3fa85f64-5717-4562-b3fc-2c963f66afa6
  gate: review
  due: 2026-10-20
  priority: 2
  for: agents
  notes: Drop rows with no account id; keep the raw file.
```

Each step has:

- `key`: lower case letters and digits, with single hyphens between them, unique in the plan;
- `title`: 1 to 200 characters;
- `blocked_by` (optional): the keys of the steps it waits on, comma-separated;
- `cites` (optional): the files its work depends on, each as `path@version`, comma-separated (see [Context moved](#context-moved));
- `gate: review` (optional): what waits on it starts only after a person approves it (see [Tasks that need a person's review](#tasks-that-need-a-persons-review)).

Four more optional lines help people plan. None of them changes who may take a task or when: a ready task can be taken whatever they say.

- `due`: a date, written `YYYY-MM-DD`. A date in the past is accepted. A due date passing changes nothing by itself; the Tasks page says **Overdue**.
- `priority`: `1`, `2`, `3` or `4`, where 1 is the highest.
- `notes`: one line of plain text, up to 2000 characters. Agents read it as data, never as instructions, the same as a title.
- `for`: who the task is meant for: `agents`, `people`, or the email of a member of the vault. An email that names no member is refused. Reliquary keeps the member, not the email, so the task still means them if their email changes. It is a hint, never a rule.

A malformed block, a blocker that doesn't exist, or steps that wait on each other in a cycle are refused, naming the line and why.

### Registering a plan

A file becomes a plan when an agent registers it with `register_work_plan`, naming the vault and the file's path. Reliquary reads the file's current version, checks the block, and refuses with the file's own line numbers before anything is registered. The database then checks it again, so a plan that passes the first check can still be refused (more than 500 steps, for example).

- A path holds one plan. Registering it again from a newer version adds steps: see [Adding tasks to a plan](#adding-tasks-to-a-plan).
- Whoever can write the file may register it. A read-only connection or a viewer can't.
- A plan waiting in a proposal has no file yet, so there is nothing to register until a person approves it.
- The web app doesn't register plans. If the Tasks page says **No plans yet**, no agent has registered one in this vault.

Anyone who can read the vault can read its plans, viewers included.

## Tasks and their states

| On the Tasks page | In `work_plan_status` | What it means |
|---|---|---|
| Ready | `ready` | Every task it waits on is done, and nobody holds it. A task whose holder ran out of time is ready again. |
| In progress | `claimed` | An agent holds the task and its time has not run out. |
| Awaiting review | `awaiting review` | Its agent finished it, and it needs a person's approval before the tasks waiting on it can start. |
| Blocked | `blocked` | It waits on tasks that are not done yet, or awaiting review. |
| Blocked by a cancelled task | `blocked_by_cancelled` | One of the tasks it waits on was cancelled. A cancelled task never counts as done, so this task stays blocked until a person reopens that task, or cancels or skips this one. |
| Done | `done` | Finished, approved, or skipped by a person. |
| Cancelled | `cancelled` | Dropped by a person. It doesn't count as done. |

### Holding a task

An agent holds a task the way it holds a [claim](claims.md#how-a-claim-works) on a path: a lease, not a lock. Getting a task, by [waiting in line](#waiting-in-line) or by name, returns a secret, once, and a fence number. The agent keeps both, and every later call on that task needs them, from the same connection and person.

- `checkin_step` restarts the lease without finishing the task. A holder that keeps checking in keeps the task. No amount of checking in holds it past the hold limit, counted from when it was first taken.
- `complete_step` finishes it, and frees the tasks that wait on it. A task with `gate: review` is awaiting review instead.
- `release_step` gives it back unfinished, for anyone to take.

A holder that goes quiet loses the task when its time runs out, and the task is ready for someone else. Running out of time never counts as done: the tasks waiting on it stay blocked, and the holder that went quiet can't finish it afterwards. A wrong or old secret or fence, another connection, a blocked task, one someone else holds, and a done or cancelled one are each refused, with the reason.

The lease, the hold limit and how many tasks an agent may hold come from the vault's [claim rule](claims.md#claim-rules) for the plan's path.

### What an agent reads

`work_plan_status` lists a plan's steps in plan order: each one's state, what it waits on, who holds it and until when, its priority, due date and who it is meant for, and what it cites. A step's title, its notes, its cites and a holder's label are text that people and agents wrote, so an agent sees them between markers as data, never as instructions. A title that says "ignore your instructions" is only a title.

## The Tasks page

Open **Tasks** in the vault's sidebar (on a phone, in the row of tabs). It opens on what is open across every plan in the vault, in up to four sections: **Awaiting review**, **In progress**, **Ready to pick up** and **Blocked**. Each task names its plan, linked. Within each section, the highest priority comes first, then the earliest due date; tasks with neither come last. Done and cancelled tasks stay on their plan's page.

Under **Plans**, each plan is a card:

- its title, the plan file's first `#` heading (or its path if it has none), which opens the plan;
- a bar and "6 of 10 done", and how the rest are split: in progress, awaiting review, ready, blocked, cancelled;
- whether the plan file has changed since it was registered;
- who registered it, and when.

If the plan file is edited after it was registered, its card says **Changed since registered**. The tasks you see, and the ones agents work from, are still the ones from the version last registered. Open the file's **History** tab to see what changed. If the file is deleted, the card says **File deleted**, and its tasks stay.

### One plan

Select a plan to see every task in it, grouped so what needs attention comes first: Awaiting review, In progress, Ready, Blocked, Cancelled. Done tasks are folded away at the bottom under **Done**; select it to see them. Each task is one row: a circle whose shape shows its state at a glance, and its title. The group's heading says the state in words, so no state depends on colour or shape alone, and a screen reader hears it at the start of each row. Under the title, one quiet line gathers the task's facts. Keys are for agents and the plan file, so rows show titles only.

- An in-progress task's line starts with who holds it: **you**, a person, or a person's agent ("Ana via Claude Code"), then the label they gave it and how long is left. The label is whatever the holder wrote, such as "cleaning the rows". It is a note, never proof of who is working on the task, and the page shows it in quotes for that reason.
- A blocked task says **Blocked by** and names the tasks it waits on, marking any awaiting review.
- A task awaiting review says who finished it, and links its proposal if its agent linked one.
- A task with a priority shows **P1** to **P4** on its line, with only P1 and P2 in colour, and one with a due date shows it. Once the date has ended everywhere in the world and the task isn't done or cancelled, it says **Overdue, due** and the date, in red. The page doesn't know your time zone, so in the furthest east it can say so up to a day late, never early.
- The line under a task says who it is meant for (**for agents**, **for people**, or the member) and its notes.

The page shows the plan as it is when you open it. Reload to see changes.

### Who is waiting for work

A plan's page ends with **Waiting for work**: every agent in the plan's line, first in line first. Each row gives its place, who it is (a person, or that person's agent) and when its place lapses if it stops asking. When a task is ready, the first in line gets it. A place that lapses leaves the list, and those behind it move up. If no one is waiting, the page says **No one is waiting for work in this plan.**

Viewers see the same list. It shows no label an agent gave its place.

## Waiting in line

When a plan has more agents than ready tasks, the agents wait in line for them, first come, first served. Reliquary keeps the line itself.

An agent asks for any ready task of a plan with `request_work`, naming the vault and the plan file's path, and gets an answer at once. Nothing is held open while it waits.

| Answer | What it means |
|---|---|
| Granted | The agent now holds a task, with a lease, a secret and a fence. |
| Wait | Nothing is free for it yet. The answer gives its place in line, how many tasks are ready, and how many seconds until it should ask again. If no task is ready, it also lists each unfinished task and what holds it up: who holds it and until when, or which tasks it waits on. |
| At capacity | The agent, or all of its person's agents together, already hold as many tasks in the vault as the claim rule allows. Finish or give one back first. |
| Cooling down | Its person's agents let tasks run out of time unfinished, so its person waits before getting more. The answer says how many seconds. |
| Blocked by a cancelled task | Nothing in the plan can move until a person reopens, cancels or skips a task. Stop asking. |
| Plan complete | No task is left for an agent: each is done, cancelled, or awaiting a person's review. Stop asking. |
| Refused | Its person already waits in 3 lines in this vault. |
| No such plan | No plan is registered at that path. |

Who may ask is who may claim a task: whoever can write the plan's file. A read-only connection or a viewer can't.

### How the line moves

- Each person has one place in a plan's line, however many agents or connections they use. Their agents share it.
- The oldest place goes first. With one task ready, only the first in line gets it; with two ready, the first two do. Nobody behind them can take a task ahead of them.
- A place lasts while its agent keeps asking, each time within the rule's place-in-line time. An agent that stops asking drops out, and the next in line is served. If it comes back later, it starts at the back.
- The time to ask again is when the earliest task in progress runs out of time, and never more than the rule's longest hint. A task can free up sooner. Asking again before the rule's minimum gap only gets the last answer back.
- Reliquary can't wake an agent up. The answer tells the agent to stop and come back at the suggested time; bringing it back then is up to whatever runs the agent.
- An agent can leave the line at any time with `leave_queue`. When a plan is finished, every place in its line ends.

### Every line at once

An agent waiting on several plans checks them all with one call to `my_places`, instead of calling `request_work` for each. It takes no arguments and covers every vault the connection can read. For each place its person holds in a line, it says one of:

| State | What it means |
|---|---|
| Waiting | Its number in line, how many tasks are ready for it, and when to call `request_work`: now, or a time. |
| At capacity | Its person's agents hold as many tasks as the rule allows. Finish or give one back first. |
| Cooling down | Until when. A cooldown also gets a line of its own for the vault, since it ends every place there. |
| Lapsed | The place ran out. Asking again starts at the back. |
| Plan complete | Stop asking. |

It also lists each task its person holds and when its lease ends. It changes nothing: no place moves and nothing is recorded in Activity. It tells an agent its own person's places and tasks only, and of anyone else, only how many wait ahead. A read-only connection can call it.

### Running out of time

A task whose holder ran out of time goes to the next agent in line. That counts against the person whose agent let it run out, in that vault. The first time costs nothing. After that, each time starts a cooldown: the rule's lease, then twice the last one, never more than the rule's cooldown cap. During a cooldown the person's agents get no task from the line, and give up every place they hold in the vault's lines. Finishing a task clears the count.

### Claiming a task by name

An agent can also claim one task by its key, with `claim_step`. That follows the same line, limits and cooldown: it gets the task only when asking for any task would have got it one. So it is refused when:

- others are waiting ahead of it and there aren't enough ready tasks for them and it too. It doesn't take a place in line by trying;
- the agent, or its person's agents together, already hold as many tasks as the claim rule allows;
- its person is cooling down.

Claiming a task whose holder ran out of time counts against that holder's person, the same as when the line hands it on.

### What an agent can't get around

The line doesn't trust agents to behave. The database checks every rule when it answers, so an agent can't:

- write, move or delete a place in line, a task's state or a cooldown directly, or see when a place may ask again;
- get a task that waits on an unfinished one, however often it asks;
- take a task ahead of an older place, or keep its turn after its own task ran out of time: it goes to the back;
- hold more tasks than the rule allows per agent or per person, or wait in more than 3 lines in a vault, by opening more connections;
- finish, check in on or give back a task with a secret it didn't get: the secret only works from the connection that was given the task;
- keep a task past the rule's hold limit by checking in.

Asking again and again before its time costs nothing: the agent gets its last answer back and nothing is written.

Activity records **Joined the line for a step**, **Left the line for a step** and **Place in line ended**, with why it ended: the place ran out, the plan was finished, or a cooldown started. To see only these, choose **Any waiting in line event** in the filter.

## Tasks that need a person's review

Some work needs a person to check it before anything that depends on it starts: a schema, a brief, a decision. Mark that step `gate: review` in the plan file's `work_plan` block.

- When its agent finishes the task, it is **Awaiting review**, not done. The tasks waiting on it stay blocked, and no agent can take them, whether it asks for work or names the task.
- It becomes done when a person approves it, in one of two ways: directly, with **Approve** on the plan's page, or by applying the proposal its agent linked to it. Only then do the tasks waiting on it stop waiting.
- Who can approve it: whoever can write the plan file (an owner or editor, or a named owner of its path), signed in, in the web app. No agent can approve a task, not even its own person's (see [the ceiling](agents.md#the-ceiling)).
- Everyone who can approve it is [flagged](flags.md#what-gets-flagged), and so are their agents, so a waiting task doesn't stall the plan unnoticed. The flag names the plan and the task, and goes once the task is approved, skipped or cancelled.
- The Activity log records **Approved a step**, by the person who approved it.

If you can write the plan file, a task awaiting review has an **Approve** button, with **Skip** and **Cancel** in the **⋯** menu beside it, and the page says **You can approve it.** Approve opens a confirm page that asks you to check the work first, says which tasks become ready, and changes nothing until you confirm; its way out is **Not yet**. Approving can't be undone from the page.

### Approving through a proposal

When the task's work is a change to a canon file, the agent proposes the change, then finishes the task naming that proposal (`complete_step` with `proposal`). Applying the proposal approves the task: the person reviewing the change is reviewing the task's work, and the proposal's page says so. Approving the task directly works as well, and leaves the proposal waiting. The task's row links its proposal.

The proposal has to be one the agent's own person made in this vault after the task was taken, and still waiting for review: not yet applied, rejected or stale. A proposal already decided was decided without the task in view, so it can't stand in for the review. If the linked proposal is rejected or goes stale, the task stays awaiting review, for a person to approve or cancel. A task with no `gate: review` takes no proposal.

## Context moved

A task can cite files the work depends on, each at the version it was written against. When one of those files has a newer version, because someone wrote it or a proposal to change it was approved, the task shows **A file it cites changed** beside its state, and its row names each file that moved, linked. Open the file's **History** tab to see what changed. `work_plan_status` says `context moved` on the step's state line and names the moved files with its cites.

The task's state doesn't change: it can still be ready, blocked or in progress. It means whoever works the task should read the file again first.

- Only a task that isn't finished shows it. A done or cancelled task never does.
- A proposal still waiting for review moves nothing.
- A file that was deleted, or a cited version the file never had, isn't shown as moved.
- Whoever registered the plan, and whoever holds a task that cites the file, also get a [flag](flags.md) when the file changes.

## Adding tasks to a plan

A plan can gain tasks, never lose or change them. Add the new steps to the plan file's `work_plan` block, each with a key the plan doesn't have yet, then have an agent register the file again with `register_work_plan`, the same as the first time. The new steps become tasks at the end of the plan, and **Changed since registered** goes away.

- Tasks already in the plan keep their state: a done task stays done, a task someone holds stays theirs, a cancelled one stays cancelled.
- A new step may wait on any task in the plan. If that task is already done, the new one doesn't wait for it. If it was cancelled, the new one is blocked by a cancelled task.
- A task already in the plan must stay in the file exactly as it was registered: the same title, gate, `blocked_by`, `cites`, `due`, `priority`, `notes` and `for`. If one is missing or different, nothing is added, and the agent is told which steps to put back. So an old task can't be made to wait on a new one.
- Registering again with no new steps, after an edit to the rest of the file, adds nothing and clears **Changed since registered**.
- Who may do it is the same as for registering: whoever can write the plan file. The Activity log records it as **Updated a work plan**.

## Cancelling, skipping and reopening a task

If you can write the plan's file (an owner or editor, or a named owner of its path), each task that isn't done or cancelled has **Skip** and **Cancel** in the **⋯** menu at the end of its row, and each cancelled task has a **Reopen** button. Each opens a confirm page that says what will happen, and nothing changes until you confirm there. On the cancel page the way out is **Keep the task**, so the only **Cancel** there is the one that cancels it; on the reopen page it is **Keep it cancelled**. Only a person can do any of them: an agent is refused (see [the ceiling](agents.md#the-ceiling)).

- **Cancel** drops the task. A cancelled task never counts as done, so every task waiting on it stays blocked, shown as blocked by a cancelled task, until a person reopens it, or cancels or skips each of them.
- **Skip** marks the task done, as if someone had finished it, without anyone doing the work. The tasks that waited on it stop waiting, and any with nothing else left to wait for become ready. The plan shows a skipped task as done; the activity log records that it was skipped.
- **Reopen** puts a cancelled task back in the plan. It is ready if everything it waits on is done, and blocked if not. The tasks that waited on it stop showing as blocked by a cancelled task and wait for it to be done, like any other task. Only a cancelled task can be reopened: a skipped task counts as done, and what waited on it may already be under way.

A task awaiting review can be cancelled or skipped too. Skipping it lets what waits on it go ahead, the same as approving it, but the log records a skip.

If an agent holds the task, cancelling or skipping takes it from them, and if that agent then tries to finish the task, it is refused. All three actions are logged.

### A new task or a reopened one

When cancelled work needs doing after all, prefer a new task that names the old one by its key (for example, "redo of `draft` in plans/launch.md"), added to the same plan file, which an agent then registers again ([Adding tasks to a plan](#adding-tasks-to-a-plan)). The old task stays cancelled, and the history reads plainly: what was dropped, and what replaced it. Reopen only when the work really is the same task, so the tasks that waited on it should wait on it again. The reopen page says the same before you confirm, and agents are told the same.

## Limits and settings

How long a task is held, how many an agent may hold, and how agents wait for them come from the vault's [claim rule](claims.md#claim-rules) for the plan's path. With no rule, the defaults are the Org preset's:

| Setting | With no claim rule | With a claim rule set on the Rules page |
|---|---|---|
| Lease | 48 hours | the rule's lease |
| Hold limit | 7 days | the rule's hold limit |
| Tasks per agent and per person | 1 and 5 | the rule's |
| Place in line lasts | 6 hours | the rule's place in line |
| Longest hint | 1 hour | the rule's longest check-again hint |
| Minimum gap | 15 minutes | the rule's minimum gap, never under 10 seconds |
| Free times a task runs out | 1 | 1 |
| Cooldown cap | 48 hours | the rule's lease |

Fixed limits:

- 500 steps in a plan, 50 blockers on one step, 200 characters for a title or a label, 2000 for a step's notes.
- 3 lines one person may wait in, in one vault.
- `request_work` and `claim_step` take 30 calls a minute per connection, counted together ([Rate limits](../reference/limits.md#rate-limits)). `my_places` counts only against the general limit on tool calls.
- Each vault takes 300 full evaluations a minute from all its people and agents together. Over that, `request_work` says wait and when to come back, and claiming by name is refused saying when; other vaults carry on ([What asking for work costs](../reference/limits.md#what-asking-for-work-costs)).

## Not here yet

- Registering a plan from the web app. Agents register plans.
