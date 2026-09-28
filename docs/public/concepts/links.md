# Links

A link is a vault's credential to another remote MCP server, like Stripe, Linear or Supabase, so a team can share a platform account with their agents without sharing the key.

**Partly usable.** A vault's owner adds, edits and deletes links from its **Links** page in the web app, and an agent can list them (name and url, never the credential) with `list_links`. Discovering a link's tools, granting them per role, and letting an agent actually call one through the MCP proxy, aren't built yet: a link's tools show as none until then.

## What a link holds

- **A name and a url.** The url must be `https://`; letters, digits and underscores for the name, unique in the vault.
- **A credential**, encrypted the same way as an environment variable: nobody, including an agent, ever reads it back. It is attached to a call at the last moment, server-side.
- **Discovered tools.** Once discovery is built, adding a link calls the upstream server's tool list and stores each tool's name and whether it writes.
- **Grants per role.** An owner decides which of a link's tools each role may use. Read tools default on for editors and owners; write tools stay off until an owner turns them on.
- **A call log**, append-only: who, which agent, which tool, and whether it succeeded, kept as a record even after the link itself is deleted. Never the arguments or the result.

## Who may do what

Adding, editing or deleting a link, and setting its grants, is an owner's, in person, same as [the ceiling](agents.md#the-ceiling): no agent, token or connection may do it, whatever surface offers the call. Members read a vault's links and their grants within their role; an agent does the same over MCP with `list_links`, read-only connections included.

## Not to be confused with a connection

A [connection](connections.md) is a client reaching into Reliquary: Claude Code, a token, the CLI. A link is Reliquary reaching out, to an upstream MCP server on the vault's behalf. The two are opposite directions and unrelated, beyond both letting an agent do more with less it has to hold itself.
