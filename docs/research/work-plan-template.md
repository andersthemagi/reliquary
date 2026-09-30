# Work plan template, for the hand-run pilot

2026-09-30 · CL-0.3 of the claims, waiting and work plans effort (tracking
issue #52). Not a vault template a person picks from **New vault**: those
are product code (`web/src/templates.ts`), and work plans aren't a
Reliquary feature yet. This is a plain file to copy into a real vault by
hand, so the *social* pattern (checking `Blocked by`, writing status
separately, sending results as proposals) can be tried before any of
`work_plan`, `step` or `claim` exists as a tool (design: `docs/design.md`,
"Claims and work plans"; evidence the mechanism holds: `spikes/claims/`).

Copy the "Plan" section below into a vault as `plans/<name>.md`, canon (so
a person approves the plan itself before anyone starts), and create an
empty sibling `plans/<name>-status.md`, open, for agents to write in
directly.

## For agents

- **Read `Blocked by` before claiming a step.** If any step listed there
  isn't `Done` in the status file yet, don't start it: write a line in the
  status file saying you checked and it's still blocked, then come back
  later. Nothing enforces this yet; it is enforced by you reading it.
- **Write your status in the sibling status file, not the plan file.** The
  plan file is canon (a person approves changes to it); the status file is
  open, so write there directly: which step, who, since when, and what's
  blocking you if anything is.
- **Send a step's result as a proposal**, never straight to a canon path.
  Name the step's `Key` in your reason, so the person approving can see
  which step it closes.
- **If two agents pick up the same step, that's expected right now.**
  Claims don't exist yet, so nothing stops it. Say so in the status file;
  whichever proposal a person approves first wins, and the other agent
  should read the plan and status file again before trying anything else.

## Plan: `<name>`

`<One paragraph: what this plan is for, and what "done" looks like.>`

| Key | Title | Blocked by | Cites |
|---|---|---|---|
| 1 | `<first step>` | | `canon/<path>.md` |
| 2 | `<second step>` | 1 | `canon/<path>.md` |
| 3 | `<third step>` | 1, 2 | |

`Cites` names the canon paths a step's work depends on being current; an
agent reads them before starting, the same as it would read any other
file. `Blocked by` lists step `Key`s, not titles, so a rename never breaks
the graph.

## What to write down, for CL-0.3's Accept

Once a real vault runs this with two or more real agents, record here (or
in a note linked from the status file):

- **The number of times a step was started while blocked**: an agent that
  ignored, or misread, the `Blocked by` column.
- **Every overwrite**: two agents' proposals landing on the same step, or
  one agent's direct edit clobbering another's.
- **How many times an agent that found nothing to do checked the plan
  again before something had actually changed.** This is the number
  `request_work`'s wait state and check-again hint (`docs/design.md`,
  "Waiting without spinning") exist to bring down, once built; the pilot's
  count is the baseline it's measured against.
