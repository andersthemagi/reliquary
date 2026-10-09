# Changelog

What changed in Reliquary, release by release. Each release is a Git tag
`vX.Y.Z` and a GitHub Release; production always runs the latest one (the
footer and `GET /version` on both apps say which). Entries after 0.1.0 are
written by release-please from conventional commits. The command line has its
own changelog: [cli/CHANGELOG.md](cli/CHANGELOG.md).

## [0.16.1](https://github.com/andersthemagi/reliquary/compare/v0.16.0...v0.16.1) (2026-10-09)

Adds a Connect an agent button beside New file on every vault's front page, so you can connect an agent from any vault at any time; before, the way in was the first-run step of a vault's first 14 days, or the inside of an empty vault. No database changes.


### Bug fixes

* **web:** every vault's front page has a Connect an agent button beside New file, so connecting an agent no longer depends on the first-run step ([#169](https://github.com/andersthemagi/reliquary/issues/169)) ([79dbd6d](https://github.com/andersthemagi/reliquary/commit/79dbd6d6836d4b1d449b7ede94343ea9b3c61db8))

## [0.16.0](https://github.com/andersthemagi/reliquary/compare/v0.15.0...v0.16.0) (2026-10-09)

Adds a guided path from a new vault to its first connected agent, claim rules for a whole vault, and setting a variable in several environments at once; the rest hardens what exists: link credentials follow key rotation and a link's URL can no longer carry a key, approvals apply only the revision the reviewer read, a stale save can't bring back a deleted file, a cancelled export or dropped database connection no longer stops the server, and token and consent screens no longer preselect all vaults for someone in several vaults. Five database migrations apply before the new code goes live.


### Features

* **web:** guide a new vault to its first connected agent ([#157](https://github.com/andersthemagi/reliquary/issues/157)) ([caf4408](https://github.com/andersthemagi/reliquary/commit/caf44081ad2c112da3cf3b3aac4756a3a39a19ae))
* **web:** set a claim rule for the whole vault, on a claim rules page that explains itself ([#140](https://github.com/andersthemagi/reliquary/issues/140)) ([e07cae9](https://github.com/andersthemagi/reliquary/commit/e07cae951f6a7be445d77097bb8e073e28cff059))
* **web:** set a variable in several environments at once ([#132](https://github.com/andersthemagi/reliquary/issues/132)) ([2126370](https://github.com/andersthemagi/reliquary/commit/2126370fc00d25cc0ab3c0b01b62df718a73d34a))


### Bug fixes

* **cli:** say a failed command's exit code is the command's, not Reliquary's ([#131](https://github.com/andersthemagi/reliquary/issues/131)) ([cdbd800](https://github.com/andersthemagi/reliquary/commit/cdbd800a1f44346ccf272b0f8bcf4b91b21ae05b))
* **db:** a save made after someone deleted the file no longer brings it back ([#167](https://github.com/andersthemagi/reliquary/issues/167)) ([c6b9846](https://github.com/andersthemagi/reliquary/commit/c6b9846192e1fdda6e35e965d524d7f5fa3da036))
* **mcp:** a failed link call tells the agent where it broke, with a reference, and never what the upstream said ([#166](https://github.com/andersthemagi/reliquary/issues/166)) ([cbea61e](https://github.com/andersthemagi/reliquary/commit/cbea61e6131a84374d8cbb0d997ae0e9200fbd1f))
* **mcp:** annotate advance_flags as non-destructive and idempotent ([#134](https://github.com/andersthemagi/reliquary/issues/134)) ([9bf2e0a](https://github.com/andersthemagi/reliquary/commit/9bf2e0ac7692b258e7bbe77d3b833b3270f3ae2c))
* **mcp:** tell agents an approved proposal can't be revised ([#133](https://github.com/andersthemagi/reliquary/issues/133)) ([47e32c1](https://github.com/andersthemagi/reliquary/commit/47e32c140140b1fc01657559ba3b1859aca09111))
* **mcp:** two vaults' same-named link tools no longer hang every request, and upstream tool text is quoted ([#165](https://github.com/andersthemagi/reliquary/issues/165)) ([11e12cc](https://github.com/andersthemagi/reliquary/commit/11e12cce2690c2da5a99d02039822beaff6e4217))
* **review:** an approval applies only the revision its reviewer read, and two at once can't both apply or deadlock ([#160](https://github.com/andersthemagi/reliquary/issues/160)) ([ed30a58](https://github.com/andersthemagi/reliquary/commit/ed30a58c0324977eedcb128bad9647a028093dff))
* **variables:** key rotation re-encrypts link credentials too ([d695a27](https://github.com/andersthemagi/reliquary/commit/d695a27e88ba97c3b79311088059ffd58adbdf6f))
* **web,mcp:** a cancelled export download or a dropped database connection no longer stops the server ([19fa99a](https://github.com/andersthemagi/reliquary/commit/19fa99a7b8e2e36d411006756c70e04c9938b72a))
* **web,mcp:** an oversize request body is answered with its limit, and invite links opened together no longer stall ([c57dae1](https://github.com/andersthemagi/reliquary/commit/c57dae1eb53d64af951527989301720ce35ee527))
* **web:** a refused save keeps you in the form you were in, on Links, Environments, Watching, tokens, vaults and account ([#146](https://github.com/andersthemagi/reliquary/issues/146)) ([7ed8f40](https://github.com/andersthemagi/reliquary/commit/7ed8f40a6a98bbab723a3d0e540cef1555c4df1e))
* **web:** an applied proposal shows what it changed; warn before approving one whose file moved ([#148](https://github.com/andersthemagi/reliquary/issues/148)) ([aa665ab](https://github.com/andersthemagi/reliquary/commit/aa665abbe7a72c008a582003ea917323e05430d2))
* **web:** don't preselect all vaults when connecting an AI ([#138](https://github.com/andersthemagi/reliquary/issues/138)) ([5e589ea](https://github.com/andersthemagi/reliquary/commit/5e589ea7305293b55b1dc2c556a726b9fa7fe736))
* **web:** invite sign-in recognises an accented address however it is typed and says so when it can't look an invite up ([#164](https://github.com/andersthemagi/reliquary/issues/164)) ([f7908ff](https://github.com/andersthemagi/reliquary/commit/f7908ff444671eeac7fc4dcc75e73f44b79752e6))
* **web:** menus on Rules, Links and Inbox rows open in full instead of a clipped sliver ([#139](https://github.com/andersthemagi/reliquary/issues/139)) ([45a05e6](https://github.com/andersthemagi/reliquary/commit/45a05e67a2c4e21608049ca3dbb54a6fa55f42fe))
* **web:** no links to pages that 404, thread flags that say what they are, a rule that can never be approved says so ([#150](https://github.com/andersthemagi/reliquary/issues/150)) ([47190ad](https://github.com/andersthemagi/reliquary/commit/47190ad64637f3c4f31358d80db4fc6898201508))
* **web:** phone table rows, a wrapping Links URL, no buttons that only scroll, a locked Change path ([#145](https://github.com/andersthemagi/reliquary/issues/145)) ([c5e4fc9](https://github.com/andersthemagi/reliquary/commit/c5e4fc928717bed69d8f9c2302541fa6ce10a961))
* **web:** refused file and proposal forms keep what you typed; Create file never overwrites ([#147](https://github.com/andersthemagi/reliquary/issues/147)) ([74f7174](https://github.com/andersthemagi/reliquary/commit/74f7174f09b61f9b7d1fcabf9bc762b0afd57a2e))
* **web:** renewing a session no longer signs people out when Supabase Auth is busy, and is limited per IP ([714c194](https://github.com/andersthemagi/reliquary/commit/714c19420e0b96639c74003ffb545ca66ac575bb))
* **web:** template READMEs call variables examples and say what to do without npx ([#135](https://github.com/andersthemagi/reliquary/issues/135)) ([f05c39a](https://github.com/andersthemagi/reliquary/commit/f05c39a664ba7640a1fee847858ba716be8ed3d2))
* **web:** the page that answers a refused save keeps the top bar's vault switcher and inbox ([#143](https://github.com/andersthemagi/reliquary/issues/143)) ([ace181f](https://github.com/andersthemagi/reliquary/commit/ace181fb5ae52fa55c6fe1eef52b94602892b06c))
* **web:** variables keep multi-line values intact, ask before replacing one, and every refusal carries a reference ([#149](https://github.com/andersthemagi/reliquary/issues/149)) ([39d451e](https://github.com/andersthemagi/reliquary/commit/39d451ed1c2f95f9b7e7487007921fa7a4b5d149))
* **web:** vault page copy says what is true: links are callable, no Rotate, no quorum, Erase file ([#144](https://github.com/andersthemagi/reliquary/issues/144)) ([f937baf](https://github.com/andersthemagi/reliquary/commit/f937bafe1ec355ec1c1b0841ad413dc5d68e0893))


### Security

* **links:** a link's url refuses a user name, password, query string or fragment ([#161](https://github.com/andersthemagi/reliquary/issues/161)) ([5518ce4](https://github.com/andersthemagi/reliquary/commit/5518ce465871cf892d6928479cc8f5fe929ca65c))
* **web:** a refused client-metadata or link-discovery answer no longer holds its connection open ([06d56a3](https://github.com/andersthemagi/reliquary/commit/06d56a3086cb4b214614380493d8292e50c69548))
* **web:** the Feedback popover no longer sends an invite link's token ([#141](https://github.com/andersthemagi/reliquary/issues/141)) ([9f89ed2](https://github.com/andersthemagi/reliquary/commit/9f89ed2b10dd079944e64bb869d261c43c44dd88))

## [0.15.0](https://github.com/andersthemagi/reliquary/compare/v0.14.0...v0.15.0) (2026-10-03)

Vaults get threads, conversations between members and their agents, with a Threads page and four MCP tools, and work plans get a Tasks page and MCP tools to register a plan and work its steps. Changes replaces Activity in a vault's navigation as a plain-language feed, flags and claims move under Diagnostics, a file's page shows who is working on it, and agents are told when flags are waiting.

### Features

* **claims:** checkin_step for work plan steps (CL-3.2 gap, [#70](https://github.com/andersthemagi/reliquary/issues/70)) ([#115](https://github.com/andersthemagi/reliquary/issues/115)) ([5568e5a](https://github.com/andersthemagi/reliquary/commit/5568e5a79f58295a95ac3793ba4d7d3e18aab23a))
* **claims:** the work plan block's grammar and parser (CL-3.1) ([#108](https://github.com/andersthemagi/reliquary/issues/108)) ([faa09cb](https://github.com/andersthemagi/reliquary/commit/faa09cbf2a524eacb0a13878051165b5fd1f7d83))
* **claims:** work plan tables and functions (CL-3.2) ([#109](https://github.com/andersthemagi/reliquary/issues/109)) ([c2b07b5](https://github.com/andersthemagi/reliquary/commit/c2b07b543f56c30c1b238071a52e85b203c4da21))
* **db:** threads and messages inside a vault ([#126](https://github.com/andersthemagi/reliquary/issues/126)) ([2750846](https://github.com/andersthemagi/reliquary/commit/2750846a104ad3de7b5862af0b0b8e5456631b85))
* **flags:** flag a vault's thread messages to the members they reach ([#127](https://github.com/andersthemagi/reliquary/issues/127)) ([c5fbdcd](https://github.com/andersthemagi/reliquary/commit/c5fbdcd873624afd4e6bc7ccb0a09ba8ba54ab50))
* **mcp:** open, read and post to threads over MCP ([#129](https://github.com/andersthemagi/reliquary/issues/129)) ([c1afd23](https://github.com/andersthemagi/reliquary/commit/c1afd239afe3c14363d7594dcaa964b58d940fca))
* **mcp:** register work plans and work their steps over MCP ([#124](https://github.com/andersthemagi/reliquary/issues/124)) ([0992cc1](https://github.com/andersthemagi/reliquary/commit/0992cc1af6784ed05c49640acd10f62e52ddf3e5))
* **mcp:** tell an agent when flags are waiting ([#130](https://github.com/andersthemagi/reliquary/issues/130)) ([7e88b0a](https://github.com/andersthemagi/reliquary/commit/7e88b0a58bd87fa8314056a8abb6c24730db859e))
* **path-ownership:** a named owner gets edit-and-approve, comments and the web app's controls ([#105](https://github.com/andersthemagi/reliquary/issues/105)) ([cddaedb](https://github.com/andersthemagi/reliquary/commit/cddaedbb5c46133ee79d825a10d0789d53620a52))
* **web:** a plain-language Changes feed for each vault ([#123](https://github.com/andersthemagi/reliquary/issues/123)) ([2ad8a34](https://github.com/andersthemagi/reliquary/commit/2ad8a345a49989e4d326e15fb59a8666b6b7978a))
* **web:** a Tasks page to see and steer a vault's work plans ([#122](https://github.com/andersthemagi/reliquary/issues/122)) ([c93c436](https://github.com/andersthemagi/reliquary/commit/c93c436d00552d7ddb4ce6d49b0331a4c49e6c50))
* **web:** a Threads page where people and their agents talk about the work ([#128](https://github.com/andersthemagi/reliquary/issues/128)) ([0e308de](https://github.com/andersthemagi/reliquary/commit/0e308def11e778a25524cc4e5e2f549d80b95a1b))
* **web:** filter Changes to what you made or watch ([#125](https://github.com/andersthemagi/reliquary/issues/125)) ([e48a2d8](https://github.com/andersthemagi/reliquary/commit/e48a2d87784bb95240df9ab1650d0fa5c7eaf807))
* **web:** move flags and claims under a Diagnostics area ([#121](https://github.com/andersthemagi/reliquary/issues/121)) ([e406bc5](https://github.com/andersthemagi/reliquary/commit/e406bc559f47d19c547357baad8ded8894079d3f))
* **web:** show who is working on a file, and let an owner or editor break the claim there ([#120](https://github.com/andersthemagi/reliquary/issues/120)) ([d393fe3](https://github.com/andersthemagi/reliquary/commit/d393fe3f8d17b46a5e020497034cab8520d5582b))


### Bug fixes

* **db:** asPerson treats a failed rollback as a broken client ([#107](https://github.com/andersthemagi/reliquary/issues/107)) ([6d4b2f1](https://github.com/andersthemagi/reliquary/commit/6d4b2f19c1f23d4320582d88d487802f032c94c9))
* **web,mcp:** map work plan step SQLSTATEs to a status and a name ([#114](https://github.com/andersthemagi/reliquary/issues/114)) ([c0636de](https://github.com/andersthemagi/reliquary/commit/c0636dede93399b33cdbd6c6049b2ecc0e8df0d6))

## [0.14.0](https://github.com/andersthemagi/reliquary/compare/v0.13.0...v0.14.0) (2026-10-01)


### Features

* **claims:** claim rules -- setter, presets and the web control (CL-2.7) ([#100](https://github.com/andersthemagi/reliquary/issues/100)) ([d14db01](https://github.com/andersthemagi/reliquary/commit/d14db0169832df3455d7945ff37d7ab153fdd5d9)), closes [#69](https://github.com/andersthemagi/reliquary/issues/69)
* **claims:** lock order against delete_vault and erase_file (CL-2.2) ([#96](https://github.com/andersthemagi/reliquary/issues/96)) ([f6e225c](https://github.com/andersthemagi/reliquary/commit/f6e225c44a9f90410f6c0bef233984801423d2e9)), closes [#65](https://github.com/andersthemagi/reliquary/issues/65)
* **claims:** path claims table and functions (CL-2.1) ([#95](https://github.com/andersthemagi/reliquary/issues/95)) ([07f8bb1](https://github.com/andersthemagi/reliquary/commit/07f8bb1c04cb09cc94fab0340bdd6220261db68c)), closes [#63](https://github.com/andersthemagi/reliquary/issues/63)
* **db:** write_file and delete_file accept an expected version ([#85](https://github.com/andersthemagi/reliquary/issues/85)) ([bc0223a](https://github.com/andersthemagi/reliquary/commit/bc0223a518a305089088c079d0d78b8dc2b9dd2a)), closes [#57](https://github.com/andersthemagi/reliquary/issues/57)
* **mcp:** claim tools over MCP, and read_file shows an active claim (CL-2.4) ([#98](https://github.com/andersthemagi/reliquary/issues/98)) ([9a4d7ec](https://github.com/andersthemagi/reliquary/commit/9a4d7ec989137ceecdc821f761d227b20b681c01)), closes [#67](https://github.com/andersthemagi/reliquary/issues/67)
* **mcp:** read_file returns the file's current version id ([#84](https://github.com/andersthemagi/reliquary/issues/84)) ([a9520d5](https://github.com/andersthemagi/reliquary/commit/a9520d5a39908028abaffef5de115c0ee3b80027)), closes [#56](https://github.com/andersthemagi/reliquary/issues/56)
* **mcp:** write_file and delete_file take expected_version ([#87](https://github.com/andersthemagi/reliquary/issues/87)) ([6f4fec0](https://github.com/andersthemagi/reliquary/commit/6f4fec0f413de9ae516c89fc0d9441478a57653a)), closes [#59](https://github.com/andersthemagi/reliquary/issues/59)
* **web:** a vault's Claims page, and the Break action (CL-2.5) ([#99](https://github.com/andersthemagi/reliquary/issues/99)) ([a3f8991](https://github.com/andersthemagi/reliquary/commit/a3f8991b01a7558aef59064012654ecf1bbb21f5)), closes [#68](https://github.com/andersthemagi/reliquary/issues/68)
* **web:** reframe the landing page from reader-check findings ([#51](https://github.com/andersthemagi/reliquary/issues/51)) ([6089bb2](https://github.com/andersthemagi/reliquary/commit/6089bb24de8221f43fb67860a1589b9d7d494194))
* **web:** the editor carries the file's version and shows a conflict ([#88](https://github.com/andersthemagi/reliquary/issues/88)) ([1d83642](https://github.com/andersthemagi/reliquary/commit/1d8364290e41c021b519e4b53fb637eafd2d10db)), closes [#60](https://github.com/andersthemagi/reliquary/issues/60)


### Bug fixes

* **signin:** double-tapped invite sign-up no longer shows 'Sign-in is unavailable' ([#102](https://github.com/andersthemagi/reliquary/issues/102)) ([1ef93d2](https://github.com/andersthemagi/reliquary/commit/1ef93d2c696ea11f1f662ab154aa8140851f9a45))
* **signin:** double-tapped invite sign-up no longer shows "Sign-in is unavailable" ([1ef93d2](https://github.com/andersthemagi/reliquary/commit/1ef93d2c696ea11f1f662ab154aa8140851f9a45))

## [0.13.0](https://github.com/andersthemagi/reliquary/compare/v0.12.0...v0.13.0) (2026-09-29)

An owner can now make an invite link for anyone to use, up to a set number of joins, instead of one for a single known address. A gap in feedback's NUL-byte check is closed too.

### Features

* **web:** open invite links, good for anyone up to a use count ([95afd75](https://github.com/andersthemagi/reliquary/commit/95afd75dacf20adda45ae4040b17a590836d3a19))


### Bug fixes

* **mcp:** refuse a NUL byte in feedback's context field too ([#46](https://github.com/andersthemagi/reliquary/issues/46)) ([5be8c10](https://github.com/andersthemagi/reliquary/commit/5be8c106a48fa6ff55d3404072fc590db4104861))

## [0.12.0](https://github.com/andersthemagi/reliquary/compare/v0.11.1...v0.12.0) (2026-09-29)

The public-facing repo and site get a refresh: a new hero headline ("The canon for humans and agents."), real CI status badges and GitHub's standard community-health files (security policy, code of conduct, contributing guide) on the README, and CodeQL scoped past its test-file false positives.

### Features

* **web:** note why the hero headline changed ([#41](https://github.com/andersthemagi/reliquary/issues/41)) ([1c70741](https://github.com/andersthemagi/reliquary/commit/1c7074143d4202c21ea5dd2cd5d00b12ba1d369a))


### Security

* **ci:** scope CodeQL past test-file false positives ([26bdf77](https://github.com/andersthemagi/reliquary/commit/26bdf7797676576afb8b33c1ddba1d7f84de4bba))

## [0.11.1](https://github.com/andersthemagi/reliquary/compare/v0.11.0...v0.11.1) (2026-09-29)

Security work ahead of making this repository public: automated scans for leaked secrets, vulnerable dependencies and risky code on every push, and business-strategy or legal-draft content moved out to a private repo. Also two CLI reliability fixes: npm publishing now uses trusted OIDC publishing instead of a stored token, and a CI ownership bug that could break the release build is fixed.

### Bug fixes

* **cli:** publish to npm by trusted publishing, not a stored token ([9110119](https://github.com/andersthemagi/reliquary/commit/91101199c3ac0d28df555dc456d644624d097032))
* **cli:** reclaim root-owned files before the runner's own npm ci ([945e782](https://github.com/andersthemagi/reliquary/commit/945e782155c8b104392955bd482087e8fef5f511))


### Security

* **ci:** add CodeQL static analysis ([ed56b9c](https://github.com/andersthemagi/reliquary/commit/ed56b9c0748727a101f6d99ca717c1067cca10b4))
* **ci:** flag a live secret or a high/critical dependency vulnerability before it hits main ([3f8363e](https://github.com/andersthemagi/reliquary/commit/3f8363e10ccbbc71b356b54827413946edcd1f96))
* **ci:** stop trufflehog failing on unverified findings ([a8b540c](https://github.com/andersthemagi/reliquary/commit/a8b540ce7d22775698210c42a3baf121606e6ba5))
* **docs:** move business strategy and draft licensing out; scrub a real vault name from a test fixture ([57e9fc5](https://github.com/andersthemagi/reliquary/commit/57e9fc5d0b57c5b0053b446766db5cc437902148))
* **docs:** the citation fixes and fixture rename from the last commit ([255e63c](https://github.com/andersthemagi/reliquary/commit/255e63c88096b31d73df1988b9b67ec7043118fb))
* **publish-cli:** gate npm publish on a clean audit ([e406fc0](https://github.com/andersthemagi/reliquary/commit/e406fc0e1b283f66bc92bb2c861193092421123d))

## [0.11.0](https://github.com/andersthemagi/reliquary/compare/v0.10.0...v0.11.0) (2026-09-29)

A Flags tab in every vault, so you can see what's changed without asking your agent, plus two layout bugs fixed: nav links that could hide behind the search box, and file or proposal text that could get cut off instead of wrapping.

### Features

* **web:** every vault has a Flags tab: a proposal waiting on your review, your own proposals, and paths you watch, the same things your agents have been able to see over MCP since 0.9.0 ([d0e0668](https://github.com/andersthemagi/reliquary/commit/d0e0668746bb2af9df3d48314abd71c3d0fb4e5c))


### Bug fixes

* **web:** the top navigation could overlap the search box and hide the Docs and Connect links on many window sizes; it now always gets its own row ([0a14728](https://github.com/andersthemagi/reliquary/commit/0a147287dd7b5a74c2dd311c438748730ae7a459))
* **web:** long, unbroken text (a URL, say) and wide tables in a rendered file or proposal could get cut off instead of wrapping on a narrow screen; both now wrap ([0a14728](https://github.com/andersthemagi/reliquary/commit/0a147287dd7b5a74c2dd311c438748730ae7a459))
* **db:** two database indexes the performance advisor flagged (account plans, vault storage tiers) are now in place; nothing user-visible, just cheaper lookups ([f4a6c1b](https://github.com/andersthemagi/reliquary/commit/f4a6c1bd6fd2588e793205bc63c334bf88876240))

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
