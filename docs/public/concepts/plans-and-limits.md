# Plans and limits

Your account's plan limits how many vaults you own. Each vault's tier limits how many people it holds and how much it stores. Nothing is billed yet.

## Who can create vaults

Reliquary is an open pre-alpha: anyone can make an account by signing in with their email. To keep a sudden rush from overwhelming the service, it lets in a limited number of new accounts a day. A new account takes one of the day's places when it creates its first vault. Once today's places are taken, creating a vault is refused until after midnight UTC.

An account doesn't need a place, and can create vaults at once, when:

- it opens an invite link and joins a vault (any invite, from anyone), or
- the operator puts it on a plan, or admits it, or
- it already took a place on an earlier day.

The operator can make Reliquary invite-only again, for example during a surge. Then sign-in makes new accounts only for invite links, and an account creates vaults only once it is admitted in one of the ways above. Accounts that already got in keep their place. The sign-in page says which way Reliquary is working. Without an invite while it's invite-only, use the page's **request access** link to ask the operator.

An account that can't create vaults yet belongs to no vault, so it sees nothing. **New vault** and **Plan and usage** say so (New vault shows no form), and creating a vault is refused with the reason (code `RLP02`), for the person and for their agent's `create_vault` alike. Over MCP the refusal reads `Not admitted:` and the message.

The operator can take admission back. The account keeps its vaults and memberships, and everything in them works as before, but it can't create another vault until it joins a vault by invite, is admitted again, or (while Reliquary is open) takes a new day's place.

## Plans and tiers

| | Free (everyone) | Alpha tester (by invitation) |
|---|---|---|
| Vaults you own | 5 | 25 |
| People per vault | 10 | 25 |
| Storage per vault | 100 MB | 1 GB |

A vault's tier is **Standard** unless it has been upgraded. A Standard vault takes its people and storage limits from the plan of the account that created it, whoever else becomes an owner later. A vault can be upgraded on its own: the **Pro** tier holds 50 people and 5 GB, whatever its account's plan; the operator can also add storage to one vault without a whole new tier, on top of whatever it already has. Upgrades are given by hand during the beta: ask the operator with **Ask for a bigger plan** on **Plan and usage**, which writes to andres@redmage.cc. On a self-hosted server there is no billing: its operator sets plans and tiers, and the Self-hosted plan has no limits.

Reliquary's own staff and contributors are on a **Reliquary staff** plan: no limit on the vaults they own, with each one still taking Alpha tester's own people and storage numbers unless the operator upgrades it or adds storage.

Sizes are decimal: 1 MB is 1,000,000 bytes, 1 GB is 1,000 MB.

## Where you see them

- **Account**, **Plan and usage** (`/account`): your plan, how many vaults you own of how many, and each of your vaults' people and storage, each with a bar and a status: **People full**, **Storage full**, or storage from 80% ("Storage 85%"). Home shows the plan and the count under **Your vaults**. Home shows the count under its title, like "You own 2 of 5 vaults on the Free plan", marked **At the limit** when you're there.
- A vault's **Settings**, **Usage**: its tier, people and storage, for every member, with a warning from 80% of storage and when every place is filled. Owners also see the invites waiting.
- A vault's **Settings**, **Members**: how many places are filled. When none is left, **Invite someone** is off and the page says how to make room, before anyone fills in an invite.
- Agents: `list_vaults` notes a vault that is near or over a limit.

## What counts

- **Vaults you own**: the vaults you created. Being a member, even an owner, of someone else's vault doesn't count.
- **People**: a vault's members, of every role. When an owner invites someone, invites still waiting count too, so a vault never hands out more links than it has places for.
- **Storage**: the text of every version of every file (history takes space too), every variable's encrypted value, and the encrypted values of imports waiting to be applied. A proposal counts once it is applied. Comments, review notes and the activity log don't count.

Storage is counted as things change, not measured on each request. Every week the operator's check compares each vault's count with a full recount; a count that is off is looked into and fixed by hand, never silently.

## At a limit

A request that would pass a limit is refused, and nothing is changed. The message names the vault, the limit, the plan or tier and the usage, for example "Club is at its 10-person limit on the Free plan (8 members and 2 invites waiting): revoke an invite or remove someone first".

| Limit | Refused | Make room by |
|---|---|---|
| Vaults you own | **New vault**, and `create_vault` over MCP. At the limit New vault shows no form: it says how many vaults your plan allows, with **Plan and usage** and **Ask for a bigger plan** | deleting a vault you no longer need |
| People | **Invite someone**; opening an invite link when the vault is already full | revoking invites, removing members, or members leaving |
| Storage | saving a file, proposing, approving a proposal, setting a larger variable value, importing a `.env` | erasing files (deleting a file keeps its history, and its size), deleting variables, rejecting imports |

A proposal whose text wouldn't fit is refused when it is made, so an agent learns at once. Applying an import adds nothing: its values were counted when it was made.

Removing things always works at a limit: deleting and erasing files, deleting variables, removing members, leaving, rejecting imports and deleting the vault.

Over MCP a refusal reads `Limit reached:` and the message. The env API answers an import from the CLI that doesn't fit with status 507 and `{"error": "storage_limit"}`.

## When a plan gets smaller

Nothing is deleted. A vault over a limit becomes read-mostly: everyone keeps reading, deleting and erasing, and nothing that adds storage or people is taken until it is back under. An account with more vaults than its plan allows keeps them all and can't create another until it is under.

See [Limits](../reference/limits.md) for every other limit.
