# Errors and reference IDs

When something fails, Reliquary tells you what it was doing, where it broke, why, and gives a reference ID. The web app, the MCP tools, the env API, OAuth and the CLI all say the same four things.

## The four fields

| Field | What it says | Example |
|---|---|---|
| What | The operation that failed | `Saving canon/pricing.md in vault 3f2a9c1d`, `Signing in`, `Calling write_file`, `Reading development in vault 3f2a9c1d` |
| Where | The part of Reliquary that failed | `database (function public.write_file)`, `sign-in (Supabase Auth)`, `env API: database`, `rate limit` |
| Why | The reason, as exactly as it is known | `57014 statement timeout: public.search ran past the database's time limit and was stopped.` |
| Reference | A short ID for this one failure | `ref 7f3a2c9e` |

A vault is named by the first 8 characters of its id. The web app shows a path you typed only when it is a plain path; one with control characters or a `..` segment reads as "a file".

## Where

| Where | Meaning |
|---|---|
| `database` | Postgres refused or failed the work. `(function x)` names the SQL function it happened in |
| `database (only what's shared with you is visible)` | Not found: the vault, file or proposal doesn't exist, or it isn't shared with you. Reliquary never says which |
| `sign-in (Supabase Auth)` | The sign-in service didn't answer, or answered with an error |
| `encryption` | Variable values: the server has no key, or a value didn't decrypt |
| `rate limit` | Too many requests in a short time. The answer says when to try again |
| `MCP tool <name>` | A tool call. After a colon, the part inside it that failed, such as `database (function private.vault_ref)` |
| `MCP server` | The MCP endpoint itself, before or around a tool call |
| `link proxy (...)` | A call to a tool of a [link](../concepts/links.md): `(upstream)` the linked server refused it, `(request)` the arguments were too large to send, `(credential)` the stored credential didn't decrypt, `(network)` the web app couldn't be reached, `(settings)` this server has no `LINK_PROXY_SECRET`. A tool call carries two references, the web app's (`web app ref`) and its own |
| `link discovery` | Reading a link's tools when it is added |
| `env API` | The API the CLI uses for variable values |
| `OAuth` | Connecting an app or the CLI: the token endpoint, or the consent page |
| `network` | A call to another service got no answer: DNS, TLS, a refused or reset connection, a timeout |
| `web app` | The web app itself: a form check, a page that doesn't exist, or a bug (with the file and line) |

## Why

- **Refusals Reliquary makes on purpose** say so in words: "Only owners set rules.", "That address already belongs to a member of this vault." A plan limit is one of these (code `RLP01`, status 403; 507 `storage_limit` from the env API): its message names the vault, the limit, the plan or tier and the usage, and over MCP it starts `Limit reached:`. An account not yet admitted while Reliquary is invite-only is another (code `RLP02`, status 403): its message says how to get in, and over MCP it starts `Not admitted:`. See [Plans and limits](../concepts/plans-and-limits.md). A browser session that was ended by **Sign out everywhere** is refused with code `RLA01` (status 401): the web app clears its cookies and sends you to sign in. See [The top bar, inbox and account](../concepts/inbox-and-account.md#sign-out-everywhere).
- **Database errors** start with the SQLSTATE code and its name, then the constraint, table or function when Postgres names one:

| Code | Name | Usually means |
|---|---|---|
| `23505` | unique violation | Something with that name or path already exists |
| `23503` | foreign key violation | It refers to something that no longer exists |
| `23514` | check violation | A value is outside what's allowed (too long, a bad character) |
| `42501` | permission denied | Your role, or the token's scope, doesn't allow it |
| `57014` | statement timeout | The work ran past the database's time limit (10 seconds) and was stopped. Narrow it: a prefix, a limit |
| `55P03` | lock timeout | Another request held what this one needed for too long |
| `40001`, `40P01` | serialization failure, deadlock detected | Two requests collided; running it again usually works |
| `08006`, `57P01` | connection failure, admin shutdown | The connection to the database broke |
| `53300` | too many connections | The database has no free connections |

- **A dropped connection** to the database is logged by itself with a reference (where `database`), whether or not a request was using it, and Reliquary keeps running. A request that held it fails as any database failure does, with its own reference; the next request gets a fresh connection.
- **Another service** is named with the call and its HTTP status or network error: `POST /otp answered 503`, `the connection timed out (ETIMEDOUT)`.
- **A bug** is named by its kind and where in the code it was thrown: `TypeError at dist/pages.js:412`.

Reliquary never shows a variable's value, a token, a key, a password, a file's text or the values in a failing database row, in an error or in its logs.

## What each surface shows

The web app shows an error page with the right HTTP status (400, 403, 404, 409, 413, 429, 500, 502, 503 or 504), the four fields, and **Details to send if you report this**: open it for the same fields as plain text to paste into a report. A refusal on a form you just sent (you aren't allowed, a name is taken) shows in red under the title of the page you were on, ending with its reference, and screen readers announce it at once. When a form works, the message saying what was done shows in the same place. A Not found page inside a vault you belong to has a button back to that vault, named for it; for a vault you don't belong to it has only **Home**, the same as for a vault that doesn't exist.

An MCP tool error has two lines: the first says what failed and why, the second gives what, where and the reference:

```text
Calling write_file failed: 23503 foreign key violation: insert or update on table "files" violates foreign key constraint "files_vault_id_fkey".
(what: Calling write_file; where: MCP tool write_file: database (function private.apply_write); ref 7f3a2c9e)
```

An HTTP error from the MCP endpoint is JSON-RPC, with the reason in `message` and the fields in `data`: `{"what", "where", "why", "ref"}`.

The env API answers with its error code and the fields beside it ([Env API](env-api.md)):

```json
{ "error": "server_error",
  "message": "Reading development in vault 3f2a9c1d failed: 57014 statement timeout: the query ran past the database's time limit and was stopped.",
  "where": "env API: database", "ref": "7f3a2c9e" }
```

OAuth keeps the error codes of RFC 6749 and puts the reason in `error_description`, with `where` and `ref` beside them.

The CLI prints the server's reason and reference after its own sentence, and for a request that got no answer, the host and what failed:

```text
reliquary: Reading development in My project failed: the server answered 504 (server_error). The server says: Reading development in vault 3f2a9c1d failed: 57014 statement timeout: ... (where: env API: database; ref 7f3a2c9e)
reliquary: Couldn't reach app.example.com (GET /api/env/vaults): the DNS lookup found no such host (ENOTFOUND). Check the server address and your connection.
```

## Reporting an error

Send the reference with what you were doing. On the web, open **Details to send if you report this** on the error page: it has everything in one block. The reference finds the full record in Reliquary's server log: the time, the SQLSTATE and constraint, the function and line in the database, and where in the code it happened. The reference itself holds nothing about you or your data.

References are random and only mean something together with the server's log, so there's no harm in pasting one in an issue or a chat.
