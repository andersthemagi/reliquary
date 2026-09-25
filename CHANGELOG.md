# Changelog

What changed in Reliquary, release by release. Each release is a Git tag
`vX.Y.Z` and a GitHub Release; production always runs the latest one (the
footer and `GET /version` on both apps say which). Entries after 0.1.0 are
written by release-please from conventional commits. The command line has its
own changelog: [cli/CHANGELOG.md](cli/CHANGELOG.md).

## [0.2.0](https://github.com/andersthemagi/reliquary/compare/v0.1.0...v0.2.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* **cli:** a .reliquary.json or RELIQUARY_URL naming https://reliquary.redmage.cc must change to https://app.reliquary.redmage.cc, then run `reliquary login` again.

### Features

* **cli:** the default server is https://app.reliquary.redmage.cc ([2e0916b](https://github.com/andersthemagi/reliquary/commit/2e0916b5ed99bf0a6ec30c7df50f73cbabf4bf6b))
* **web:** serve the public site and the app on separate hosts ([2c0eeef](https://github.com/andersthemagi/reliquary/commit/2c0eeef9156d78e8fe211f71af1fe170f0f807a3))

## 0.1.0 (2026-09-25)

The first versioned release: everything live on 2026-09-25.

### Vaults, files and review

- Vaults with owners, editors and viewers; open files anyone who can write
  edits directly, and canon files (by folder or file, with a quorum) that
  change only through approved proposals.
- Proposals with approve, request changes, reject, and edit & approve;
  revisions void earlier approvals; nothing becomes canon without a person.
- Proposal threads (people and, over MCP, their agents) and private snooze in
  the Review inbox.
- Unified, split and rendered diffs with word highlights; Activity per
  account and per vault, filterable and paged; a file's History.
- An append-only log of every change; erasing a file blanks its text and
  keeps the record.

### Agents over MCP

- A remote MCP endpoint: read, search, write open files, propose, revise,
  comment, follow changes (`changes_since`), create vaults and delete open
  files, with entry text always returned as quoted data.
- Agents act as their person, minus a ceiling enforced in the database: no
  approving, no revealing variable values, no managing members, no deleting
  or exporting a vault.
- Parity between the web UI and MCP for everything an agent may do.

### Sign-in and connectors

- Sign-in with Supabase Auth.
- MCP OAuth 2.1 with the web app as the authorization server, so Claude Code,
  Claude.ai and ChatGPT connect by signing in, with client ID metadata
  documents.
- Scoped, expiring agent tokens (chosen vaults or all, read-only or
  read-write, 1 to 366 days) with last use and client name on the Tokens
  page.

### Environment variables and the CLI

- Environments and variables per vault, encrypted in the web app; people set,
  rotate, delete and reveal them; agents only ever see names; every read and
  reveal is in an append-only access log.
- The `reliquary` CLI (`login`, `logout`, `vaults`, `run`, `env pull`,
  `env push`), signing in over OAuth.
- Imports: paste a `.env` on the Variables page or push one from the CLI; a
  person previews it (names only) and applies it.
- Custom environments, limits, and key rotation without downtime.

### Members and vault administration

- Members and invites: single-use invite links for one address, role
  changes, removal (a vault always keeps an owner), leaving, and cutting off a
  member's agent connections.
- Vault settings for owners in person: rename, default policy, export as one
  `.tar.gz` snapshot (never variable values), and deletion with a notice to
  the other members.

### Hardening and performance

- Every permission is a row-level security policy or trigger, with hostile
  tests on every push.
- Size ceilings and rate limits (invites, exports), pinned search paths, and
  one pooled connection and transaction per request; fewer round trips on
  every page and tool call.

### Operations

- Hosted on Vercel (web and MCP, Frankfurt) and Supabase (Frankfurt, Pro).
- A deploy pipeline (migrations, then both apps, then smoke checks), hourly
  uptime checks with an outage issue, and off-site backups with a restore
  test.
- A public site with landing, legal and trust pages.
- Versioned releases: a release pull request collects this changelog, and
  only a published release deploys; `GET /version` on both apps and the
  version in the web footer show what is live.
