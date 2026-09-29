# Security

Reliquary is pre-alpha. Supported version: whatever's running at
[reliquary.redmage.cc](https://reliquary.redmage.cc), always the latest
release; self-hosters should stay on the latest tag too.

## Reporting a vulnerability

Email andres@redmage.cc with what you found and how to reproduce it. Don't
open a public issue for it. We'll acknowledge it, keep you updated, and
credit you if you'd like.

Please test only against your own account and vaults, don't access other
people's data, and give us reasonable time to fix it before you publish.
We won't take action against good-faith research that follows these
rules.

Full policy: [reliquary.redmage.cc/security](https://reliquary.redmage.cc/security),
also at [/.well-known/security.txt](https://reliquary.redmage.cc/.well-known/security.txt).

## What's already covered

Every push and pull request runs a secret scan, a dependency audit and
CodeQL static analysis ([.github/workflows/security.yml](.github/workflows/security.yml),
[.github/workflows/codeql.yml](.github/workflows/codeql.yml)) before it can
reach `main`. Access control is enforced in the database as Postgres
row-level security, not the API, with a hostile test for every rule. See
[docs/design.md](docs/design.md) and the [security page](https://reliquary.redmage.cc/security)
for what that means in practice, including what we can't promise.
