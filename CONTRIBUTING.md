# Contributing

Reliquary is pre-alpha and single-maintainer. The design and roadmap are
still moving fast, so for anything beyond a small, obvious fix, please
[open an issue](https://github.com/andersthemagi/reliquary/issues/new/choose)
to discuss it before writing a pull request. It saves both of us the work
of a PR that doesn't fit where the project is headed.

Bug reports, feature suggestions and feedback are always welcome, whether
or not you plan to write code yourself.

## Set up

You need Podman or Docker; nothing else needs to be installed on your
machine (no Node required on the host). Then:

```bash
git clone https://github.com/andersthemagi/reliquary.git
cd reliquary
./test.sh
```

`./test.sh` runs every suite (schema, MCP, web, CLI) in containers. See
[docs/public/how-to/self-host.md](docs/public/how-to/self-host.md) to run
the app itself.

## Before you open a pull request

- Read [AGENTS.md](AGENTS.md): the guardrails and conventions this
  codebase runs on (how access control is enforced, the testing policy,
  commit message format). It's written for any contributor, human or
  agent.
- Run `./test.sh`. CI runs it again on every push and pull request, along
  with a secret scan, a dependency audit and CodeQL.
- A bug fix needs a test that fails without the fix. A changed existing
  test needs a `Changes-behaviour:` or `Test-refactor:` commit trailer
  (see AGENTS.md's Testing section for exactly when).
- Follow [conventional commits](https://www.conventionalcommits.org/)
  (`feat(web): ...`, `fix(mcp): ...`): commit types drive the changelog.

## License

The server (everything outside `cli/`) is FSL-1.1-ALv2
([LICENSE.md](LICENSE.md)); the CLI is MIT ([cli/LICENSE](cli/LICENSE)).
Anything you contribute is under the license of the part of the repo it
lands in.

## Reporting a security issue

Not in a public issue. See [SECURITY.md](SECURITY.md).
