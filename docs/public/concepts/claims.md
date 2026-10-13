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

A rule sets:

- **Lease:** how long a claim lasts if its agent goes quiet. Every check-in starts the lease again.
- **Hold limit:** the longest one claim can be kept, however often it checks in. After that the agent releases it and claims again. At least the lease, at most 365 days.
- **Claims per connection:** how many claims one connection (one agent) may hold in the vault at once. Held steps of a work plan count separately, under the same numbers.
- **Claims per person:** how many all of one person's agents may hold together.
- **Place in line, longest check-again hint and minimum gap:** how an agent waits for a task when none is free. See [Waiting in line](tasks.md#waiting-in-line) and [Limits and settings](tasks.md#limits-and-settings).

Three presets are starting points, not measurements: tune one once it actually causes a problem.

| Preset | Lease | Hold limit | Place in line | Longest hint | Minimum gap |
|---|---|---|---|---|---|
| Hackathon | 30 minutes | 2 hours | 15 minutes | 1 minute | 15 seconds |
| Team | 8 hours | 1 day | 2 hours | 15 minutes | 225 seconds |
| Org (the default) | 48 hours | 7 days | 6 hours | 1 hour | 15 minutes |

Each preset's minimum gap is a quarter of its longest hint, and its cooldown cap is its lease.

Only an owner sets a claim rule, in person: in the vault, **Settings**, **Rules**, **Claim rules**. The first row is the whole vault, with the fixed defaults until you set one. To make every path in a vault lease for 30 minutes with a 2 hour hold limit, choose **The whole vault** and press **Hackathon**, or type the numbers and press **Save claim rule**. To give one folder or file its own numbers, choose **A folder or file** and type its path. **Change** on a row opens it filled in; **Remove** takes it away, and the paths it covered follow the next rule that applies. Setting a rule never touches a claim already granted; it only changes what the next claim, or the next check-in, gets.

## Seeing and breaking claims (people)

In a vault, **Settings**, **Diagnostics**, **Claims** lists who's claimed what, and how much longer. A path is a link to its file; a claim can name a file nobody has written yet, and that one is plain text marked "no file there yet". A claim an agent took says which one, like "you via Hermes". An owner or editor can **Break** someone else's claim there, after a confirm page: it frees the path right away, for anyone to claim next. Breaking a claim changes nothing about the file itself; it's logged in [Activity](activity.md), the same as granting, renewing or releasing one.

You see a claim where you meet the file. When someone holds a claim on a file, the file page and the editor open with a banner: whose it is (a person, or "Name's agent" when an agent took it), how much longer it lasts, and the note they left. The note is only what someone typed. It's shown in quotes and never proves who holds the claim. A claim covers one path, so the banner appears on that file and nowhere else, and not at all once the claim has run out or been released. Viewers see it too.

On the editor the banner also says what saving risks. Saving works, because a claim never blocks a write. But if the file changes before you save (the agent finishes first, say), Reliquary refuses your save and shows you the new version first, so nothing is overwritten by accident. On a canon file your change is a proposal, so the file stays as it is until people approve it.

Owners and editors also get a **Break** button in the banner. It opens the same confirm page as the Claims section, and once you confirm it brings you back to the file. Nothing happens until you confirm. From the editor, Break leaves the page, so save or copy what you have typed first. A viewer sees the banner and no button. Only pages of the same vault are used to come back to: a link that tries to send you elsewhere ends up on the Claims section instead.

## Export, delete and erase

Claims are state, not content: deleting a vault clears its claims along with everything else, and erasing a file's content releases any claim on it, since a claim on content that no longer exists means nothing. Neither is exported: see [Export, delete and erase](export-delete-erase.md).

## Work plans

An agent holds a step of a [work plan](tasks.md) the same way it holds a claim on a path: a lease, a secret returned once and a fence, with checking in, giving it back and a hold limit, all set by the same claim rules. Unlike a path claim, a step is handed out in order: an agent gets one only when every step it waits on is done, and when it is its turn in line. See [Tasks](tasks.md).
