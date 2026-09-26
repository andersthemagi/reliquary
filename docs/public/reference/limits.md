# Limits

The sizes, counts, rates and lifetimes Reliquary enforces, most of them in the database.

A request over a limit is refused with a message naming the limit, never echoing what you sent.

## Plans

What your plan and a vault's tier allow. How they count, and what happens at a limit: [Plans and limits](../concepts/plans-and-limits.md).

| What | Free | Alpha tester | A Pro vault |
|---|---|---|---|
| Vaults you own | 5 | 25 | |
| People per vault, counting invites waiting | 10 | 25 | 50 |
| Storage per vault: every file version, variable values and waiting imports | 100 MB | 1 GB | 5 GB |

## Vaults and files

| What | Limit |
|---|---|
| Vault name | 1 to 100 characters, no control characters |
| File path | up to 1024 characters, no control characters |
| File or proposal text | 1 MiB |
| A proposal's reason, a review note | 4000 characters |
| A comment | 1 to 4000 characters, at most 200 per proposal |
| Quorum (approvals a canon change needs) | 1 to 20 |
| A web form | 2 MB; forms carrying a file's text 3 MiB + 64 KiB, so 1 MiB of any text fits |

## MCP

| What | Limit |
|---|---|
| Messages in one batch | 10 |
| `read_file` | 100000 bytes by default, up to 1048576 with `max_bytes`; `from_line` and `to_line` pick lines |
| `list_files` | 200 files by default, up to 1000; continue with `after` |
| `search` | 10 files by default, up to 50; a query up to 500 characters; up to 3 matching lines per file |
| `changes_since` | 100 events by default, up to 500 |

Every tool argument has a ceiling; they are in [MCP tools](mcp-tools.md).

## Connections and sign-in

| What | Limit |
|---|---|
| Token lifetime | 7, 30, 90 or 180 days, or 1 year |
| OAuth and CLI access tokens | 1 hour, refreshed by the client |
| OAuth and CLI refresh tokens | 30 days, renewed on each use, never beyond a year from consent |
| An OAuth authorization code | one use, within 60 seconds |
| Web sign-in code | 6 digits, from an email |
| "Last used" on the Connections page | updated at most once a minute |

## Members

| What | Limit |
|---|---|
| An invite | one use, 7 days, one email address |
| Invites waiting per vault | 50 |
| Invites a person creates | 20 an hour, across all their vaults |
| A vault deletion notice | shown once to each other member, within 30 days |

## Export

| What | Limit |
|---|---|
| Exports | 10 an hour per vault |
| Size | 100 MiB of file text |

## Environment variables

| What | Limit |
|---|---|
| Variable name | a letter or `_`, then letters, digits or `_`, up to 128 characters; names that change how programs start are refused |
| Value | 64 KiB of UTF-8 text, no NUL characters |
| Variables per vault | 1000 |
| Environments per vault | 20; a name is lower case letters, digits, `-` and `_`, starting with a letter, up to 32 characters |
| A `.env`, pasted or sent from the CLI | 512 KiB and 5000 lines; 200 variables are taken |
| An import | 200 names and 4 MiB |
| Imports waiting | 20 per person per vault |
| Imports made | 60 an hour per person |
| An import you pasted | 30 minutes |
| An import from the CLI | 24 hours |
| An import request to the env API | 1 MiB |

## Rate limits

How many requests Reliquary takes in a window of time. Counts are shared by every server, so they hold however requests are spread. A request over a limit is refused with status 429 and a `Retry-After` header giving the seconds to wait; a refused request doesn't count. Web pages say when to try again; the MCP endpoint answers with a JSON-RPC error that says how long to wait.

| What | Limit |
|---|---|
| Asking for a sign-in code | 5 an hour per email address, 20 an hour per IP address |
| Entering a sign-in code | 5 every 15 minutes per email address, then that address's codes are locked until the 15 minutes are up (the emailed link still works) |
| Entering codes and opening sign-in links | 30 every 15 minutes per IP address |
| Renewing a web session | 30 an hour per session |
| Form posts in the web app | 60 a minute and 1000 an hour per session |
| Opening or accepting invite links | 30 an hour per IP address |
| OAuth consent page (`/oauth/authorize`) | 60 every 10 minutes per IP address, 600 per app |
| OAuth token endpoint (`/oauth/token`) | 120 every 10 minutes per IP address, 1200 per app |
| OAuth revocation (`/oauth/revoke`) | 60 every 10 minutes per IP address, 600 per app |
| Fetching an app's client metadata | 20 every 10 minutes per app host |
| MCP tool calls | 120 a minute and 10000 a day per token or connection; a batch counts each call; listing tools and starting a session don't count |
| MCP requests without a valid token | 30 a minute per IP address |
| The env API (the CLI) | 60 a minute and 5000 a day per Reliquary CLI connection |

"Per app" counts every person's use of one app together (one client id). "Per token or connection" counts a personal token, or an OAuth connection across its hourly access tokens.

Addresses and emails are never stored: each is counted under a keyed hash that can't be turned back into the address. An IPv6 address counts by its /64. If the counters can't be reached, sign-in stops and says it is unavailable, so codes can't be guessed while they are down; everything else carries on without limits.

## Pages

| What | Limit |
|---|---|
| Activity | 50 events a page |
| Variables access log | 50 entries a page |
