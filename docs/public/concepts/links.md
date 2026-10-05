# Links

A link is a vault's credential to another remote MCP server, like Stripe, Linear or Supabase, so a team can share a platform account with their agents without sharing the key.

A vault's owner adds, edits and deletes links from its **Links** page in the web app, and an agent can list them (name and url, never the credential) with `list_links`. Adding a link also discovers its tools, from the upstream server's own tool list; an owner grants them per role from the link's **Grants** page; and a granted tool is callable, as its own MCP tool.

## What a link holds

- **A name and a url.** The url must be `https://`; letters, digits and underscores for the name, unique in the vault.
- **A credential**, encrypted the same way as an environment variable: nobody, including an agent, ever reads it back. It is attached to a call at the last moment, server-side, and re-checked for safety (see below) on every call, not just when the link was added. Editing a link changes its name and url only; the credential isn't shown or changed there. To replace it, delete the link and add it again, which deletes its grants too. Changing the url keeps the credential, which is then sent to the new address, and the tools already discovered.
- **Discovered tools.** Adding a link calls the upstream server's own tool list and stores each tool's name, description, arguments and whether it writes (from the tool's own `readOnlyHint`; anything but an explicit yes is treated as a write tool). A slow or unreachable server doesn't stop the link from being added: it's flashed as a warning, and the link's tools stay empty until it's deleted and re-added (there's no rediscovery yet).
- **Grants per role.** An owner decides which of a link's tools each role may use, from the link's **Grants** page. Read tools default on for editors and owners; write tools stay off until an owner turns them on there.
- **A call log**, append-only: who, which agent, which tool, and whether it succeeded, kept as a record even after the link itself is deleted. Never the arguments or the result, only their hashes.

## Calling a tool

A granted tool shows up in `tools/list` as `<link>.<tool>` (a link named `stripe` with a granted `create_invoice` tool becomes `stripe.create_invoice`) -- see [MCP tools](../reference/mcp-tools.md#link-tools). Which ones appear depends on the connection: a role's grant, and for a write tool, a write-capable connection too (a read-only token never reaches one, whatever its role is granted). Reliquary makes the call server-side and attaches the credential itself; it's never sent to, or held by, the agent. The result comes back fenced as data from the upstream server, the same as any other text an agent reads through Reliquary -- never as instructions.

## Who may do what

Adding, editing or deleting a link, and setting its grants, is an owner's, in person, same as [the ceiling](agents.md#the-ceiling): no agent, token or connection may do it, whatever surface offers the call. Calling a granted tool is different: any connection whose role is granted it may, agents included, the same as any other tool. Members read a vault's links and their grants within their role; an agent does the same over MCP with `list_links`, read-only connections included.

## Not to be confused with a connection

A [connection](connections.md) is a client reaching into Reliquary: Claude Code, a token, the CLI. A link is Reliquary reaching out, to an upstream MCP server on the vault's behalf. The two are opposite directions and unrelated, beyond both letting an agent do more with less it has to hold itself.
