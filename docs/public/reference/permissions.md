# Permissions

What people and their agents can each do, where, and who may: every rule here is enforced by the database.

"Both" means a person in the web app and their agent over MCP, each within the person's role (viewers read only) and, for the agent, its connection's vaults and access. "Person" means only the person, signed in to the web app: the agent [ceiling](../concepts/agents.md).

## Files and proposals

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| List vaults | Home | `list_vaults` | both |
| Create a vault | Home, **New vault** | `create_vault` | both, once the account is [admitted](../concepts/plans-and-limits.md#invite-only); an agent needs a read-write connection to all its person's vaults |
| List, read and search files | a vault's pages, **Search** | `list_files`, `read_file`, `search` | both |
| Write or delete an open file | the file's **Edit** page | `write_file`, `delete_file` | both, owners and editors |
| Propose a write or a delete | the file's page, or saving a canon file | `propose` | both, owners and editors |
| Propose a stale proposal again | **Propose again** | `propose` with the same text | both |
| List proposals, read one and its thread | **Review**, a vault's **Proposals** | `list_proposals`, `read_proposal` | both |
| Revise your own proposal | **Revise** | `revise_proposal` | both, the proposer |
| Comment on a proposal | the proposal's page | `comment_on_proposal` | both, owners and editors |
| Approve, request changes, reject | the proposal's page | none | person, owners and editors |
| Edit, then approve | the proposal's page | none | person, owners and editors |
| Snooze or unsnooze in Review | the proposal's page or row | none | person |
| Follow changes | **Activity**, a file's **History** | `changes_since` | both |

## Vault settings, members and access

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| Set or remove a rule | **Settings**, **Rules** | none | person, owners |
| Rename a vault or change its default policy | **Settings** | none | person, owners |
| See members (by email) | **Settings**, **Members** | none | person, any member |
| Invite, change roles, remove members | **Members** | none | person, owners |
| Accept an invite | the invite link | none | person, the invited address |
| Leave a vault | **Settings**, **Leave this vault** | none | person, any member while another owner remains |
| See and cut members' agent connections | **Members** | none | person, owners |
| Create or revoke a token | **Tokens** | none | person |
| Allow an OAuth client or the CLI | the consent page | none | person |
| Erase a file | the file's **More**, **Erase** | none | person, owners |
| Export a vault | **Settings**, **Export** | none | person, owners |
| Delete a vault | **Settings**, **Danger zone** | none | person, owners |

## Environment variables

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| List names, environments, who set them | **Variables** | `list_variables` | both |
| Set, rotate or delete a value | **Variables** | none | person: owners everywhere, editors outside owners-only environments |
| Reveal one value | **Reveal** | none | person, same as setting |
| Use values in a process | none | none | person, through the CLI: `reliquary run`, `reliquary env pull` |
| Import a `.env` | **Import .env** | none (an agent runs `reliquary env push`) | a person applies; a CLI sign-in allowed to push sends |
| Apply or reject a push | the import's page | none | person, owners and editors |
| Add, rename or delete environments | **Environments** | none | person, owners |
| Read the access log | **Access log** | none | owners and editors |

## Roles at a glance

| | Owner | Editor | Viewer |
|---|---|---|---|
| Read files, proposals, activity, variable names | yes | yes | yes |
| Write open files, propose, comment | yes | yes | no |
| Approve, request changes, reject | yes | yes | no |
| Set variables | every environment | not owners-only | no |
| Rules, members, settings, export, delete, erase | yes | no | no |
