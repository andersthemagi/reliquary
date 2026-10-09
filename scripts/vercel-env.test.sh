#!/usr/bin/env bash
# Tests for scripts/vercel-env.sh, in a throwaway copy of the repository's
# scripts and an empty supabase/ directory, so no real secret is read or
# written. Needs bash and jq; no containers. Run it by hand, or as CI's guard
# job does:
#
#   scripts/vercel-env.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
command -v jq >/dev/null || { echo "vercel-env.test: needs jq" >&2; exit 2; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo=$tmp/repo
# Made up for this file; the characters that have to be percent-encoded.
fake_pw='fake/pw:with@odd+chars'
fails=0
out=""
code=0

fresh() {
  rm -rf "$repo"
  mkdir -p "$repo/scripts/lib" "$repo/supabase"
  cp "$here/vercel-env.sh" "$here/variables-keys.sh" "$repo/scripts/"
  cp "$here/lib/supabase-env.sh" "$repo/scripts/lib/"
}

# run <args...>: the script's output (both streams) in $out, its exit code in $code.
run() {
  code=0
  out=$(cd "$repo" && ./scripts/vercel-env.sh "$@" 2>&1) || code=$?
}

# t <name> <command...>: passes when the command succeeds.
t() {
  local name=$1
  shift
  if "$@"; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name"
    printf '%s\n' "$out" | sed 's/^/        /'
    fails=$((fails + 1))
  fi
}
no_files() { [ -z "$(ls -A "$repo/supabase")" ]; }
mode_is() { [ "$(stat -c %a "$1")" = "$2" ]; }

for app in web mcp; do
  fresh
  run "$app" https://app.example.test https://mcp.example.test
  t "$app without its password file exits 1" test "$code" = 1
  t "$app without its password file names the file" grep -qF "supabase/.$app-db-password" <<< "$out"
  t "$app without its password file names the script that makes it" grep -qF "scripts/set-role-passwords.sh" <<< "$out"
  t "$app without its password file writes nothing, not even a secret of its own" no_files
done

fresh
printf ' \n\t\n' > "$repo/supabase/.mcp-db-password"
run mcp https://app.example.test https://mcp.example.test
t "an empty password file is refused like a missing one" test "$code" = 1
t "an empty password file leaves no env file to paste" test ! -e "$repo/supabase/.vercel-mcp.env"

fresh
printf '%s\n' "$fake_pw" > "$repo/supabase/.mcp-db-password"
run mcp https://app.example.test https://mcp.example.test
env_file=$repo/supabase/.vercel-mcp.env
t "with the password file, mcp's DATABASE_URL carries the password percent-encoded" \
  grep -qF ':fake%2Fpw%3Awith%40odd%2Bchars@' "$env_file"
t "the env file is mode 600" mode_is "$env_file" 600
t "only names are printed, never the password" test "$(grep -cF "$fake_pw" <<< "$out" || true)" = 0
t "the names printed include DATABASE_URL" grep -qx '  DATABASE_URL' <<< "$out"

if [ $fails = 0 ]; then
  echo "vercel-env.test: all passed"
else
  echo "vercel-env.test: $fails failed"
  exit 1
fi
