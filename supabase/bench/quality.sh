#!/usr/bin/env bash
# Does search by meaning put the right file first more often than search by
# words (issue #405)? Loads a folder of files into a vault in a throwaway
# Postgres 17, embeds them with gte-small in the `embed` function (Supabase's
# edge runtime, run here), and asks each question through the MCP server's
# own search. Not a test: it prints numbers. docs/ops/runbook.md, "Search
# quality".
#
#   ./supabase/bench/quality.sh                          the made-up sample
#   ./supabase/bench/quality.sh questions.tsv vault-dir  your own
#   QUALITY_EMBED=stand-in ...   the test suites' stand-in, offline (checks
#                                the script; says nothing about the model)
#   QUALITY_EMBED=none ...       words only
#   EMBED_MIN_SIMILARITY=0.8 ... the floor to try (the server's default 0.78)
#   TEST_SLOT=40 ...             slot 36 by default
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
questions=$(realpath -m "${1:-$here/quality/questions.tsv}")
vault=$(realpath -m "${2:-$here/quality/vault}")
cd "$here"
[ -f "$questions" ] || { echo "quality: no questions file at $questions" >&2; exit 1; }
[ -d "$vault" ] || { echo "quality: no folder at $vault to load as the vault" >&2; exit 1; }

source ../../scripts/lib/engine.sh
source ../../scripts/lib/containers.sh
slot=${TEST_SLOT:-36}
pg=reliquary-quality-pg-$slot
emb=reliquary-quality-embed-$slot
pgport=$((54330 + 10 * slot))
embport=$((18791 + 10 * slot))
node=docker.io/library/node:22-slim
embed=${QUALITY_EMBED:-gte-small}

cleanup() { "$engine" rm -f -v "$pg" "$emb" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

start_postgres "$pg" "$pgport"
{ echo "set client_min_messages = warning;"; cat ../tests/stub.sql ../migrations/*.sql ../tests/support.sql; echo "select test_support.roomy_free();"; } |
  "$engine" exec -i "$pg" psql -U postgres -p "$pgport" -v ON_ERROR_STOP=1 -q >/dev/null

# Never printed: it only lets the runner call the function started here.
secret=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
label=""
case $embed in
  gte-small)
    # The runtime downloads the model on its first call, so this needs the network.
    "$engine" run -d --name "$emb" --network host -e EMBED_SECRET="$secret" -v "$here/../functions":/functions:ro,z \
      docker.io/supabase/edge-runtime:v1.77.4 start --main-service /functions/embed -p "$embport" >/dev/null
    label="gte-small (the embed function in Supabase's edge runtime, run here)" ;;
  stand-in)
    "$engine" run -d --name "$emb" --network host -v "$here/../../mcp/test":/t:ro,z -e EMBED_SECRET="$secret" \
      -e PORT="$embport" "$node" node /t/embed-double.mjs >/dev/null
    label="the test suites' stand-in (mcp/test/embed-double.mjs), NOT gte-small: these numbers check the script, not the model"
    # The stand-in's bags of words score lower than gte-small (mcp/test.sh).
    : "${EMBED_MIN_SIMILARITY:=0.5}" ;;
  none) ;;
  *) echo "quality: QUALITY_EMBED is gte-small, stand-in or none, not $embed" >&2; exit 1 ;;
esac
# A first call before the runner's: the model loads on it (and downloads,
# the first time), which can take longer than a search waits.
embed_env=()
if [ -n "$label" ]; then
  if (wait_until "$emb" "the embedding function to answer" curl -s -o /dev/null "http://127.0.0.1:$embport/") &&
     curl -sf -o /dev/null -m 300 -H "authorization: Bearer $secret" -H "content-type: application/json" \
       -d '{"input":["warm up"]}' "http://127.0.0.1:$embport/"; then
    embed_env=(-e EMBED_URL="http://127.0.0.1:$embport/" -e EMBED_SECRET="$secret")
  else
    echo "quality: the embedding function didn't answer (no network for the model download?), so meaning is not measured; words still are." >&2
    label=""
  fi
fi

# The runner imports the MCP server's search code, built as mcp/test.sh builds it.
mcp=$here/../../mcp
[ -x "$mcp/node_modules/.bin/tsc" ] || "$engine" run --rm --network host -v "$mcp":/app:Z -w /app "$node" npm ci --no-audit --no-fund --silent
"$engine" run --rm --network none -v "$mcp":/app:Z -w /app "$node" node_modules/.bin/tsc

"$engine" run --rm --network host -v "$mcp":/mcp:ro,z -v "$here/quality.mjs":/quality.mjs:ro,z \
  -v "$questions":/questions.tsv:ro,z -v "$vault":/vault:ro,z \
  -e DATABASE_URL="postgres://postgres:test@127.0.0.1:$pgport/postgres" \
  -e QUALITY_MEANING_LABEL="$label" -e EMBED_MIN_SIMILARITY="${EMBED_MIN_SIMILARITY:-}" \
  "${embed_env[@]}" \
  "$node" node /quality.mjs
