# Claims

A claim says who's working on a path right now, and for how long: a lease, not a lock. It's a courtesy signal between people and agents sharing a vault, not an access gate. Claiming a path never stops anyone from writing it, and writing a path never needs a claim first: what actually guards a write from overwriting someone else's change is its own version check (see [Vaults, files and folders](vaults-and-files.md)).

**Usable both ways.** An agent claims, renews, releases and lists claims over MCP (`claim_path`, `renew_claim`, `release_claim`, `list_claims`). Only a person, in the web app, breaks someone else's claim: the same ceiling as approving a proposal or revealing a variable's value.

## How a claim works

Claiming a path leases it to you for a while: 48 hours by default, or whatever the vault's [claim rules](#claim-rules) say for that path. You can ask for less; asking for more is simply capped at the rule's maximum, not refused. Checking in (renewing) restarts the lease, so working steadily never loses your claim. If nothing checks in, the claim expires on its own the next time anyone tries to claim that path: nothing has to notice or clean it up.

No amount of checking in holds a claim past its hold limit, seven days by default from when it was first granted (also set by the rule). Past that, release it and claim again. Changing a rule never touches a claim already granted under the old one, only new claims and the next check-in.

A claim carries an optional label, whatever you're doing ("rewriting the intro"), shown to people on the vault's Claims page. It's just a note someone wrote: never trust it to say who's really holding the claim.

## Claiming a path (agents)

An agent that's about to work on a path claims it first, so another agent (or the same person's other agent) sees it's taken. `claim_path` returns a secret, once: the agent holds onto it, along with the fence number the response also returns, to renew or release that same claim later. Trying to claim an already-claimed path is refused, naming who holds it and when it frees up.

Whoever could write a path can claim it; a read-only connection can't. One active claim per connection, and five across one person's agents, in a vault, by default (also set by the rule).

## Claim rules

How long a claim lasts, and how many a connection or person may hold, is a rule, not a fixed number: a vault-wide default, with optional overrides by path prefix, the same specificity as [canon and open rules](canon-and-rules.md) (an exact path, or the longest folder prefix that covers it). With no rule at all, a claim lasts 48 hours, with a seven-day hold limit, one claim per connection and five per person.

Three presets are starting points, not measurements: tune one once it actually causes a problem.

| Preset | Lease | Hold limit |
|---|---|---|
| Hackathon | 30 minutes | 2 hours |
| Team | 8 hours | 1 day |
| Org (the default) | 48 hours | 7 days |

Only an owner sets a claim rule, in person, on the vault's **Rules** page. Setting one never touches a claim already granted; it only changes what the next claim, or the next check-in, gets.

## Seeing and breaking claims (people)

Every vault has a **Claims** section listing who's claimed what, and how much longer. An owner or editor can **Break** someone else's claim there, after a confirm page: it frees the path right away, for anyone to claim next. Breaking a claim changes nothing about the file itself; it's logged in [Activity](activity.md), the same as granting, renewing or releasing one.

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

Each step has a `key` (lowercase letters, digits and hyphens, unique in the plan) and a `title`. `blocked_by` names other steps' keys, comma-separated; `cites` names canon paths this step's work depends on, each as `path@version`, comma-separated; `gate: review` holds a step's dependents until a person approves it directly, or its proposal is applied. A malformed block, a blocker that doesn't exist, or a cycle of steps blocking each other is refused, naming the line and why.

Registering a plan from its file turns each step into a row with a status (`open`, `claimed`, `done` or `cancelled`) and a live, computed one layered on top for people and agents to read (`ready`, `blocked`, `blocked_by_cancelled`, or the stored status itself once it's `claimed`, `done` or `cancelled`): a step is `ready` exactly when every step blocking it is done. Claiming a ready step works the same way claiming a path does (a lease, a secret returned once, the same check-again-later shape); finishing it frees every step it was blocking. Checking in restarts a claimed step's lease without finishing it, the same shape checking in on a path claim already has, and is capped the same way: no amount of checking in holds a step past its hold limit, counted from when it was first claimed. Only a person can cancel a step (its dependents stay blocked forever, on purpose, until a person acts) or skip one (marks it done without anyone having claimed it, so dependents proceed as if it were).

Nothing in Reliquary registers or claims a plan yet through MCP or the web app: today this is only the database's own mechanism, proven by its hostile tests, with no tool or page that calls it. That's the next piece of this effort (tracking issue [#52](https://github.com/andersthemagi/reliquary/issues/52)).
