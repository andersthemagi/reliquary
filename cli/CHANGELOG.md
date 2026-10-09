# Changelog

What changed in `@reliquary-ai/cli`, release by release. Each release is a
Git tag `cli-vX.Y.Z` and a GitHub Release; entries after 0.1.0 are written by
release-please from conventional commits that touch `cli/`.

## [0.4.1](https://github.com/andersthemagi/reliquary/compare/cli-v0.4.0...cli-v0.4.1) (2026-10-09)

When a command run through `reliquary run` exits with its own error, Reliquary now adds one line saying the error is the command's, not Reliquary's, so a mistyped script name is no longer mistaken for a Reliquary failure; the exit code is unchanged. The second entry is a web change that touched the CLI's tests: signing in to the CLI shows the same consent page, where someone in several vaults now chooses which vaults it may reach. The CLI program itself is unchanged.


### Bug fixes

* **cli:** say a failed command's exit code is the command's, not Reliquary's ([#131](https://github.com/andersthemagi/reliquary/issues/131)) ([cdbd800](https://github.com/andersthemagi/reliquary/commit/cdbd800a1f44346ccf272b0f8bcf4b91b21ae05b))
* **web:** don't preselect all vaults when connecting an AI ([#138](https://github.com/andersthemagi/reliquary/issues/138)) ([5e589ea](https://github.com/andersthemagi/reliquary/commit/5e589ea7305293b55b1dc2c556a726b9fa7fe736))

## [0.4.0](https://github.com/andersthemagi/reliquary/compare/cli-v0.3.3...cli-v0.4.0) (2026-10-03)

No command or option changed in this release. The CLI's own code is the same apart from internal test cleanup, and the one entry below is the website's new headline, which release-please counted here.

### Features

* **web:** new hero headline, "The canon for humans and agents." ([#39](https://github.com/andersthemagi/reliquary/issues/39)) ([421f2f7](https://github.com/andersthemagi/reliquary/commit/421f2f752c2955d169719c2c0c3877a51ea8576e))

## [0.3.3](https://github.com/andersthemagi/reliquary/compare/cli-v0.3.2...cli-v0.3.3) (2026-09-29)

A real client vault name had leaked into a test fixture; renamed it to a generic one ahead of this repository going public.

### Security

* **docs:** the citation fixes and fixture rename from the last commit ([255e63c](https://github.com/andersthemagi/reliquary/commit/255e63c88096b31d73df1988b9b67ec7043118fb))

## [0.3.2](https://github.com/andersthemagi/reliquary/compare/cli-v0.3.1...cli-v0.3.2) (2026-09-29)


### Documentation

* **cli:** document the security posture in the README ([e626207](https://github.com/andersthemagi/reliquary/commit/e626207f12a6eaa2bfdcc2cef4d76b8cc4e00aad))

## [0.3.1](https://github.com/andersthemagi/reliquary/compare/cli-v0.3.0...cli-v0.3.1) (2026-09-29)


### Bug fixes

* **cli:** publish to npm by trusted publishing, not a stored token ([9110119](https://github.com/andersthemagi/reliquary/commit/91101199c3ac0d28df555dc456d644624d097032))

## [0.3.0](https://github.com/andersthemagi/reliquary/compare/cli-v0.2.0...cli-v0.3.0) (2026-09-28)


### Features

* **cli:** keep sign-ins in the OS keychain (macOS Keychain, Secret Service, Windows DPAPI) ([dc9c1d4](https://github.com/andersthemagi/reliquary/commit/dc9c1d49da7c152a5491d52d73b2d06846cf2c74))
* **cli:** the CLI speaks of its connection, and points to the Connections page ([1bfc8de](https://github.com/andersthemagi/reliquary/commit/1bfc8de59548754f7bbf06b301423447505b8e18))


### Bug fixes

* **cli:** print the server's reason and reference, and why a request got no answer ([1b62920](https://github.com/andersthemagi/reliquary/commit/1b62920578840a593862924e13d87004f44d2068))
* **cli:** publish under the MIT licence ([236c7db](https://github.com/andersthemagi/reliquary/commit/236c7dba05127d861dd97d0eeed2524e4e17a7e9))
* **cli:** run npm, npx and pnpm on Windows, and merge variables without case duplicates ([972a7d8](https://github.com/andersthemagi/reliquary/commit/972a7d8b00955d6531220a8cd304bf6034b09f1e))
* **cli:** say when to retry after the env API's rate limit ([78e1174](https://github.com/andersthemagi/reliquary/commit/78e1174652f268a7da0b523768108a73e1be01d5))
* **variables:** refuse Windows start-up, trust-store and npm config names ([f05b7d2](https://github.com/andersthemagi/reliquary/commit/f05b7d2852ca671c07efe6247d6e552ee6928427))

## [0.2.0](https://github.com/andersthemagi/reliquary/compare/cli-v0.1.0...cli-v0.2.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* **cli:** a .reliquary.json or RELIQUARY_URL naming https://reliquary.redmage.cc must change to https://app.reliquary.redmage.cc, then run `reliquary login` again.

### Features

* **cli:** the default server is https://app.reliquary.redmage.cc ([2e0916b](https://github.com/andersthemagi/reliquary/commit/2e0916b5ed99bf0a6ec30c7df50f73cbabf4bf6b))

## 0.1.0 (2026-09-25)

The first version, not yet on npm.

- `reliquary login` and `logout`: OAuth sign-in against the web app, kept in
  a mode-600 file.
- `reliquary vaults`: the vaults and roles this sign-in reaches.
- `reliquary run`: run one command with a vault environment's variables.
- `reliquary env pull`: write them to a gitignored `.env`.
- `reliquary env push`: send a `.env` as a pending import for a person to
  apply in the web UI (names shown, never values).
- Refuses values with a NUL character and prints names without control or
  bidirectional characters.
