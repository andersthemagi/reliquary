# Vault templates

A template starts a new vault with folders, rules and a README that tells agents how to work in it, so you and your agents don't begin from an empty page.

## Choosing one

On Home, choose **New vault**. Under **Start from**, pick a template's card, then under **Files without a rule are** choose **Open** or **Canon**, and **Create vault**. You are the owner, as always.

| Template | Folders | Suggested variables |
|---|---|---|
| **Blank** | none: an empty vault, as before templates | none |
| **Client engagement** | `brief/`, `decisions/` and `canon/` are canon (1 approval); `notes/` is open | `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_DSN` |
| **Personal projects** | `projects/` and `notes/` are open | none |
| **Product team** | `specs/` and `decisions/` are canon (1 approval); `notes/` is open | `DATABASE_URL`, `SENTRY_DSN` |

What you choose under **Files without a rule are** is the vault's default policy: it applies to everything the template's rules don't cover, such as the README at the top of the vault.

## What a template creates

- **Rules** for its folders, which you can change later on the vault's **Rules** page. See [Canon, open and rules](canon-and-rules.md).
- **A `README.md`** at the top, written for people and agents: what each folder is for, and how an agent should behave there. It tells agents to propose changes to canon folders, write working notes to `notes/` directly, never put a secret in a file, and bring a `.env` in with `reliquary env push`.
- **A short file in each folder**, like `brief/brief.md` or `decisions/README.md`, with headings to fill in.
- **Suggested variable names**, as a checklist in the README. They are names only: a template never holds a value. Set values on the vault's **Variables** page. See [Environment variables](variables.md).

Everything a template creates is an ordinary file, rule or setting, logged in **Activity** as yours. Edit or delete any of it.

## All or nothing

A template is applied in one step. If anything fails, no vault is created: you never get half a vault.

## Templates are for people

Only the web app offers templates. An agent can create a blank vault with `create_vault` (see [Agents and the ceiling](agents.md)), and write a README like the template's with `write_file`, but it can't set rules, so it can't apply a template: rules are policy, and they stay with people. The database refuses an agent that tries.
