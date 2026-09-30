<!-- Title this PR as a conventional commit, e.g. "feat(web): export a vault as .tar.gz" or "fix(mcp): refuse a NUL byte in feedback's context field". CI checks it: this PR is squash-merged, and the title becomes the changelog entry, not any individual commit message. See CONTRIBUTING.md. -->

## What and why

<!-- The job this does, not just what changed. Link the issue it was discussed in, if there was one. -->

## Testing

<!-- What you ran, and what it showed. A bug fix needs a test that fails without the fix. -->

## Checklist

- [ ] `./test.sh` passes locally
- [ ] Docs updated if this changes something documented (see AGENTS.md's Docs section)
- [ ] A `Changes-behaviour:` or `Test-refactor:` trailer if an existing test changed (see AGENTS.md's Testing section)
