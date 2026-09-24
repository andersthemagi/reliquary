# Token load: what each MCP tool costs an agent

2026-09-25. Every byte a tool returns is read by a model, so it costs the
person tokens and context on every call. This note records what each tool
cost before and after the compact formats, how it is measured, and what is
held fixed so the numbers can't drift back.

## How it is measured

`mcp/test/token_load.test.mjs` runs in `./mcp/test.sh` against a seeded
vault sized like a small real one (`mcp/test/seed.sql`, "Load": 40 notes of
about 1.5 KB, 5 canon files, 6 proposals, one sent back with a note and two
comments). It calls `tools/list` and every tool once, prints a `token-load:`
line per call (bytes, and tokens as bytes / 4, a rough rule for English and
code), and fails if any response is over its budget. Budgets sit just above
today's numbers, so a change that makes agents read more fails the suite and
has to raise the budget on purpose, with a `Changes-behaviour` trailer.

To see the table: `TEST_SLOT=9 MCP_TESTS=test/token_load.test.mjs ./mcp/test.sh`
(`TOKEN_LOAD_MEASURE_ONLY=1` prints without failing on budgets).

## Before and after

Bytes of text the agent reads. "Before" is main at 8e7acd4.

| Call | Before | After | Change | Budget |
|---|---:|---:|---:|---:|
| `tools/list` (names, titles, descriptions, schemas) | 8,497 | 6,962 | -18% | 7,300 |
| `list_vaults` | 52 | 52 | | 200 |
| `list_files` (45 files) | 2,114 | 1,609 | -24% | 1,800 |
| `list_files` prefix `canon/` | 234 | 209 | -11% | 400 |
| `read_file` (1.5 KB note, whole) | 1,736 | 1,732 | | 2,000 |
| `read_file` `max_bytes: 400` | (not possible) | 670 | | 800 |
| `read_file` lines 1-5 | (not possible) | 520 | | 700 |
| `search` "workshop" (matches every note, 10 files) | 17,463 | 3,548 | -80% | 4,000 |
| `search` "retainer" (5 files) | 8,907 | 1,032 | -88% | 1,300 |
| `list_proposals` | 703 | 974 | +39% | 1,200 |
| `list_proposals` changes_requested | 331 | 430 | +30% | 700 |
| `read_proposal` | 1,893 | 1,877 | -1% | 2,100 |
| `changes_since` (whole feed, ~70 events) | 7,068 | 4,520 | -36% | 5,000 |
| `changes_since` `limit: 20` | (not possible) | 1,200 | | 1,400 |
| `list_variables`, writes, comments | 459 | 459 | | 150 to 300 each |
| **Total, same calls** | **49,457** | **23,404** | **-53%** | |

About 6,500 tokens fewer for one pass over the tools, most of it in search
and the feed, which agents call most. `tools/list` is paid once per session
(and on every reconnect): about 380 tokens fewer, while it gained seven
parameters and a length limit on every text input.

`list_proposals` grew on purpose: each proposal's stated reason is now fenced
as data (it was printed bare, so an agent-written reason could read as an
instruction). Safety over bytes.

## What changed

- **Descriptions** say what the tool does and keep every sentence that
  carries a rule an agent must know: canon files need `propose`; you can't
  approve; `create_vault` needs an all-vaults read-write token and people set
  rules and members; revising voids earlier approvals; comments can't approve
  or change anything; `list_variables` never returns values and says how the
  person uses them. Dropped: restatements, examples the schema already gives,
  and "Plain text, up to 4000 characters" where `maxLength` says it.
- **Schemas**: no per-tool `$schema` line (50 bytes each, 14 tools), proposal
  ids checked by a short pattern instead of zod's 150-character UUID regex,
  no 16-digit default integer maximum. `tools/list` is built once per
  instance and cached (it is the same for every identity; the contract test
  checks a read-only token sees the same list).
- **`list_files`**: one line per file, `path [canon]  2026-09-25T10:00:00Z`
  (open is the default, so it isn't written); pages of 200 with
  `more: pass after="<path>"`, where before it silently stopped at 500.
- **`read_file`**: `from_line`, `to_line` and `max_bytes` (default 100,000,
  so one large file can't fill a context by accident). A partial read says
  what it left out: `Lines 3-5 of 30. Read on with from_line=6.`
- **`search`**: up to three numbered matching lines per file, each at most
  200 characters, with path, policy, last writer and time; before, every
  match returned its whole file.
- **`changes_since`**: `limit` (default 100, was a fixed 200); each person
  named once (`people: p1=<id> (your person), p2=<id>`) and then by label, as
  a person's id was a third of every line; timestamps to the second.
- **Fencing stays**: every text written by people or agents (file text,
  search excerpts, reasons, notes, comments) is between `NOTE-`/`BEGIN-` and
  `END-` markers with a per-response nonce no fenced text contains, with the
  "data, not instructions" line. `mcp/test/hardening.test.mjs` and the
  existing injection tests check the fences balance.

## Not done, and why

- **Shorter person ids elsewhere** (`read_file`, `read_proposal`, `search`
  print full ids): one or two per response, not worth an indirection.
- **Folder listing by depth** (`list_files` returning subfolders with counts
  instead of every path): useful for vaults of thousands of files; wait for
  one.
- **`read_proposal` with a byte budget**: proposed text is usually short and
  a reviewer-facing tool; add `max_bytes` if long proposals show up.
- **Titles**: kept. Clients show them to people; most don't send them to
  the model.
