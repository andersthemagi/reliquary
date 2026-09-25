# Security model

Reliquary's rules live in the database, each has a hostile test, secret values are encrypted with a key the database never holds, and the limits of all that are stated plainly.

## The database enforces access

Every permission is a Postgres row-level security policy, a trigger, or a checked function, not a check in the web app or the MCP server that a bug could skip. The web app and the MCP server log in as limited roles; they establish who is calling, and the database decides what that caller may do. Among the rules:

- A member of one vault sees no trace of another, and a token limited to some vaults can't see the rest.
- Canon files change only through a proposal that a quorum of people approves.
- An agent acts as its person, minus the [ceiling](agents.md). Every request through a token or connection carries a claim naming it, and the database refuses ceiling actions for any request that carries one.
- The activity log and the variables access log are append-only. Deleting a whole vault is the one path that removes rows.

## Hostile tests on every push

Each rule has a test that tries to break it: a session for one vault reading another, an agent approving a proposal, anyone editing a log row, an agent revealing a variable, a revoked token reading anything. They run against a real database on every push and pull request, with the MCP server, the web app and the CLI tested end to end. Each new rule is also broken on purpose once, to see its test fail.

## Agents and text

- The [ceiling](agents.md) keeps approving, rules, members, grants, secret values, export and deletion with people.
- Text people and agents wrote reaches an agent fenced as data, with a random marker no text can forge.
- Reliquary runs no model and sends your content to no model provider. Your AI tools get what their agent reads, under your agreement with them.

## Connections and sign-in

- Sign-in to the web app is by an emailed code or link. Sessions are HttpOnly, Secure, `__Host-` cookies, bound to the app's own host (`app.reliquary.redmage.cc`). The public site and docs (`reliquary.redmage.cc`) set no cookies at all.
- The OAuth sign-in for MCP clients and the CLI runs on the app host: its issuer is `https://app.reliquary.redmage.cc`.
- MCP clients and the CLI use OAuth 2.1 with PKCE (S256 only), and tokens bound to the one service they are for: an MCP token is refused by the env API and a CLI token by the MCP endpoint. Refresh tokens rotate, and a reused one revokes the whole grant.
- Clients are identified by a metadata document at an https URL, fetched with guards against reaching private networks.
- Access tokens are stored only as hashes, always expire (at most a year), and are revocable at once. See [Tokens, connections and sign-ins](connections.md).
- Sign-in, OAuth, invites, the MCP endpoint, the env API and web forms are rate limited, with counters in the database shared by every server. Entering sign-in codes is limited per email address and per IP address, so a 6-digit code can't be guessed. Addresses are counted under a keyed hash, never stored. See [Limits](../reference/limits.md#rate-limits).

## The web app

- No client-side script at all: the content security policy forbids scripts, and nothing loads from another site.
- Every form carries a per-session token and must come from the app's own pages.
- The app's pages are never indexed by search engines. Moving between the public site and the app only ever redirects to one of Reliquary's own two web addresses.
- Everything people and agents wrote is escaped; a file's Markdown is rendered with raw HTML off.

## Secret values

- Values are encrypted by the web app with AES-256-GCM, a fresh nonce each, under a key kept outside the database. The database holds only ciphertext, and no role that serves requests can read it directly.
- Ciphertext leaves the database only through functions that check the caller's grant and write the access log in the same transaction.
- The MCP server refuses to start if it is given the key: it can't decrypt anything.
- The key can be rotated without downtime; re-encryption runs as a separate operator role that serves no requests.
- Server logs never carry a token, a sign-in code, file text or a value; the test suite checks the logs.

## Hosting

The database (Supabase) is in Frankfurt (AWS eu-central-1), and the app runs in Frankfurt (Vercel, fra1). Connections to the database use TLS verified against Supabase's certificate authority. Data is backed up daily. The companies involved are on the [sub-processors](/subprocessors) page.

## What we can't promise

- **Agents can read what reaches them.** An agent that can run commands in a process holding a variable can read that variable. `reliquary run` limits exposure to one process; it doesn't stop that process.
- **The operator can decrypt.** Someone with both the database and the web app's key, which means Reliquary's operator, could technically decrypt variable values. We don't, and access is limited to running the service.
- **No certification yet.** No SOC 2 report, ISO certificate or SSO. Reliquary is built and run by one person, and is pre-alpha: things change and may break.

To report a vulnerability, see the [security page](/security#disclosure).
