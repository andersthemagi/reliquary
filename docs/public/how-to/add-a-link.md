# Add a link

Give a vault's agents a shared platform account, like Linear or Stripe, without giving them the key: add a link to the platform's MCP server, then grant its tools.

Only an owner can do this, in the web app. What links are and how calls work: [Links](../concepts/links.md).

## Add the link

1. Open the vault, then **Links** in its sidebar.
2. Choose **Add link** at the top. The form opens above the list.
3. Fill in:
   - **Name**: a short name like `linear`, letters, digits and underscores, not starting with a digit. Agents call its tools as `<name>.<tool>`.
   - **URL**: the address where the service offers its tools to agents, from the service's own setup page. It is `https://`, a host and a path. Everyone in the vault can read it, so a key or token never goes here.
   - **Credential**: the service's API key or token. It is stored encrypted and never shown again, to anyone.
4. Choose **Add link**. The message says how many tools it discovered. If the tools couldn't be discovered, the link is still added with no tools, and the warning says why; delete it and add it again to retry.

If the form shows a warning that the server has no key for encrypting credentials (`VARIABLES_KEY`), **Add link** is turned off. Whoever runs the server has to set that key first.

## Grant its tools

1. On **Links**, open the **⋯** menu on the link's row and choose **Grants**.
2. Each tool has a checkbox for **Owner**, **Editor** and **Viewer**. Write tools are marked **Write**. Read tools start on for editors and owners; write tools start off.
3. Tick what each role's agents may call, then choose **Save grants**.

A write tool is never reachable from a read-only connection, whatever its role is granted.

## Check it

Ask an agent connected to the vault to call `list_links`: it lists the link's name and URL, never the credential. Then ask it to call one of the tools you granted, as `<link>.<tool>`. If the tool isn't in its list, reconnect the agent so its client asks for the tool list again.

## Change or remove it

- **Rename it or change its URL:** open the **⋯** menu, choose **Edit**, then **Save changes**. The credential stays, and is sent to the new URL.
- **Replace the credential:** delete the link and add it again. Its grants are deleted with it, so grant its tools again.
- **Stop one tool:** untick it on **Grants** and choose **Save grants**. Agents stop calling it at once.
- **Remove it:** open the **⋯** menu, choose **Delete**, then confirm with the **Delete** button that names the link. Its credential and grants go with it, and the removal is logged in Activity.
