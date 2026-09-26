# Move a .env into a vault

Bring a project's existing `.env` into a vault, by paste or with `reliquary env push`, then run the project with `reliquary run` and retire the file.

You need to be an owner or editor of the vault (editors can't set owners-only environments like `production`).

## Option A: send it from the project

From the project's directory, after [signing the CLI in](use-the-cli.md#sign-in) with **Also let it send .env files here** ticked:

```bash
npx @reliquary-ai/cli env push --vault "My project" --env development --file .env
```

The CLI prints any lines it can't take and why, the names it sent (new, or replacing a value), and an approval link. Nothing is set yet.

You can ask an agent to do this step: it runs the command without the values ever entering the conversation. Tell it to run the command, not to read the file.

## Option B: paste it

On the vault's **Variables** page, choose **Import .env**, paste the file's contents, tick the environments to set, and choose **Review the import**.

## Apply it

Open the approval link (or the Variables page's **Imports** tab, or your **Inbox**). The review page lists each name, **New** or **Replaces a value**, and the lines not taken, never a value. Choose **Apply** at the top of the page. Each variable is set as you and logged.

An import from the CLI waits 24 hours for a decision, one you pasted 30 minutes; after that it expires and nothing is set. See [Imports](../concepts/imports.md).

## Switch the project over

1. Commit a `.reliquary.json` so nobody needs flags (see [Use the CLI](use-the-cli.md#set-defaults-for-a-project)):

   ```json
   { "vault": "<vault id>", "environment": "development" }
   ```

2. Start the project through the CLI, for example:

   ```bash
   npx @reliquary-ai/cli run -- npm run dev
   ```

3. When it works, delete the local `.env`. If a tool insists on a file, use `reliquary env pull`, which writes only where git ignores it.
4. If the file was ever committed to git or shared in a chat, rotate those values at their provider, then set the new ones on the Variables page with **Rotate**.

Repeat for `preview` and `production` with `--env`.
