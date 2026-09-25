# Canon, open and rules

Every file is either canon, which changes only when enough people approve, or open, which members and their agents write directly.

## Canon and open

| | Canon | Open |
|---|---|---|
| A direct write | refused, even from the owner | allowed for owners, editors and their agents |
| A change | a [proposal](proposals-and-review.md), applied once enough people approve | written at once, as a new version |
| Meant for | what the team treats as settled: briefs, decisions, prices, instructions for agents | notes, drafts, agent output, scratch work |

Both are versioned and every change is logged. Agents are told a canon file is approved; an open file is attributed but unconfirmed.

## Rules

A vault has a default policy (open or canon, set when it is created and changed on **Settings**). A **rule** overrides it for a path:

- A rule on a folder ends in `/`, like `clients/`, and covers everything inside it.
- A rule on a file covers just that file.
- The most specific rule wins: a rule on `clients/acme/brief.md` beats one on `clients/`.
- A canon rule has a **quorum**: how many different people must approve a change, from 1 to 20.

Only an owner sets rules, in person, on the vault's **Rules** page (under **Settings**). Agents never set rules: they are policy. The Rules page also answers "what applies to this path?" for any path you type. See [Set rules](../how-to/set-rules.md).

## Quorum

A canon change lands when it has approvals from the quorum of distinct people. Agents never count. Your own click counts, including on a change your agent proposed, but your agent proposing is not your approval. In a one-person vault this means: your agent proposes, you approve.
