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
4. Choose **Add link**. The message says how many tools it discovered. If the tools couldn't be discovered, the link is still added with no tools, and the warning says why; fix the cause, then choose **Refresh tools** (below) to retry.

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
- **Replace the credential:** open the **⋯** menu, choose **Replace credential**, type the new key or token, then choose **Replace credential**. The old one is gone at once. The link keeps its name, URL and grants, and its tools are discovered again with the new credential. The replacement is logged in Activity, without the credential.
- **Pick up the service's new tools:** open the **⋯** menu and choose **Refresh tools**. Its tools are discovered again with the stored credential. New tools get the usual starting grants, the grants you set stay, and a tool the service no longer offers is removed.
- **Stop one tool:** untick it on **Grants** and choose **Save grants**. Agents stop calling it at once.
- **Remove it:** open the **⋯** menu, choose **Delete**, then confirm with the **Delete** button that names the link. Its credential and grants go with it, and the removal is logged in Activity.

Both say which tools were added and removed. If discovery fails, the link and its tools stay as they were, and the warning says why, with a reference.
