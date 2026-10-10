#!/usr/bin/env bash
# Re-encrypts every stored variable value, every pending import's value and
# every link's credential under the current key of VARIABLES_KEYS (links are
# sealed with the same keys): the middle step of rotating the
# key (docs/ops/runbook.md, "Rotating VARIABLES_KEY"). It runs the web app's
# own code (web/src/rekey.ts) in a container, against the database the web
# app uses, with the keys the web app has, as the operator's database role
# (reliquary_ops: only it may read and swap stored ciphertext; the web app's
# role may not). It reads DATABASE_URL, DATABASE_CA_FILE and VARIABLES_KEYS
# from supabase/.netlify-web.env (written by `scripts/netlify-env.sh web ...`)
# and the operator's password from supabase/.ops-db-password (written by
# `scripts/set-role-passwords.sh ops`); rekey.ts logs in as reliquary_ops to
# the database DATABASE_URL names. Those reach the container through a
# mode-600 env file, never the command line.
#
#   scripts/rotate-variables-key.sh --check   which key ids hold how many values and link credentials
#   scripts/rotate-variables-key.sh           re-encrypt, then the same report
#
# Deploy the VARIABLES_KEYS in that file to the web app first: values moved
# to a key the running app doesn't hold can't be read until it does.
#
# It prints counts and key ids only, never a key, a password, a value, a
# variable name or a vault id, so it is safe to run from anywhere. Exit 0:
# everything is on the current key, so older keys may be dropped. 1:
# something isn't (run it again; if it persists, a value or credential can't
# be opened with its key: set the value again in the web UI, or delete the
# link and add it again). 2: it couldn't run.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

arg=${1:-}
case $arg in
  "" | --check) ;;
  *) echo "usage: scripts/rotate-variables-key.sh [--check]"; exit 2 ;;
esac

src=supabase/.netlify-web.env
ops=supabase/.ops-db-password
if [[ ! -s $src ]]; then
  echo "No $src: run scripts/netlify-env.sh web <web-origin> <mcp-origin> first."
  exit 2
fi
if ! grep -q '^VARIABLES_KEYS=' "$src"; then
  echo "$src has no VARIABLES_KEYS (it predates key rotation): run scripts/netlify-env.sh web <web-origin> <mcp-origin> again."
  exit 2
fi
if [[ ! -s $ops ]]; then
  echo "No $ops: run scripts/set-role-passwords.sh ops first (it gives reliquary_ops, the operator's role, a password)."
  exit 2
fi
if ! tr -d '[:space:]' < "$ops" | grep -qE '^[A-Za-z0-9_-]{16,}$'; then
  echo "$ops isn't a password set-role-passwords.sh wrote: delete it and run scripts/set-role-passwords.sh ops again."
  exit 2
fi

source scripts/lib/engine.sh
node=docker.io/library/node:22-slim
root=$PWD

# Only what the re-encryption needs, in a gitignored mode-600 file that is
# removed on exit. printf is a builtin: the password is on no command line.
envfile=$(mktemp --suffix=.env supabase/.netlify-rotate-XXXXXX)
trap 'rm -f "$envfile"' EXIT
grep -E '^(DATABASE_URL|DATABASE_CA_FILE|VARIABLES_KEYS)=' "$src" > "$envfile"
printf 'OPS_DB_PASSWORD=%s\n' "$(tr -d '[:space:]' < "$ops")" >> "$envfile"

# Build the web app's code as it is in this checkout.
[ -x web/node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$root/web":/app:Z -w /app "$node" npm ci --no-audit --no-fund >/dev/null
"$engine" run --rm --network none -v "$root/web":/app:Z -w /app "$node" npx tsc

echo "Using the database and keys in $src, as reliquary_ops (names only; deploy those keys to the web app first)."
"$engine" run --rm --network host --env-file "$envfile" -v "$root/web":/app:Z,ro -w /app "$node" node dist/rekey.js $arg
