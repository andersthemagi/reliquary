# Getting started

Create a vault, connect Claude Code, approve your agent's first proposal, then run a command with your first environment variable.

This takes about 15 minutes. You need a Reliquary account that can create vaults (the alpha is [invite-only](../concepts/plans-and-limits.md#invite-only): open the invite link someone sent you first, or ask the operator to admit you), [Claude Code](https://claude.com/claude-code), and Node 20 or later for the CLI.

## 1. Sign in

Open `https://app.reliquary.redmage.cc` (or choose **Sign in** on `https://reliquary.redmage.cc`). Enter your email, then the 6-digit code from the email (or open its link on the same device).

## 2. Create a vault

A vault holds files, variables and members. See [Vaults, files and folders](../concepts/vaults-and-files.md).

1. On Home, choose **New vault**.
2. Name it `My project`.
3. Under **Start from**, leave **Blank** chosen for this tutorial. For real work, a [template](../concepts/templates.md) like **Client engagement** or **Product team** starts the vault with folders, rules and a README that tells your agents how to work in it.
4. Under **Files without a rule are**, choose **Canon**, so every change to a file is a proposal a person approves. (Open would let editors and their agents write files directly. You can change this later, and set it per folder with [rules](../how-to/set-rules.md).)
5. Choose **Create vault**. You are its owner.

## 3. Connect Claude Code

In a terminal, add Reliquary once for your user:

```bash
claude mcp add --transport http --scope user reliquary https://mcp.reliquary.redmage.cc/mcp
```

Start Claude Code, run `/mcp`, choose **reliquary**, then **Authenticate**. Your browser opens Reliquary's consent page:

1. If **All my vaults** is already chosen, which it is when you have one vault, leave it.
2. Choose **Read and write**, so the agent can propose changes.
3. Choose **Allow**.

Claude Code keeps the connection and refreshes it by itself. It shows on your **Connections** page, where you can revoke it at any time.

## 4. Let your agent propose a file

Ask Claude Code:

```text
Using Reliquary, list my vaults. Then propose a new file notes/hello.md in "My project"
that says what this project is, with the reason "first note".
```

It calls `list_vaults`, then `propose`. Because the vault is canon, nothing is written yet: the change waits for you. An agent can never approve its own proposal, or anyone's. See [Agents and the ceiling](../concepts/agents.md).

## 5. Approve it

In the web app, the **Inbox** in the top bar now shows a count of 1.

1. Open the proposal. The diff comes first, then the agent's stated reason, marked unverified.
2. Choose **Approve**.

The vault needs one approval (its quorum), so the file is written at once. Open **My project**: `notes/hello.md` is there, credited to your agent, and the change is in **Changes**. See [Proposals and review](../concepts/proposals-and-review.md) for requesting changes, comments and snooze.

## 6. Add your first variable

1. In **My project**, open **Variables** in the sidebar.
2. Choose **Add a variable**.
3. Name it `GREETING`, pick the `development` environment, and type a harmless value, like `hello`.
4. Choose **Save variable**.

The value is encrypted before it is stored. Your agent can see the name `GREETING` through `list_variables`, never the value. See [Environment variables](../concepts/variables.md).

## 7. Run a command with it

Connect the Reliquary CLI to your account. Your browser opens a consent page; choose the vaults it may read, then **Allow**:

```bash
npx @reliquary-ai/cli login
```

Run a command with the `development` variables in its environment. This one prints the value's length, not the value:

```bash
npx @reliquary-ai/cli run --vault "My project" --env development -- sh -c 'echo "GREETING has ${#GREETING} characters"'
```

Nothing is written to disk. Back in the web app, **Variables**, **Access log** shows the read, by you, through the Reliquary CLI.

## What's next

- Connect your other tools: [Claude.ai](../how-to/connect-claude-ai.md), [ChatGPT](../how-to/connect-chatgpt.md), [Cursor](../how-to/connect-cursor.md), [VS Code](../how-to/connect-vs-code.md).
- Bring a project's existing `.env` in: [Move a .env into a vault](../how-to/move-env-into-vault.md).
- Work with someone: [Invite someone](../how-to/invite-someone.md).
