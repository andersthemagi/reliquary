# Contributing

Reliquary is pre-alpha and single-maintainer. The design and roadmap are
still moving fast, so for anything beyond a small, obvious fix, please
[open an issue](https://github.com/andersthemagi/reliquary/issues/new/choose)
to discuss it before writing a pull request. It saves both of us the work
of a PR that doesn't fit where the project is headed.

Bug reports, feature suggestions and feedback are always welcome, whether
or not you plan to write code yourself. One issue, one problem: if a
report bundles three things you've noticed, it'll get split into three,
so a template covers one report at a time on purpose. Use the
[templates](https://github.com/andersthemagi/reliquary/issues/new/choose);
they ask for what actually unblocks a fix (what you expected, how to
reproduce it, the job you're trying to do), not for a general essay.

## Requirements

- Linux, with bash 4 or newer and podman or docker. The suites start
  containers with `--network host` and call them on `127.0.0.1` from your
  shell, which works as written on Linux. We haven't run them on macOS or
  Windows, and macOS's stock bash 3.2 can't run `test.sh` at all (it uses
  `declare -A`).
- `git` and `curl` (and `python3`, for `./mcp/dev.sh`). Nothing else: Node, Postgres and the Supabase pieces
  run inside the containers, so the suites need no Node on your machine.
  The CLI's unit tests (`cd cli && npm test`) are the one exception: they
  use a host Node, 20 or 22, and CI runs them on Linux, macOS and Windows.

## Day to day

```bash
git clone https://github.com/andersthemagi/reliquary.git
cd reliquary
./test.sh                                    # every suite and the registry check
./test.sh web                                # one suite: sql, mcp, web or cli
MCP_TESTS=test/links.test.mjs ./mcp/test.sh  # one MCP test file
TEST_SLOT=8 ./test.sh                        # when another run holds your ports
```

`TEST_SLOT` moves every container name and port. A run uses its slot and the
next three, so pick a base at least four away from any run already going
(two worktrees at once, for example). The `sql`, `web` and `cli` suites have
no per-file switch, and there is no linter: `tsc` runs inside each suite's
build and is the only static check.

To see a change running, `./mcp/dev.sh up` starts Postgres, the MCP server
and the web UI (`http://127.0.0.1:8790`); `./mcp/dev.sh ui` opens it signed
in, and `./mcp/dev.sh down` stops it. The
[self-hosting guide](docs/public/how-to/self-host.md) is for deploying, not
for working on the code.

## Before you open a pull request

- Read [AGENTS.md](AGENTS.md): the guardrails and conventions this
  codebase runs on (how access control is enforced, the testing policy,
  commit message format). It's written for any contributor, human or
  agent.
- Run `./test.sh`. CI runs it again on every push and pull request, along
  with a self-hosting smoke test, a secret scan, a dependency audit and
  CodeQL.
- Commit, then run `./scripts/test-guard.sh origin/main` (use the remote
  that points at this repository). It is CI's `guard` job, `./test.sh`
  doesn't run it, and it is the check an outside change most often trips.
- A bug fix needs a test that fails without the fix. A changed existing
  test needs a `Changes-behaviour:` or `Test-refactor:` commit trailer
  (see AGENTS.md's Testing section for exactly when).
- Follow [conventional commits](https://www.conventionalcommits.org/)
  (`feat(web): ...`, `fix(mcp): ...`) for your **PR title**, the line that
  becomes the changelog entry. CI checks it on open and on edit.
- Keep each commit (and ideally the whole PR) to one thing: about 100
  changed lines is a normal size, 1000 is a sign to split it. If a change
  needs a refactor and a feature, that's two commits, so a reviewer can
  read them as separate claims.

### How your pull request is merged

Every PR is squash-merged with the PR title as the commit subject, so the
unit that lands on `main` is the PR. The guard runs again on `main` and
reads that one squash commit. A `Changes-behaviour:` or `Test-refactor:`
trailer counts only in the **last paragraph** of its message, beside any
`Co-Authored-By:`, and GitHub's default squash body lists your commit
messages as bullets, which buries it. So end your PR description with the
same trailer as its own last paragraph, and the maintainer puts it in the
squash body.

## Reviewing and commenting

Prefix a review comment with what kind of comment it is, [Conventional
Comments](https://conventionalcomments.org/) style: `praise:`,
`suggestion:`, `issue:`, `question:`, `nitpick:`, `todo:`, `chore:`. Add
`(blocking)` or `(non-blocking)` when the label alone doesn't make that
obvious. It's the same problem conventional commits already solves for
commit subjects, applied to the back-and-forth: the prefix says whether a
comment blocks merge before anyone has to say so in prose, and a
`nitpick:` is explicitly fine for the author to leave unaddressed. Use the
same convention when you leave a comment on your own PR, e.g. flagging a
spot you're unsure about.

## License

The server (everything outside `cli/`) is FSL-1.1-ALv2
([LICENSE.md](LICENSE.md)); the CLI is MIT ([cli/LICENSE](cli/LICENSE)).
Anything you contribute is under the license of the part of the repo it
lands in.

## Reporting a security issue

Not in a public issue. See [SECURITY.md](SECURITY.md).
