# Permissions

What people and their agents can each do, where, and who may: every rule here is enforced by the database.

"Both" means a person in the web app and their agent over MCP, each within the person's role (viewers read only) and, for the agent, its connection's vaults and access. "Person" means only the person, signed in to the web app: the agent [ceiling](../concepts/agents.md).

## Files and proposals

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| List vaults | Home | `list_vaults` | both |
| Create a vault | Home, **New vault** | `create_vault` | both, once the account is [admitted](../concepts/plans-and-limits.md#who-can-create-vaults); an agent needs a read-write connection to all its person's vaults |
| List, read and search files | a vault's pages, its **Search**, the top bar's search (every vault at once) | `list_files`, `read_file`, `search` | both |
| Write or delete an open file | the file's **Edit** page; the file's **More**, **Delete file** | `write_file`, `delete_file` | both, owners and editors |
| Propose a write or a delete | the file's **Propose a change**, or **More**, **Propose deleting**; **New file** in a canon folder | `propose` | both, owners and editors |
| Propose a stale proposal again | **Propose again** | `propose` with the same text | both |
| List proposals, read one and its comments | **Inbox**, a vault's **Proposals** | `list_proposals`, `read_proposal` | both |
| Revise your own proposal | **Revise** | `revise_proposal` | both, the proposer |
| Comment on a proposal | the proposal's page | `comment_on_proposal` | both, owners and editors |
| Open a [thread](../concepts/threads.md), post in one, resolve or reopen it | **Threads**, **New thread**; in a thread, **Post message** and **Resolve thread** or **Reopen thread** | `open_thread`, `post_message` | both, owners and editors |
| List a vault's threads and read one | **Threads** | `list_threads`, `read_thread` | both |
| Redact a thread message | a message's **Redact…** in its thread | none | person, owners |
| Approve, request changes, reject | the proposal's page | none | person, owners and editors |
| Edit, then approve | the proposal's page | none | person, owners and editors |
| Snooze or unsnooze in the Inbox | the proposal's page or row | none | person |
| Follow changes | **Changes**, the **Log** (under **Diagnostics**), **Activity**, a file's **History** | `changes_since` | both |
| Claim a path, renew or release your own [claim](../concepts/claims.md) | none | `claim_path`, `renew_claim`, `release_claim` | agent, owners and editors (whoever could write the path) |
| See a vault's active claims | **Settings**, **Diagnostics**, **Claims** | `list_claims` | both |
| Break someone else's claim | **Diagnostics**, **Claims**, **Break** | none | person, owners and editors |
| Register a plan file as a [work plan](../concepts/claims.md#work-plans) | none (agents register plans) | `register_work_plan` | agent, owners and editors (whoever could write the path) |
| See a work plan's steps | **Tasks** | `work_plan_status` | both, any member |
| Claim a step, check in on it, complete it or give it back | none | `claim_step`, `checkin_step`, `complete_step`, `release_step` | agent; claiming: whoever could write the path; the rest: the step's holder |
| Cancel or skip a step | **Tasks**, a task's **Cancel** or **Skip** | none | person, owners and editors (whoever could write the path) |

## Links

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| Add, edit or delete a [link](../concepts/links.md) | a vault's **Links**, **Add link**; a row's **Edit** or **Delete** | none | person, owners |
| Grant a link's tools to roles | a link's **Grants** | none | person, owners |
| List a vault's links (name and url, never the credential) | **Links** | `list_links` | both, read-only connections too |
| Call a granted link tool | none | `<link>.<tool>`, listed in `tools/list` | agent, with a role the tool is granted to; a write tool also needs a write-capable connection |

## Flags

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| See what is [flagged](../concepts/flags.md) for you | **Settings**, **Diagnostics**, **Flags** | `list_flags` | both, your own only |
| Mark flags shown | opening the **Flags** page | `advance_flags` | both, your own only; you and each connection keep separate places |

## Vault settings, members and access

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| Set or remove a rule | **Settings**, **Rules** | none | person, owners |
| Set, change or remove a [claim rule](../concepts/claims.md#claim-rules) | **Rules**, **Claim rules** | none | person, owners |
| Name or remove a path's [owners](../concepts/path-ownership.md) | **Rules**, a rule's **⋯**, **Named owners** | none | person, owners |
| Watch or unwatch a folder or file for [flags](../concepts/flags.md) | its page's **Watch**; **Settings**, **Watching** | none (`list_subscriptions` lists them) | person, any member, their own only |
| Rename a vault or change its default policy | **Settings**, **General** | none | person, owners |
| See members (by email) | **Settings**, **Members** | none | person, any member |
| Invite, change roles, remove members | **Members** | none | person, owners |
| Accept an invite | the invite link | none | person, the invited address |
| Leave a vault | **Settings**, **Danger zone**, **Leave this vault** | none | person, any member while another owner remains |
| See and cut members' connections | **Members** | none | person, owners |
| Create or revoke a token | **Connections** (the account menu) | none | person |
| Set your display name | **Account settings** | none | person, for themself only |
| Change your email address, sign out everywhere or delete your account | **Account settings** | none | person, for themself only |
| Allow an OAuth client or the CLI | the consent page | none | person |
| Erase a file | the file's **More**, **Erase file** | none | person, owners |
| Export a vault | **Settings**, **Export** | none | person, owners |
| Delete a vault | **Settings**, **Danger zone** | none | person, owners |

## Feedback

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| Send feedback or a bug report to the operator | the top bar's **Feedback**, the **Feedback** page | `send_feedback` | both, any connection (read-only ones too); a vault named must be one you, and the connection, can see |
| See your feedback, its status and replies | the **Feedback** page | `list_my_feedback` | both, your own only; over MCP, without the text you typed in the web app |
| Set a status or reply | none | none | the operator of the site only |

## Environment variables

| Action | Web app | MCP tool | Who may |
|---|---|---|---|
| List names, environments, who set them | **Variables** | `list_variables` | both |
| Set, rotate or delete a value | **Variables** | none | person: owners everywhere, editors outside owners-only environments |
| Reveal one value | a value's **⋯** menu, **Reveal** | none | person, same as setting |
| Use values in a process | none | none | person, through the CLI: `reliquary run`, `reliquary env pull` |
| Import a `.env` | **Import .env** | none (an agent runs `reliquary env push`) | a person applies; the Reliquary CLI, if allowed to send `.env` files, sends |
| Apply or reject an import | the import's page (from the **Imports** tab) | none | person, owners and editors |
| Add, rename or delete environments | the **Environments** tab | none | person, owners |
| Read the access log | the **Access log** tab | none | owners and editors |

## Roles at a glance

| | Owner | Editor | Viewer |
|---|---|---|---|
| Read files, proposals, activity, variable names | yes | yes | yes |
| Write open files, propose, comment | yes | yes | no |
| Approve, request changes, reject | yes | yes | no |
| Set variables | every environment | not owners-only | no |
| Rules, members, settings, export, delete, erase | yes | no | no |
