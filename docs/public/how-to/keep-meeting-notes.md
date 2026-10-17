# Keep call and meeting notes

Keep each transcript or set of call notes as it came, let your agent write its notes about it somewhere else, and propose the decisions that matter to canon. Every note then points back to what it came from.

## What Reliquary does and doesn't do

Reliquary doesn't record, transcribe or summarise anything. No model runs on your files. Your own agent, from whichever vendor you use, does the transcribing and summarising and writes the result into the vault with `write_file` or `propose`. Reliquary keeps the files, their versions and the references between them.

## The layout

| Folder | Holds | Who writes it |
|---|---|---|
| `sources/` | raw material: transcripts, call notes, chat exports, as they came | your agent, once |
| `notes/` | your agent's notes about a source: summary, action items, open questions | your agent, as often as it likes |
| `decisions/` | what was decided, once a person agrees | proposals, approved by a person |

For example, after a kickoff call with a made-up client:

- `sources/2026-10-14-acme-kickoff.md`: the transcript, unchanged.
- `notes/2026-10-14-acme-kickoff.md`: the agent's summary. Its first line is `Source: [[sources/2026-10-14-acme-kickoff]]`.
- `decisions/acme-launch-date.md`: the launch date, proposed by the agent, approved by you, linking the note and the source.

## Keep sources as they came

Tell your agent to write each source once, to a new path, and never edit it after. A summary or a correction goes in `notes/`, not in the source.

Reliquary has no write-once setting. A rule gets you close: make `sources/` canon with 1 approval (see [Set rules](set-rules.md)). Then each new source arrives as a proposal, you approve it, and any later change to it needs your approval too, so nothing rewrites a transcript without you seeing it. The cost is one approval per source. If that is too much, leave `sources/` open and rely on the instruction: every write is still versioned and logged (see [Changes and the log](../concepts/activity.md)), so an edit can be seen.

Don't name yourself an owner of `sources/` for this: a named owner's agents write the path directly, with no review (see [Path ownership](../concepts/path-ownership.md)).

## Link each note to its source

Each note links the source it came from with `[[path]]`, like `[[sources/2026-10-14-acme-kickoff]]`. The source's page in the web app then lists the note under **Referenced by**, and an agent can call `related_files` on the source to find every note about it. See [References between files](../concepts/vaults-and-files.md#references-between-files).

Leave `notes/` open, so your agent writes there without asking.

## Propose the decisions

When a call settles something that matters, like a price, a date or a scope, the agent proposes it with `propose` to a canon folder such as `decisions/`, linking the note and the source. You read it under **Proposals** and choose **Approve**, **Request changes** or **Reject**. Only a person makes something canon. See [Proposals and review](../concepts/proposals-and-review.md).

## Tell your agent

Put the convention where your agent reads it, such as the vault's top `README.md`. For example:

```text
Calls and meetings:
- Write each transcript or set of call notes once, to sources/YYYY-MM-DD-topic.md. Never edit a source afterwards.
- Write your notes to notes/ with the same name. The first line links the source: Source: [[sources/YYYY-MM-DD-topic]].
- Notes are not sources. Never quote a note, yours or another agent's, as evidence; go back to the source.
- Propose decisions to decisions/ and link the note and the source.
```

Related: [Canon, open and rules](../concepts/canon-and-rules.md), [Agents and the ceiling](../concepts/agents.md).
