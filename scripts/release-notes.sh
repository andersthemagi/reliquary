#!/usr/bin/env bash
# What a product release's GitHub Release notes add to release-please's
# changelog (.github/workflows/release.yml runs it after the release exists):
#
#   - a "Pre-alpha" line at the top while the version is 0.x;
#   - "Database migrations in this release": the files added under
#     supabase/migrations/ since the previous v* tag (all of them for the
#     first release);
#   - "Deploy": what publishing the release does, and how to redeploy or roll
#     back.
#
#   scripts/release-notes.sh v0.2.0           print the additions
#   scripts/release-notes.sh --apply v0.2.0   add them to the GitHub Release
#                                             (gh, GH_TOKEN); once only
#
# Reads the tag from the local repository (git fetch --tags first). Prints
# file names and titles only: nothing here is secret.
set -euo pipefail
cd "$(dirname "$0")/.."

apply=0
if [ "${1:-}" = --apply ]; then apply=1; shift; fi
tag=${1:-}
if ! [[ $tag =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "usage: scripts/release-notes.sh [--apply] vX.Y.Z (a product tag, not cli-v...)" >&2
  exit 2
fi
major=${BASH_REMATCH[1]}
version=${tag#v}
git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null ||
  { echo "no tag $tag in this repository (git fetch --tags)" >&2; exit 2; }
sha=$(git rev-parse "$tag^{commit}")

# The previous product release: the next lower v* tag by version.
prev=$(git tag -l 'v[0-9]*' --sort=-v:refname |
  grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | awk -v t="$tag" 'seen { print; exit } $0 == t { seen = 1 }')

if [ -n "$prev" ]; then
  migrations=$(git diff --name-only --diff-filter=A "$prev" "$tag" -- supabase/migrations/)
  since="since $prev"
else
  migrations=$(git ls-tree -r --name-only "$tag" -- supabase/migrations/)
  since="to date, this being the first release"
fi
migrations=$(grep -E '\.sql$' <<< "$migrations" | sed 's#.*/##' | sort || true)

repo_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-andersthemagi/reliquary}"
marker="<!-- reliquary:release-notes -->"

top=""
if [ "$major" = 0 ]; then
  top="**Pre-alpha.** Reliquary 0.x may change or remove anything between releases, including MCP tools and CLI commands. 1.0 is a deliberate decision by the owner, not a number that arrives on its own."
fi

section() {
  echo "$marker"
  echo
  echo "### Database migrations in this release"
  echo
  if [ -n "$migrations" ]; then
    echo "Added $since, applied in this order before the new code goes live:"
    echo
    while IFS= read -r m; do echo "- \`$m\`"; done <<< "$migrations"
  else
    echo "None $since: this release doesn't change the database."
  fi
  echo
  echo "Migrations are forward-only. Rolling back this release later redeploys older app code on the newer schema; it never undoes a migration."

  echo
  echo "### Deploy"
  echo
  echo "Publishing this release starts the [deploy workflow]($repo_url/actions/workflows/deploy.yml) for \`$tag\` (commit \`${sha:0:12}\`): migrations, then both Netlify sites built from exactly this commit, then smoke checks that \`/version\` on both apps answers \`$version\`. To redeploy it, or to roll back to it later: Actions > deploy > Run workflow on \`main\`, tag \`$tag\`."
}

if [ $apply = 0 ]; then
  [ -z "$top" ] || printf '%s\n\n' "$top"
  section
  exit 0
fi

body=$(gh release view "$tag" --json body -q .body)
if grep -qF "$marker" <<< "$body"; then
  echo "$tag: release notes already have the additions"
  exit 0
fi
{
  [ -z "$top" ] || printf '%s\n\n' "$top"
  printf '%s\n\n' "$body"
  section
} | gh release edit "$tag" --notes-file -
echo "$tag: added pre-alpha note, $(grep -c . <<< "$migrations" || true) migration(s) and deploy note"
