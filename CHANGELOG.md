# Changelog

What changed in Reliquary, release by release. Each release is a Git tag
`vX.Y.Z` and a GitHub Release; production always runs the latest one (the
footer and `GET /version` on both apps say which). Entries after 0.1.0 are
written by release-please from conventional commits. The command line has its
own changelog: [cli/CHANGELOG.md](cli/CHANGELOG.md).

## [0.10.0](https://github.com/andersthemagi/reliquary/compare/v0.9.0...v0.10.0) (2026-09-28)


### Features

* **mcp:** call a link's granted tools as &lt;link&gt;.&lt;tool&gt; ([8f59e88](https://github.com/andersthemagi/reliquary/commit/8f59e884213db5578c0a2812da36d0c9c56c8ced))
* **web:** a vault's Links page, to add, edit and delete a link ([0df6b2d](https://github.com/andersthemagi/reliquary/commit/0df6b2d1f6d3ff6996ffa158c3a1d082e6649823))
* **web:** discover a link's tools when it's added ([bdffac5](https://github.com/andersthemagi/reliquary/commit/bdffac594304cb05141e13d1ed4eea5761816861))
* **web:** grant a link's tools per role from a Grants page ([95f0923](https://github.com/andersthemagi/reliquary/commit/95f0923a618a9a020a8c43f64a0adbd30f8357dc))
* **web:** name and remove a path's owners from Rules ([e52d3c7](https://github.com/andersthemagi/reliquary/commit/e52d3c76b9f8ea76cd0a6149f7802dac0e59601a))
* **web:** watch and unwatch folders and files ([c59ffca](https://github.com/andersthemagi/reliquary/commit/c59ffca40e0221c305d03862c728b0e7b4c5d254))


### Bug fixes

* **db:** cascade path_owners rows off vault membership ([a84c202](https://github.com/andersthemagi/reliquary/commit/a84c20297736f4c252fe34dbe32dc453131d1ed1))
* **db:** renumber F417 to F426 after merging origin/main ([293e6a9](https://github.com/andersthemagi/reliquary/commit/293e6a900077af68dd6128f83f2e67c2524e3407))
* **web:** close three unclosed [@media](https://github.com/media) blocks in style.css ([9051d10](https://github.com/andersthemagi/reliquary/commit/9051d10b324632571a2f48a03146269c86e30f9c))


### Security

* **db:** a named path owner's write access now respects their connection's scope ([ef59088](https://github.com/andersthemagi/reliquary/commit/ef59088d12c9a92c60a3e8b83c12386d7fc7bc8d))
* **db:** the MCP proxy's credential-egress chokepoint for links ([b7b13ad](https://github.com/andersthemagi/reliquary/commit/b7b13adf0958777e98e63ff4cff6e40a7c27947b))
* **export:** refuse Windows-unsafe file paths and rename them in exports ([54fa289](https://github.com/andersthemagi/reliquary/commit/54fa28942cf21748a36ff974b31411fd1a9fd0c1))

## [0.9.0](https://github.com/andersthemagi/reliquary/compare/v0.8.0...v0.9.0) (2026-09-28)


### Features

* **mcp:** list_links, list_flags, advance_flags, list_subscriptions ([af6ca6f](https://github.com/andersthemagi/reliquary/commit/af6ca6f68cf7adb92526b9a65867a9e88efe5c19))

## [0.8.0](https://github.com/andersthemagi/reliquary/compare/v0.7.0...v0.8.0) (2026-09-28)


### Features

* **db:** flags and watched paths, schema and SQL functions only ([f8f087e](https://github.com/andersthemagi/reliquary/commit/f8f087ef1dda96dac55ed8ae2b996e0174417bf5))
* **db:** links to upstream MCP servers, schema and owner-only management ([b100dd1](https://github.com/andersthemagi/reliquary/commit/b100dd1fdad1d81cd817a2dc6e89f2ce24c42b24))
* **db:** path ownership, alongside links ([2b621ce](https://github.com/andersthemagi/reliquary/commit/2b621ceb1cac934b9db1894a5d1a2635040a8b66))

## [0.7.0](https://github.com/andersthemagi/reliquary/compare/v0.6.0...v0.7.0) (2026-09-26)


### Features

* **web:** a welcome tour for new accounts, and from the account menu ([f99ab5d](https://github.com/andersthemagi/reliquary/commit/f99ab5d1dfe261075babe61a793ae51860a96ae6))


### Bug fixes

* **deploy:** the self-hosting check expects the welcome tour on a new owner's first sign-in ([fe2fb55](https://github.com/andersthemagi/reliquary/commit/fe2fb55427c15fe9cbdb420c7ac12fa19aa41eca))

## [0.6.0](https://github.com/andersthemagi/reliquary/compare/v0.5.0...v0.6.0) (2026-09-26)


### Features

* **db:** a staff plan and per-vault storage grants ([5036b91](https://github.com/andersthemagi/reliquary/commit/5036b91bdb79f120d6285a95d5ff26eafa646b3b))

## [0.5.0](https://github.com/andersthemagi/reliquary/compare/v0.4.0...v0.5.0) (2026-09-26)


### Features

* **cli:** the CLI speaks of its connection, and points to the Connections page ([1bfc8de](https://github.com/andersthemagi/reliquary/commit/1bfc8de59548754f7bbf06b301423447505b8e18))
* **deploy:** run Reliquary on your own server with Docker Compose ([109a991](https://github.com/andersthemagi/reliquary/commit/109a991ee2fc84f534f83aaea3a5c0864012b2be))
* **feedback:** deleting an account deletes its feedback ([9bc56af](https://github.com/andersthemagi/reliquary/commit/9bc56af5dfdc87a021732b22ac7e73166e6c2bab))
* **feedback:** send feedback and bug reports from the web app and through your agent ([d5f1937](https://github.com/andersthemagi/reliquary/commit/d5f1937ce2a325d6570ca937a65065be39d8178d))
* **site:** name Resend as the email sub-processor ([767fdcd](https://github.com/andersthemagi/reliquary/commit/767fdcdebd2ab66e0e60a854d9ae6e6f82f8d3a9))
* the server is source-available under the Functional Source License (FSL-1.1-ALv2) ([f1d068d](https://github.com/andersthemagi/reliquary/commit/f1d068d6d79e09c615c22eb3914aec1f4edebc1d))
* **web:** a top bar with a vault switcher, search, an inbox and account settings ([b8907c5](https://github.com/andersthemagi/reliquary/commit/b8907c54a5ce3540308f025ad517427bf26c3b39))
* **web:** Activity puts filters behind a Filters button with removable chips, says who a member change was about, and reads as a list on phones ([258899a](https://github.com/andersthemagi/reliquary/commit/258899a9e0d349948588b5d2841a7d8c1d611ab5))
* **web:** change your email address from Account settings ([9e8f420](https://github.com/andersthemagi/reliquary/commit/9e8f420ca92cc2d524678f1a075714a91d98ed8e))
* **web:** Connections moves to /connections, with one vocabulary for connections ([287202c](https://github.com/andersthemagi/reliquary/commit/287202c28e83f3c907e5c60b3857c5cf2d95f5d8))
* **web:** Connections page lists what can act as you first, with New token on its own page and a confirm step to revoke; Connect shows one client per tab ([64fab52](https://github.com/andersthemagi/reliquary/commit/64fab52655d853787cd1d8e844203aeea88106e7))
* **web:** delete your account from Account settings ([372f85b](https://github.com/andersthemagi/reliquary/commit/372f85bc0db4de474cba5e466ef87bb2a3ebb139))
* **web:** email vault invites through Resend ([25398ab](https://github.com/andersthemagi/reliquary/commit/25398abd275a0b2db46a9330f8626cfc5d82ae05))
* **web:** file pages put Delete and Erase behind a More menu and confirm pages, and vaults show their sections as tabs on phones ([87db1f7](https://github.com/andersthemagi/reliquary/commit/87db1f7927a033b2545b674e25daf2b1f26da20c))
* **web:** Home lists your vaults as a table with your plan's count, and New vault shows template cards and stops at your plan's limit instead of offering a form it would refuse ([0f670fd](https://github.com/andersthemagi/reliquary/commit/0f670fd849476747b1494a69c51f64c9e0971683))
* **web:** join or decline an invite from your Inbox, no link needed ([6a20571](https://github.com/andersthemagi/reliquary/commit/6a205717709f606ae09ca738544b9c3f24e10067))
* **web:** messages after a form show as success, warning or error under the page title ([2221964](https://github.com/andersthemagi/reliquary/commit/2221964e23733e72f9d981259f283c6188e92fbf))
* **web:** new sign-in, confirmation and account email templates ([1580a19](https://github.com/andersthemagi/reliquary/commit/1580a19650b24b6730c3f5962e5c8cbe54263457))
* **web:** proposal discussions show times as "6 min ago" with the exact time on hover ([8eb8839](https://github.com/andersthemagi/reliquary/commit/8eb8839ba516f57480e197e0814d208fb2ff6ae8))
* **web:** proposal pages keep a refused decision's note, show how a proposal ended, and count proposals by state ([bdeb1ec](https://github.com/andersthemagi/reliquary/commit/bdeb1ec5545e480e616e7377580caaaee698a5f8))
* **web:** rules page lists rules first, asks before removing one, and refuses approvals outside 1 to 20 in the form ([6f810ca](https://github.com/andersthemagi/reliquary/commit/6f810ca52972d543ad37131ea4bd0ecb97765f73))
* **web:** sign out everywhere from Account settings ([72df7ab](https://github.com/andersthemagi/reliquary/commit/72df7aba1c73941c0f176d5287283ffb0cda1ee1))
* **web:** sign-in explains invite-only access, and sign-in and invite failures carry a reference ([e4552d7](https://github.com/andersthemagi/reliquary/commit/e4552d7488cb789efa8cdd1a98f08f5acce24251))
* **web:** variables page shows one menu per value, with Values, Environments, Access log and Imports tabs ([a068142](https://github.com/andersthemagi/reliquary/commit/a0681428259035d1bd8d2815ce56d7b419350cd0))
* **web:** vault settings as tabs, invites on their own page, and limits shown before a refusal ([9a33903](https://github.com/andersthemagi/reliquary/commit/9a3390397366e22478be576e9cac40a095fce739))


### Bug fixes

* **db:** changing a plan or a tier waits for writes and acceptances in flight ([80257fc](https://github.com/andersthemagi/reliquary/commit/80257fc57bcf21841516b7bab520be39ac47b58a))
* **db:** invite links work however the address's accents are encoded ([af2ce75](https://github.com/andersthemagi/reliquary/commit/af2ce75d3b0c935f8636264d7b33ed8e4f7ee01a))
* **db:** rules refuse paths outside the vault ([c2a0b5b](https://github.com/andersthemagi/reliquary/commit/c2a0b5b9e0d63c9a1ed8b846f0adb7cafd5b308f))
* **db:** writing, erasing, inviting and deleting a vault at once no longer deadlock ([3211fe9](https://github.com/andersthemagi/reliquary/commit/3211fe9e33d5e7425ca2fb52ede457a5b4fb2585))
* **deploy:** a self-hosted instance's first account can create vaults ([e5a5f9b](https://github.com/andersthemagi/reliquary/commit/e5a5f9b49d6bc64daabc5094bddc7a34cd01640c))
* **web:** Activity names every event in plain words ([4d4d8cb](https://github.com/andersthemagi/reliquary/commit/4d4d8cb277253768798f48e410d62929e794328e))
* **web:** editing lines of a proposal no longer flags it as removing them ([e17185b](https://github.com/andersthemagi/reliquary/commit/e17185b58424c558893586763bc7b9a623f96cc2))
* **web:** keep the confirm page's notice import after merging sign-in changes ([79ed3db](https://github.com/andersthemagi/reliquary/commit/79ed3db633049f8359f699c30e2700bd0126c19a))
* **web:** the Variables page links to the CLI tab on Connect ([ae3fddf](https://github.com/andersthemagi/reliquary/commit/ae3fddf6830fc12735fb2effe945ed4bfa536ae1))


### Security

* **db:** accounts need an invite or the operator's admission to create vaults ([7e406e1](https://github.com/andersthemagi/reliquary/commit/7e406e1f1ef9e09352d72fa54af5e37c7736e82d))

## [0.4.0](https://github.com/andersthemagi/reliquary/compare/v0.3.0...v0.4.0) (2026-09-25)


### Features

* **db:** plans and limits: vaults per account, people and storage per vault ([63170a1](https://github.com/andersthemagi/reliquary/commit/63170a13712d424830c491625406c5c5cdc5b228))
* **mcp:** plan limits reach agents as clear errors, and list_vaults notes a vault near a limit ([83e8d3b](https://github.com/andersthemagi/reliquary/commit/83e8d3b6101d2333cdda4580dfbf3050740c5d10))
* **web:** plan and usage on Home, Account and vault Settings, and limit errors where they happen ([1973901](https://github.com/andersthemagi/reliquary/commit/1973901a40f4287b641ce08bd6a8fe02b4680373))
* **web:** pricing shows the plans and their limits ([ae86bf9](https://github.com/andersthemagi/reliquary/commit/ae86bf98d0c352895f145864676201b45b8445b3))


### Bug fixes

* **cli:** print the server's reason and reference, and why a request got no answer ([1b62920](https://github.com/andersthemagi/reliquary/commit/1b62920578840a593862924e13d87004f44d2068))
* **mcp:** tool errors say what failed, where and why, with a reference ([59ac4db](https://github.com/andersthemagi/reliquary/commit/59ac4dbdd7f9697baab925625d19f75093ca7cde))
* **web:** error pages say what failed, where and why, with a reference ([98b810b](https://github.com/andersthemagi/reliquary/commit/98b810bb51190e1d7bb9053c655aa5159b80ab43))

## [0.3.0](https://github.com/andersthemagi/reliquary/compare/v0.2.0...v0.3.0) (2026-09-25)


### Features

* **cli:** keep sign-ins in the OS keychain (macOS Keychain, Secret Service, Windows DPAPI) ([dc9c1d4](https://github.com/andersthemagi/reliquary/commit/dc9c1d49da7c152a5491d52d73b2d06846cf2c74))
* **mcp:** rate limit tool calls per token and unauthenticated requests per IP ([f0b0bfb](https://github.com/andersthemagi/reliquary/commit/f0b0bfb184c86f7196c26e47d1bf3b07c48fa6f5))
* **web:** rate limits on sign-in, OAuth, invites, the env API and forms ([b5f1dbe](https://github.com/andersthemagi/reliquary/commit/b5f1dbefde2d962c035f9a368daa762aa422c4a3))
* **web:** start a new vault from a template ([7e59595](https://github.com/andersthemagi/reliquary/commit/7e5959575fe4dbeee728cb2f3c4efc1a3377b816))


### Bug fixes

* **cli:** publish under the MIT licence ([236c7db](https://github.com/andersthemagi/reliquary/commit/236c7dba05127d861dd97d0eeed2524e4e17a7e9))
* **cli:** run npm, npx and pnpm on Windows, and merge variables without case duplicates ([972a7d8](https://github.com/andersthemagi/reliquary/commit/972a7d8b00955d6531220a8cd304bf6034b09f1e))
* **cli:** say when to retry after the env API's rate limit ([78e1174](https://github.com/andersthemagi/reliquary/commit/78e1174652f268a7da0b523768108a73e1be01d5))
* **variables:** refuse Windows start-up, trust-store and npm config names ([f05b7d2](https://github.com/andersthemagi/reliquary/commit/f05b7d2852ca671c07efe6247d6e552ee6928427))

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
