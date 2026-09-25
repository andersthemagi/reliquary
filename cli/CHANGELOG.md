# Changelog

What changed in `@reliquary-ai/cli`, release by release. Each release is a
Git tag `cli-vX.Y.Z` and a GitHub Release; entries after 0.1.0 are written by
release-please from conventional commits that touch `cli/`.

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
