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
| Blocked by a cancelled task | One of the tasks it waits on was cancelled. A cancelled task never counts as done, so this task stays blocked until a person reopens that task, or cancels or skips this one. |
| Done | Finished, or skipped by a person. |
| Cancelled | Dropped by a person. It doesn't count as done. |

### Context moved

A task can cite files the work depends on, each at the version it was written against. When one of those files has a newer version, because someone wrote it or a proposal to change it was approved, the task shows **Context moved** beside its state, and its row names each file that moved, linked. Open the file's **History** tab to see what changed. The task's state doesn't change: it can still be ready, blocked or in progress. It means whoever works the task should read the file again first.

Only a task that isn't finished shows it. A done or cancelled task never does, and a proposal still waiting for review moves nothing. A file that was deleted, or a cited version the file never had, isn't shown as moved.

Whoever registered the plan, and whoever holds a task that cites the file, also get a [flag](flags.md) when the file changes.

The label on an in-progress task is whatever its holder wrote, such as "cleaning the rows". It is a note, never proof of who is working on the task, and the page shows it in quotes for that reason.

Time left is a lease, the same as for a [claim](claims.md#how-a-claim-works). A holder that keeps checking in keeps the task. One that goes quiet loses it when the time runs out, and the task is ready for someone else. Running out of time never counts as done: the tasks waiting on it stay blocked, and the holder that went quiet can't mark it done afterwards.

The page shows the plan as it is when you open it. Reload to see changes.

## Cancelling, skipping and reopening a task

If you can write the plan's file (an owner or editor, or a named owner of its path), each task that isn't done or cancelled has two buttons, **Cancel** and **Skip**, and each cancelled task has **Reopen**. Each opens a confirm page that says what will happen, and nothing changes until you confirm there. On the cancel page the way out is **Keep the task**, so the only **Cancel** there is the one that cancels it; on the reopen page it is **Keep it cancelled**. Only a person can do any of them: an agent is refused, the same ceiling as approving a proposal (see [Agents and the ceiling](agents.md)).

- **Cancel** drops the task. A cancelled task never counts as done, so every task waiting on it stays blocked, shown as blocked by a cancelled task, until a person reopens it, or cancels or skips each of them.
- **Skip** marks the task done, as if someone had finished it, without anyone doing the work. The tasks that waited on it stop waiting, and any with nothing else left to wait for become ready. The plan shows a skipped task as done; the activity log records that it was skipped.
- **Reopen** puts a cancelled task back in the plan. It is ready if everything it waits on is done, and blocked if not. The tasks that waited on it stop showing as blocked by a cancelled task and wait for it to be done, like any other task. Only a cancelled task can be reopened: a skipped task counts as done, and what waited on it may already be under way.

If an agent holds the task, cancelling or skipping takes it from them, and if that agent then tries to finish the task, it is refused. All three actions are logged.

To get a plan moving again after cancelling a task that others wait on, reopen it, or cancel or skip the tasks that are stuck behind it.

### A new task or a reopened one

When cancelled work needs doing after all, prefer a new task that names the old one by its key (for example, "redo of `draft` in plans/launch.md"), added to the same plan file, which an agent then registers again ([Adding tasks to a plan](#adding-tasks-to-a-plan)). The old task stays cancelled, and the history reads plainly: what was dropped, and what replaced it. Reopen only when the work really is the same task, so the tasks that waited on it should wait on it again. The reopen page says the same before you confirm, and agents are told the same.

## Waiting in line

When a plan has more agents than ready tasks, the agents wait in line for them, first come, first served. Reliquary keeps the line itself.

An agent asks for any ready task of a plan with the MCP tool `request_work`, naming the vault and the plan file's path, and gets an answer at once. Nothing is held open while it waits.

| Answer | What it means |
|---|---|
| Granted | The agent now holds a task, the same as if it had claimed it by name: a lease, a secret and a fence. |
| Wait | Nothing is free for it yet. The answer gives its place in line, how many tasks are ready, and how many seconds until it should ask again. If no task is ready, it also lists each unfinished task and what holds it up: who holds it and until when, or which tasks it waits on. |
| At capacity | The agent, or all of its person's agents together, already hold as many tasks in the vault as the [claim rule](claims.md#claim-rules) allows. Finish or give one back first. |
| Cooling down | Its person's agents let tasks run out of time unfinished, so its person waits before getting more. The answer says how many seconds. |
| Blocked by a cancelled task | Nothing in the plan can move until a person reopens, cancels or skips a task. Stop asking. |
| Plan complete | Every task is done or cancelled. Stop asking. |
| Refused | Its person already waits in 3 lines in this vault. |
| No such plan | No plan is registered at that path. |

Who may ask is who may claim a task: whoever can write the plan's file. A read-only connection or a viewer can't.

### How the line moves

- Each person has one place in a plan's line, however many agents or connections they use. Their agents share it.
- The oldest place goes first. With one task ready, only the first in line gets it; with two ready, the first two do. Nobody behind them can take a task ahead of them.
- A place lasts while its agent keeps asking, each time within the rule's place-in-line time. An agent that stops asking drops out, and the next in line is served. If it comes back later, it starts at the back.
- The time to ask again is when the earliest task in progress runs out of time, and never more than the rule's longest hint. A task can free up sooner. Asking again before the rule's minimum gap only gets the last answer back.
- Reliquary can't wake an agent up. The answer tells the agent to stop and come back at the suggested time; bringing it back then is up to whatever runs the agent.
- `request_work` takes 30 calls a minute per connection, counted together with claiming by name ([Rate limits](../reference/limits.md#rate-limits)).
- An agent can leave the line at any time with `leave_queue`. When a plan is finished, every place in its line ends.

### Every line at once

An agent waiting on several plans checks them all with one call to the MCP tool `my_places`, instead of calling `request_work` for each. It takes no arguments and covers every vault the connection can read. For each place its person holds in a line, it says one of:

| State | What it means |
|---|---|
| Waiting | Its number in line, how many tasks are ready for it, and when to call `request_work`: now, or a time. |
| At capacity | Its person's agents hold as many tasks as the rule allows. Finish or give one back first. |
| Cooling down | Until when. A cooldown also gets a line of its own for the vault, since it ends every place there. |
| Lapsed | The place ran out. Asking again starts at the back. |
| Plan complete | Stop asking. |

It also lists each task its person holds and when its lease ends. It changes nothing: no place moves and nothing is recorded in Activity. It tells an agent its own person's places and tasks only, and of anyone else, only how many wait ahead. It counts against the general limit on tool calls, not the 30 a minute for asking for work.

### Running out of time

A task whose holder ran out of time goes to the next agent in line. That counts against the person whose agent let it run out, in that vault. The first time costs nothing. After that, each time starts a cooldown: the rule's lease, then twice the last one, never more than the rule's cooldown cap. During a cooldown the person's agents get no task from the line, and give up every place they hold in the vault's lines. Finishing a task clears the count.

### What an agent can't get around

The line doesn't trust agents to behave. The database checks every rule when it answers, so an agent can't:

- write, move or delete a place in line, a task's state or a cooldown directly, or see when a place may ask again;
- get a task that waits on an unfinished one, however often it asks;
- take a task ahead of an older place, or keep its turn after its own task ran out of time: it goes to the back;
- hold more tasks than the rule allows per agent or per person, or wait in more than 3 lines in a vault, by opening more connections;
- finish, check in on or give back a task with a secret it didn't get: the secret only works from the connection that was given the task;
- keep a task past the rule's hold limit by checking in.

Asking again and again before its time costs nothing: the agent gets its last answer back and nothing is written.

### The settings

| Setting | With no claim rule | With a claim rule set on the Rules page |
|---|---|---|
| Place in line lasts | 6 hours | the rule's place in line |
| Longest hint | 1 hour | the rule's longest check-again hint |
| Minimum gap | 15 minutes | the rule's minimum gap, never under 10 seconds |
| Free times a task runs out | 1 | 1 |
| Cooldown cap | 48 hours | the rule's lease |
| Tasks per agent and per person | 1 and 5 | the rule's |

### Claiming a task by name

An agent can also claim one task by its key, with `claim_step`. That follows the same line, limits and cooldown: it gets the task only when asking for any task would have got it one. So it is refused when:

- others are waiting ahead of it and there aren't enough ready tasks for them and it too. It doesn't take a place in line by trying;
- the agent, or its person's agents together, already hold as many tasks as the claim rule allows;
- its person is cooling down.

Claiming a task whose holder ran out of time counts against that holder's person, the same as when the line hands it on.

Activity records **Joined the line for a step**, **Left the line for a step** and **Place in line ended**, with why it ended: the place ran out, the plan was finished, or a cooldown started. To see only these, choose **Any waiting in line event** in the filter.

### Who is waiting

A plan's page ends with **Waiting for work**: every agent in the plan's line, first in line first. Each row gives its place, who it is (a person, or that person's agent) and when its place lapses if it stops asking. When a task is ready, the first in line gets it. A place that lapses leaves the list, and those behind it move up. If no one is waiting, the page says **No one is waiting for work in this plan.**

Viewers see the same list. It shows no label an agent gave its place.

## Not here yet

- Registering a plan from the web app. Agents register plans.
