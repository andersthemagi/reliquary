#!/usr/bin/env bash
# Reliquary pilot: Postgres + the Telegram bot, in podman (or docker).
#
#   ./run.sh init          database, roles, image, bot token (once)
#   ./run.sh start         start (or restart) the bot after editing .env
#   ./run.sh admin ...     admin CLI, e.g. ./run.sh admin add-space team
#   ./run.sh logs | stop | status | smoke | test
#
# Secrets live in pilot/.env (bot) and pilot/.env.admin (database owner),
# both gitignored and mode 600. The bot never gets the owner password.
set -euo pipefail
cd "$(dirname "$0")"

source ../scripts/lib/engine.sh
pg=reliquary-pg
bot=reliquary-bot
image=reliquary-pilot
port=54329

rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(24))'; }
psql_owner() { "$engine" exec -i "$pg" psql -U postgres -p "$port" -v ON_ERROR_STOP=1 -q "$@"; }

start_pg() {
  if ! "$engine" container exists "$pg" 2>/dev/null; then
    # shellcheck disable=SC1091
    source .env.admin
    "$engine" run -d --name "$pg" --network host --restart unless-stopped \
      -v reliquary-pgdata:/var/lib/postgresql/data \
      -e POSTGRES_PASSWORD="$PG_OWNER_PASSWORD" -e POSTGRES_DB=reliquary \
      docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port="$port" >/dev/null
  else
    "$engine" start "$pg" >/dev/null
  fi
  until "$engine" exec "$pg" pg_isready -U postgres -p "$port" -q 2>/dev/null; do sleep 0.5; done
  sleep 1
}

apply_schema() {  # $1 = database
  if [[ $(psql_owner -d "$1" -tAc "select to_regclass('app.entries') is not null") == t ]]; then
    return
  fi
  psql_owner -d "$1" < schema.sql
}

admin() {
  "$engine" run --rm --network host --env-file .env.admin -e PGDATABASE="${PGDATABASE:-reliquary}" \
    "$image" python -m reliquary_pilot.admin "$@"
}

case "${1:-}" in
  init)
    umask 077
    if [[ ! -f .env.admin ]]; then
      echo "PG_OWNER_PASSWORD=$(rand)" > .env.admin
      {
        echo "TELEGRAM_BOT_TOKEN="
        echo "ANTHROPIC_API_KEY="
        echo "RELIQUARY_MODEL=claude-opus-5"
        echo "RELIQUARY_EFFORT=low"
        echo "PG_ADAPTER_PASSWORD=$(rand)"
        echo "PG_MINTER_PASSWORD=$(rand)"
        echo "PG_AGENT_PASSWORD=$(rand)"
      } > .env
    fi
    start_pg
    apply_schema reliquary
    # shellcheck disable=SC1091
    source .env
    for role in adapter minter agent; do
      var="PG_${role^^}_PASSWORD"
      echo "alter role reliquary_$role login password :'pw';" | psql_owner -d reliquary -v pw="${!var}"
    done
    "$engine" build --network host -q -t "$image" . >/dev/null
    if ! grep -q '^RELIQUARY_TOKEN_ID=' .env; then
      admin create-bot telegram-bot >> .env
    fi
    echo "Initialised. Next: put TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in pilot/.env, then ./run.sh start"
    ;;
  start)
    # shellcheck disable=SC1091
    source .env
    [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${ANTHROPIC_API_KEY:-}" ]] \
      || { echo "Set TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in pilot/.env first"; exit 1; }
    start_pg
    "$engine" build --network host -q -t "$image" . >/dev/null
    "$engine" rm -f "$bot" >/dev/null 2>&1 || true
    "$engine" run -d --name "$bot" --network host --restart unless-stopped --env-file .env "$image" >/dev/null
    echo "Bot started. ./run.sh logs to watch."
    ;;
  admin) shift; admin "$@" ;;
  logs) "$engine" logs -f "$bot" ;;
  stop) "$engine" stop "$bot" "$pg" >/dev/null 2>&1 || true; echo "stopped (data kept)" ;;
  status) "$engine" ps -a --filter name=reliquary --format '{{.Names}}  {{.Status}}' ;;
  smoke)
    start_pg
    psql_owner -d reliquary -c 'drop database if exists reliquary_smoke' -c 'create database reliquary_smoke'
    apply_schema reliquary_smoke
    "$engine" build --network host -q -t "$image" . >/dev/null
    "$engine" run --rm --network host --env-file .env --env-file .env.admin \
      -e PGDATABASE=reliquary_smoke "$image" python -m reliquary_pilot.smoke
    psql_owner -d reliquary -c 'drop database reliquary_smoke'
    ;;
  test) ./test.sh ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
