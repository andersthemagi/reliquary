#!/usr/bin/env bash
# The product pictures on the landing page and in the README, taken from the
# local dev stack so they never drift from the UI: seeds a fictional vault
# (demo-seed.sql), runs a second web app as the demo account on port 8791,
# photographs it with Chromium over the DevTools protocol (demo-shots.mjs)
# and cuts the reel with ffmpeg. Writes web/public/img/.
#
#   scripts/demo-shots.sh        seed, start, shoot, cut, stop
#   scripts/demo-shots.sh up     seed and start the demo web app only
#   scripts/demo-shots.sh down   stop it
#
# Needs ./mcp/dev.sh up first (its Postgres and mcp/.env.dev), and chromium,
# node (20 or later) and ffmpeg on the host. The demo sign-in link goes
# straight from its file into Chromium and is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/engine.sh
pg=reliquary-dev-pg
web=reliquary-demo-web
port=8791
demo_user=a0000000-0000-4000-8000-000000000001
envfile=${ENV_FILE:-mcp/.env.dev}
node=docker.io/library/node:22-slim

up() {
  # Fresh every run: the reel approves the open proposal, so the vault is
  # deleted the sanctioned way (by its owner, in person, typed name) and
  # seeded again.
  printf '%s\n' "set role authenticated;" \
    "select set_config('request.jwt.claims', '{\"sub\":\"$demo_user\"}', false);" \
    "select public.delete_vault(id, name) from public.vaults where name = 'Northwind relaunch';" \
    | "$engine" exec -i $pg psql -U postgres -p 54331 -q -v ON_ERROR_STOP=1 -o /dev/null
  "$engine" exec -i $pg psql -U postgres -p 54331 -v ON_ERROR_STOP=1 -f - < scripts/demo-seed.sql
  set -a
  # shellcheck disable=SC1090
  source "$envfile"
  set +a
  # WEB_NODE_MODULES: a checkout without web/node_modules (a worktree) can
  # borrow another's.
  local mods=()
  [[ -n ${WEB_NODE_MODULES:-} ]] && mods=(-v "$WEB_NODE_MODULES":/app/node_modules:ro)
  "$engine" run --rm --network none -v "$PWD/web":/app:Z "${mods[@]}" -w /app $node npx tsc
  "$engine" rm -f $web >/dev/null 2>&1 || true
  "$engine" run -d --name $web --network host -v "$PWD/web":/app:Z "${mods[@]}" -w /app \
    -e DATABASE_URL="postgres://reliquary_web:$WEB_DB_PASSWORD@127.0.0.1:54331/postgres" \
    -e VARIABLES_KEY="$VARIABLES_KEY" -e LINK_PROXY_SECRET="$LINK_PROXY_SECRET" \
    -e MCP_PUBLIC_URL=https://mcp.reliquary.redmage.cc/mcp \
    -e LOCAL_USER_ID=$demo_user -e LOGIN_FILE=/app/.login-demo -e PORT=$port $node node dist/server.js >/dev/null
  until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
  echo "demo web app: http://127.0.0.1:$port"
}

down() { "$engine" rm -f $web >/dev/null 2>&1 || true; echo "stopped"; }

case "${1:-all}" in
  up) up ;;
  down) down ;;
  all)
    up
    LOGIN_URL=$(cat web/.login-demo) node scripts/demo-shots.mjs
    down
    ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
