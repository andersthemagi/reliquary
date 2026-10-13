# Work through a plan with agents

Write a plan, have agents work its tasks in order, and approve the ones that need a person. What each part means: [Tasks](../concepts/tasks.md).

The agent's steps are MCP tool calls; the person's are in the web app. Your agent needs a read-write connection to the vault, and you need to be an owner or editor (or a named owner of the plan file's path).

## 1. Write the plan

Create a file, such as `plans/launch.md`, with one fenced `work_plan` block:

```work_plan
- key: brief
  title: Write the launch brief
  gate: review
- key: page
  title: Draft the landing page from the brief
  blocked_by: brief
- key: emails
  title: Draft the launch emails from the brief
  blocked_by: brief
```

`gate: review` on `brief` means nothing that waits on it starts until a person approves it. A person or an agent can write the file. If the path is canon, the file exists only once its proposal is applied.

## 2. Register it (agent)

Call `register_work_plan` with the vault and `plans/launch.md`. A mistake in the block is refused with its line number; fix the file and register again. The plan now shows on the vault's **Tasks** page.

## 3. Ask for work and wait (agent)

Call `request_work` with the vault and the plan's path. The answer comes at once:

- **Granted:** you hold a task. Keep the fence and the secret: every later call on the task needs both, from this connection.
- **Wait:** your place in line, and when to ask again. Stop, and call `request_work` again at that time, not sooner: asking early only repeats the answer. Waiting on several plans, call `my_places` once to see them all.
- **Plan complete** or **blocked by a cancelled task:** stop asking. The second needs a person.

To give up a place you no longer need, call `leave_queue`.

## 4. Work the task (agent)

- Read the task with `work_plan_status`. If its state line says `context moved`, read the cited files again first.
- On long work, call `checkin_step` with the fence and secret before the lease runs out. A task whose lease runs out goes to the next agent in line, and letting tasks run out costs your person a cooldown.
- Can't finish it? Call `release_step` to give it back.

## 5. Finish the task (agent)

Call `complete_step` with the fence and secret. The tasks waiting on it become ready for whoever is next in line.

For a task with `gate: review`, the task is **Awaiting review** instead. If its work is a change to a canon file, propose the change first with `propose`, then pass that proposal's id as `proposal` to `complete_step`. Then tell your person the task is waiting for their review. You can't approve it yourself.

## 6. Approve it (person)

Open the vault's **Tasks**, then the plan. Tasks awaiting review come first.

- Check the work, choose **Approve** on the task, and confirm. Or, if its agent linked a proposal, approve that proposal in your **Inbox**: applying it approves the task too.
- Not ready? **Not yet** on the confirm page leaves it as it is. To drop the task, choose **Cancel**; to let what waits on it go ahead without it, **Skip**.

Once approved, `page` and `emails` are ready, and the agents waiting in line get them.

## 7. Add tasks (agent or person, then agent)

Add new steps to the plan file's block, each with a new key, and leave the existing ones exactly as they are. Then have an agent call `register_work_plan` again. The new tasks join the end of the plan; the others keep their state. A changed or missing step is refused by name, and nothing is added.

## 8. Reopen a cancelled task (person)

On the plan's page, a cancelled task has **Reopen**. If the work has changed since it was cancelled, add a new task that names the old one by its key instead (step 7). Reopen only when it really is the same task: it goes back in the plan, and what waited on it waits for it again.

Only a person can approve, cancel, skip or reopen a task. See [the ceiling](../concepts/agents.md#the-ceiling).
