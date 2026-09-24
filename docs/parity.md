# Parity: what people and agents can each do

2026-09-24. The rule is AGENTS.md's "an agent is its person, minus a
ceiling": an agent acting for someone over MCP can do what that person can,
except approving, revealing variable values, managing members, and deleting
or exporting a vault (docs/design.md, Delegation). Rules (which paths are
canon) are policy and stay with people too. So every action below should
exist on both sides unless the ceiling says otherwise, and where one side
lacks it the table says why: **ceiling** (on purpose, enforced by the
database) or **gap** (not built yet).

The database decides, not the surface: every "person only" here is
`private.require_human()` in the function, and every token limit is
`private.role_in()` (supabase/migrations). A surface that offered more would
still be refused.

`mcp/test/parity.test.mjs` fails if the MCP server offers a tool this table
doesn't name in its MCP column, or if the column names a tool that no longer
exists.

## The table

Routes: `:v` is a vault id, `:p` a proposal id. "Both" means a person in the
web UI and their agent over MCP, each within their role (viewers read only)
and, for the agent, its token's vaults and access.

| Action | Web UI | MCP | Who may | Why one side lacks it |
|---|---|---|---|---|
| List vaults | `/` (Your vaults) | `list_vaults` | both | |
| Create a vault | `/vaults/new` (POST) | `create_vault` | both | An agent needs a token that reaches all its person's vaults with read-write access; a scoped or read-only token is refused (`20260924230000_agent_create_vault.sql`) |
| List files | `/v/:v`, `/v/:v/tree?path=` | `list_files` | both | |
| Read a file | `/v/:v/file?path=` | `read_file` | both | |
| Search a vault | `/v/:v/search?q=` | `search` | both | |
| Write an open file | `/v/:v/new`, `/v/:v/edit`, POST `/v/:v/file` (`write`, `create`) | `write_file` | both | |
| Delete an open file | `/v/:v/edit` (Delete this file), POST `/v/:v/file` (`delete`) | `delete_file` | both | |
| Propose a write | POST `/v/:v/file` (`propose`, or `create` under canon) | `propose` | both | |
| Propose a delete | POST `/v/:v/file` (`propose-delete`) | `propose` with `delete: true` | both | |
| Propose a stale proposal again | POST `/v/:v/proposals/:p/repropose` | `propose` (same text) | both | |
| List proposals | `/v/:v/proposals`, `/review` | `list_proposals` | both | |
| Read a proposal and its thread | `/v/:v/proposals/:p` | `read_proposal` | both | |
| Revise your own proposal | `/v/:v/proposals/:p/revise` (POST) | `revise_proposal` | both | Only the proposer (the person whose agent proposed it counts as the proposer) |
| Comment on a proposal | POST `/v/:v/proposals/:p/comment` | `comment_on_proposal` | both | |
| Approve, request changes, reject | POST `/v/:v/proposals/:p/decide` | none | person | **Ceiling**: approving needs the person present |
| Edit, then approve | `/v/:v/proposals/:p/edit` (POST) | none | person | **Ceiling**: it approves. An agent revises its own proposal instead |
| Set or remove a rule (canon/open, quorum) | `/v/:v/rules` (POST; linked from Settings) | none | person (owner) | **Ceiling**: rules are policy. An agent picks a new vault's default policy when it creates one, and nothing after |
| Snooze a proposal in Review | POST `/v/:v/proposals/:p/snooze` | none | person | **Ceiling**: an agent that could snooze could hide its own proposals from its person's inbox |
| Unsnooze | POST `/v/:v/proposals/:p/unsnooze` | none | person (the database allows the agent) | **Gap**, and not worth closing: an agent has no inbox to bring things back into |
| Changes feed / activity | `/activity`, `/v/:v/activity`, a file's History tab | `changes_since` | both | The web pages are for reading; `changes_since` is a cursor feed for agents. Same log |
| Create a token | `/tokens` (POST `/tokens/new`) | none | person | **Ceiling**: grants are the person's (design: "managing grants") |
| Revoke a token | POST `/tokens/:id/revoke` | none | person (the database allows the agent) | **Gap**, deliberately left: an agent revoking tokens is grant management; see below |
| Approve an OAuth client (consent) | `/oauth/authorize` | none | person | **Ceiling**: consent is a grant, and must be a person |
| Connect an agent (setup help) | `/connect` | none | person | Not an action; there is nothing to do over MCP |
| Manage members | none | none | person (owner) | Web: **gap** (`set_member` exists in the database; only seeds and `./mcp/dev.sh` use it). MCP: **ceiling** |
| Erase a file (blank every version) | the file page's More menu, `/v/:v/erase?path=` (GET confirms: type the path; POST erases) | none | person (owner) | **Ceiling** (irreversible): `erase_file` is `require_human` |
| Rename a vault, change its default policy | `/v/:v/config` (POST, then a confirm page) | none | person (owner) | **Ceiling**: the default is policy, like rules, and a name is what every member navigates by. `rename_vault` and `set_default_policy` are `require_human` (`20260925120000_vault_admin.sql`) |
| Export a vault | `/v/:v/config/export` (GET explains; POST downloads a `.tar.gz`) | none | person (owner) | **Ceiling** (design: exporting needs the person present). `export_vault` and `export_files` are `require_human` and owners-only; logged as `vault.export`. Variable values are never exported, only names |
| Delete a vault | `/v/:v/config/delete` (GET confirms: type the name; POST deletes) | none | person (owner) | **Ceiling** (irreversible). `delete_vault` is `require_human`, owners-only, and checks the typed name itself |
| List environment variables (names, environments, who set them) | `/v/:v/variables` | `list_variables` | both | Names only, on both sides of MCP: no tool returns a value, a ciphertext or a nonce ([docs/variables.md](variables.md)) |
| Set, rotate or delete a variable's value | `/v/:v/variables/set` (GET, POST; Rotate is the same form with the name and environment fixed), `/v/:v/variables/delete` (GET confirms, POST deletes) | none | person (owners everywhere; editors outside production) | **Ceiling**: a value typed to an agent has already reached a model. `set_variable` and `delete_variable` are `require_human` |
| Reveal one value | POST `/v/:v/variables/reveal` (the value is in that response only, never a GET or a redirect) | none | person | **Ceiling** (design: revealing a value needs the person present). `reveal_variable` refuses any `act` claim and logs the refusal |
| Use values in a process | none (the CLI: `reliquary run`, `reliquary env pull`; set up from `/connect#cli`) | none | person, through the CLI | **Ceiling**: values never reach a model. The CLI signs in as its own OAuth client, bound to the env API; its grant reads values and nothing else |
| Read a vault's variable access log | `/v/:v/variables/log` (filters `action`, `name`; pages with `before`), and who read or revealed each value since it was set on `/v/:v/variables` | none | owner, editor | **Gap**, left on purpose: RLS lets an owner's or editor's read-write agent read `env_access_log`, but nothing needs a tool for it yet |

## Fixed in this change

- **Create a vault**: neither the web UI nor MCP could (only
  `./mcp/dev.sh vault`). Now both: a New vault action on Home with a
  first-vault empty state, and `create_vault` over MCP for all-vaults
  read-write tokens.
- **Delete an open file over MCP**: the database already let agents delete
  open files (`delete_file` uses `require_person`, not `require_human`), but
  there was no tool, so an agent had to propose a delete. Now `delete_file`.
- **Revise your own proposal in the web UI**: MCP had `revise_proposal`; a
  person could only "edit, then approve", which also approves. Now a Revise
  action for the proposer.

## Closed since (vault administration)

- **Erase a file** in the web UI: the file page's More menu, then a confirm
  page that says what erasure blanks and what the log keeps, with the path
  typed to confirm.
- **Rename a vault and change its default policy**: new database functions,
  owners in person, and a Settings page (`/v/:v/config`, "Settings" in the
  vault sidebar) that also holds Rules, Export and the Danger zone. Both stay
  off MCP: the default is policy, which the ceiling keeps with people.
- **Export and delete a vault**: owners in person, from Settings, each
  through a confirm step (docs/design.md, "Git mirror and export" and
  "Deleting a vault"). Both are in the delegation ceiling, so neither is an
  MCP tool.

## Gaps left

| Gap | Side | Why it's not in this change |
|---|---|---|
| Manage members (invite, change role, remove) | web | Needs a way to name a person who isn't in the vault (email lookup through Supabase Auth, or invitations), which is a design decision, not a form |
| Revoke a token | MCP | The database allows an agent to revoke its person's tokens (`revoke_access_token` is `require_person`). An agent cutting off other agents is grant management; decide whether to tighten the database to `require_human` rather than add a tool |
| Unsnooze | MCP | Allowed by the database, pointless for an agent; left out |
