#!/usr/bin/env bash
# The `embed` Edge Function in Supabase's own edge runtime, with the real
# gte-small model: its contract and its sense of meaning (smoke.mjs). Not
# part of ./test.sh, which uses a stand-in with the same contract
# (mcp/test/embed-double.mjs): the runtime downloads the model on first use,
# so this needs the network. Run it after changing the function, and before
# deploying it (docs/ops/runbook.md, "Search by meaning").
#
#   ./supabase/functions/smoke.sh        (EDGE_PORT=19400 by default)
set -euo pipefail
cd "$(dirname "$0")"
source ../../scripts/lib/engine.sh
source ../../scripts/lib/containers.sh

name=reliquary-embed-smoke
port=${EDGE_PORT:-19400}
secret=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

"$engine" run -d --name "$name" --network host -e EMBED_SECRET="$secret" -v "$PWD":/functions:ro,z \
  docker.io/supabase/edge-runtime:v1.77.4 start --main-service /functions/embed -p "$port" >/dev/null
wait_until "$name" "the edge runtime to answer" curl -s -o /dev/null "http://127.0.0.1:$port/"
"$engine" run --rm --network host -v "$PWD":/smoke:ro,z -e EMBED_URL="http://127.0.0.1:$port/" -e EMBED_SECRET="$secret" \
  docker.io/library/node:22-slim node /smoke/smoke.mjs
