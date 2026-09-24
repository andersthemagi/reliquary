#!/usr/bin/env bash
# Re-encrypts every stored variable value (and every pending import's value)
# under the current key of VARIABLES_KEYS: the middle step of rotating the
# key (docs/ops/runbook.md, "Rotating VARIABLES_KEY"). It runs the web app's
# own code (web/src/rekey.ts) in a container, against the database the web
# app uses, as the web app's database role, with the keys the web app has:
# DATABASE_URL, DATABASE_CA_FILE and VARIABLES_KEYS from
# supabase/.vercel-web.env (written by `scripts/vercel-env.sh web ...`). Those
# reach the container through a mode-600 env file, never the command line.
#
#   scripts/rotate-variables-key.sh --check   which key ids hold how many values
#   scripts/rotate-variables-key.sh           re-encrypt, then the same report
#
# Deploy the VARIABLES_KEYS in that file to the web app first: values moved
# to a key the running app doesn't hold can't be read until it does.
#
# It prints counts and key ids only, never a key, a value, a variable name or
# a vault id, so it is safe to run from anywhere. Exit 0: everything is on the
# current key, so older keys may be dropped. 1: something isn't (run it
# again; if it persists, a value can't be opened with its key: set it again
# in the web UI). 2: it couldn't run.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

arg=${1:-}
case $arg in
  "" | --check) ;;
  *) echo "usage: scripts/rotate-variables-key.sh [--check]"; exit 2 ;;
esac

src=${ROTATE_ENV_FILE:-supabase/.vercel-web.env} # ROTATE_ENV_FILE: tests
if [[ ! -s $src ]]; then
  echo "No $src: run scripts/vercel-env.sh web <web-origin> <mcp-origin> first."
  exit 2
fi
if ! grep -q '^VARIABLES_KEYS=' "$src"; then
  echo "$src has no VARIABLES_KEYS (it predates key rotation): run scripts/vercel-env.sh web <web-origin> <mcp-origin> again."
  exit 2
fi

engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
node=docker.io/library/node:22-slim
root=$PWD

# Only what the re-encryption needs, in a gitignored mode-600 file that is
# removed on exit.
envfile=$(mktemp --suffix=.env supabase/.vercel-rotate-XXXXXX)
trap 'rm -f "$envfile"' EXIT
grep -E '^(DATABASE_URL|DATABASE_CA_FILE|VARIABLES_KEYS)=' "$src" > "$envfile"

# Build the web app's code as it is in this checkout.
[ -x web/node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$root/web":/app:Z -w /app "$node" npm ci --no-audit --no-fund >/dev/null
"$engine" run --rm --network none -v "$root/web":/app:Z -w /app "$node" npx tsc

echo "Using the database and keys in $src (names only; deploy those keys to the web app first)."
"$engine" run --rm --network host --env-file "$envfile" -v "$root/web":/app:Z,ro -w /app "$node" node dist/rekey.js $arg
