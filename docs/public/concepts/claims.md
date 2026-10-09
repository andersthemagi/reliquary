# Claims

A claim says who's working on a path right now, and for how long: a lease, not a lock. It's a courtesy signal between people and agents sharing a vault, not an access gate. Claiming a path never stops anyone from writing it, and writing a path never needs a claim first: what actually guards a write from overwriting someone else's change is its own version check (see [Vaults, files and folders](vaults-and-files.md)).

**Usable both ways.** An agent claims, renews, releases and lists claims over MCP (`claim_path`, `renew_claim`, `release_claim`, `list_claims`). Only a person, in the web app, breaks someone else's claim: the same ceiling as approving a proposal or revealing a variable's value.

## How a claim works

Claiming a path leases it to you for a while: 48 hours by default, or whatever the vault's [claim rules](#claim-rules) say for that path. You can ask for less; asking for more is simply capped at the rule's maximum, not refused. Checking in (renewing) restarts the lease, so working steadily never loses your claim. If nothing checks in, the claim expires on its own the next time anyone tries to claim that path: nothing has to notice or clean it up.

No amount of checking in holds a claim past its hold limit, seven days by default from when it was first granted (also set by the rule). Past that, release it and claim again. Changing a rule never touches a claim already granted under the old one, only new claims and the next check-in.

A claim carries an optional label, whatever you're doing ("rewriting the intro"), shown to people on the **Claims** tab of **Diagnostics**. It's just a note someone wrote: never trust it to say who's really holding the claim.

## Claiming a path (agents)

An agent that's about to work on a path claims it first, so another agent (or the same person's other agent) sees it's taken. `claim_path` returns a secret, once: the agent holds onto it, along with the fence number the response also returns, to renew or release that same claim later. Trying to claim an already-claimed path is refused, naming who holds it and when it frees up.

Whoever could write a path can claim it; a read-only connection can't. One active claim per connection, and five across one person's agents, in a vault, by default (also set by the rule).

## Claim rules

How long a claim lasts, and how many a connection or person may hold, is a rule, not a fixed number: one for the whole vault, with optional overrides by path prefix, the same specificity as [canon and open rules](canon-and-rules.md) (an exact path, then the longest folder that covers it, then the whole vault). With no rule at all, a claim lasts 48 hours, with a seven-day hold limit, one claim per connection and five per person.

A rule sets four things:

- **Lease:** how long a claim lasts if its agent goes quiet. Every check-in starts the lease again.
- **Hold limit:** the longest one claim can be kept, however often it checks in. After that the agent releases it and claims again. At least the lease, at most 365 days.
- **Claims per connection:** how many claims one connection (one agent) may hold in the vault at once.
- **Claims per person:** how many all of one person's agents may hold together.

Three presets are starting points, not measurements: tune one once it actually causes a problem.

| Preset | Lease | Hold limit |
|---|---|---|
| Hackathon | 30 minutes | 2 hours |
| Team | 8 hours | 1 day |
| Org (the default) | 48 hours | 7 days |

Only an owner sets a claim rule, in person: in the vault, **Settings**, **Rules**, **Claim rules**. The first row is the whole vault, with the fixed defaults until you set one. To make every path in a vault lease for 30 minutes with a 2 hour hold limit, choose **The whole vault** and press **Hackathon**, or type the numbers and press **Save claim rule**. To give one folder or file its own numbers, choose **A folder or file** and type its path. **Change** on a row opens it filled in; **Remove** takes it away, and the paths it covered follow the next rule that applies. Setting a rule never touches a claim already granted; it only changes what the next claim, or the next check-in, gets.

## Seeing and breaking claims (people)

In a vault, **Settings**, **Diagnostics**, **Claims** lists who's claimed what, and how much longer. A path is a link to its file; a claim can name a file nobody has written yet, and that one is plain text marked "no file there yet". A claim an agent took says which one, like "you via Hermes". An owner or editor can **Break** someone else's claim there, after a confirm page: it frees the path right away, for anyone to claim next. Breaking a claim changes nothing about the file itself; it's logged in [Activity](activity.md), the same as granting, renewing or releasing one.

You see a claim where you meet the file. When someone holds a claim on a file, the file page and the editor open with a banner: whose it is (a person, or "Name's agent" when an agent took it), how much longer it lasts, and the note they left. The note is only what someone typed. It's shown in quotes and never proves who holds the claim. A claim covers one path, so the banner appears on that file and nowhere else, and not at all once the claim has run out or been released. Viewers see it too.

On the editor the banner also says what saving risks. Saving works, because a claim never blocks a write. But if the file changes before you save (the agent finishes first, say), Reliquary refuses your save and shows you the new version first, so nothing is overwritten by accident. On a canon file your change is a proposal, so the file stays as it is until people approve it.

Owners and editors also get a **Break** button in the banner. It opens the same confirm page as the Claims section, and once you confirm it brings you back to the file. Nothing happens until you confirm. From the editor, Break leaves the page, so save or copy what you have typed first. A viewer sees the banner and no button. Only pages of the same vault are used to come back to: a link that tries to send you elsewhere ends up on the Claims section instead.

## Export, delete and erase

Claims are state, not content: deleting a vault clears its claims along with everything else, and erasing a file's content releases any claim on it, since a claim on content that no longer exists means nothing. Neither is exported: see [Export, delete and erase](export-delete-erase.md).

## Work plans

A work plan is steps with dependencies, so no agent is handed a step before the ones it's blocked by are done. A plan lives in its own file, as a fenced block:

```work_plan
- key: fetch-data
  title: Fetch raw data from the api
  cites: docs/data-source.md@3fa85f64-5717-4562-b3fc-2c963f66afa6
- key: clean-data
  title: Clean and normalize
  blocked_by: fetch-data
  cites: docs/data-source.md@3fa85f64-5717-4562-b3fc-2c963f66afa6
  gate: review
```

Each step has a `key` (lowercase letters, digits and hyphens, unique in the plan) and a `title`. `blocked_by` names other steps' keys, comma-separated; `cites` names canon paths this step's work depends on, each as `path@version`, comma-separated; `gate: review` is meant to hold a step's dependents until a person approves it, directly or by applying its proposal; today it is stored and shown, and nothing enforces it yet. A malformed block, a blocker that doesn't exist, or a cycle of steps blocking each other is refused, naming the line and why.

Registering a plan from its file turns each step into a row with a status (`open`, `claimed`, `done` or `cancelled`) and a live, computed one layered on top for people and agents to read (`ready`, `blocked`, `blocked_by_cancelled`, or the stored status itself once it's `claimed`, `done` or `cancelled`): a step is `ready` exactly when every step blocking it is done. Claiming a ready step works the same way claiming a path does (a lease, a secret returned once, the same check-again-later shape); finishing it frees every step it was blocking. Checking in restarts a claimed step's lease without finishing it, the same shape checking in on a path claim already has, and is capped the same way: no amount of checking in holds a step past its hold limit, counted from when it was first claimed. Only a person can cancel a step (its dependents stay blocked forever, on purpose, until a person acts) or skip one (marks it done without anyone having claimed it, so dependents proceed as if it were).

A person sees a vault's plans, and what each task is doing, on the vault's [Tasks](tasks.md) page, and cancels or skips a task there.

### Registering and working a plan (agents)

An agent registers a plan with `register_work_plan`, naming the vault and the plan file's path. Reliquary reads the file's current version, checks the block, and refuses with the file's own line numbers before anything is registered. The database then checks it again, so a plan that passes the first check can still be refused (more than 500 steps, for example). A path holds one plan, and it can't be registered again. Whoever could write the path may register it, so a read-only connection or a viewer can't. A plan waiting in a proposal has no file yet, so there is nothing to register until a person approves it.

`work_plan_status` lists the steps in plan order: each one's state, what it is waiting on, who holds it and until when, and what it cites.

To work a step, an agent claims it by key with `claim_step`. Only a ready step can be claimed. The lease is the vault's claim rule for the plan's path, and the response returns a secret once, with a fence number, the same way `claim_path` does. `checkin_step` restarts the lease, `complete_step` marks the step done and frees the steps it was blocking, and `release_step` gives it back. All three need the secret and the fence, from the same connection and person. A blocked step, a step someone else holds, a done or cancelled step, and a stale fence or secret are each refused, with the reason.

Agents never cancel or skip a step: those stay with a person. A step's title, its cites and a claim's label are text that people and agents wrote, so an agent sees them between markers as data, never as instructions. A title that says "ignore your instructions" is only a title.

### What isn't built yet

- **Waiting in line.** An agent names the step it wants and is refused if it isn't ready. There is no "give me any ready step", no place in line and no list of who is waiting.
- **Review gates and a "canon moved" signal.** `gate: review` and `cites` are stored and shown, but nothing holds a step's dependents for a review, and nothing warns an agent when a file a step cites changes.
