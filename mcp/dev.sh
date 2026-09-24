#!/usr/bin/env bash
# Run Reliquary's MCP endpoint locally, with a persistent Postgres, so you can
# connect your own agents before hosting and OAuth exist.
#
#   ./dev.sh up              start Postgres + server, apply new migrations
#   ./dev.sh token "<name>"  mint an access token for you (shown once)
#   ./dev.sh vault "<name>"  create a vault owned by you
#   ./dev.sh down            stop (data kept in the reliquary-devdata volume)
#
# Secrets live in mcp/.env.dev (gitignored, mode 600).
set -euo pipefail
cd "$(dirname "$0")"

engine=$(command -v podman || command -v docker)
pg=reliquary-dev-pg
srv=reliquary-dev-mcp
pgport=54331
port=8787
node=docker.io/library/node:22-slim
envfile=.env.dev

rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(24))'; }
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

if [[ ! -f $envfile ]]; then
  umask 077
  {
    echo "PG_PASSWORD=$(rand)"
    echo "MCP_DB_PASSWORD=$(rand)"
    echo "ME=$(python3 -c 'import uuid; print(uuid.uuid4())')"
  } > $envfile
fi
# shellcheck disable=SC1090
source $envfile

# Run SQL as you, in person (no agent claim), and print the result. Extra
# arguments are psql options, e.g. -v name=value, used in SQL as :'name'.
as_me() {
  local sql=$1; shift
  { echo "set role authenticated;"
    echo "select set_config('request.jwt.claims', :'claims', false) \\g /dev/null"
    echo "$sql"
  } | psql -At -v claims="{\"sub\":\"$ME\"}" "$@"
}

case "${1:-}" in
  up)
    if ! "$engine" container exists $pg 2>/dev/null; then
      "$engine" run -d --name $pg --network host -v reliquary-devdata:/var/lib/postgresql/data \
        -e POSTGRES_PASSWORD="$PG_PASSWORD" docker.io/library/postgres:17 \
        -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
    else
      "$engine" start $pg >/dev/null
    fi
    until "$engine" exec $pg pg_isready -U postgres -p $pgport -q 2>/dev/null; do sleep 0.5; done
    sleep 1
    psql -c "create table if not exists public.dev_applied_migrations (name text primary key)" \
         -c "revoke all on public.dev_applied_migrations from anon, authenticated" 2>/dev/null || true
    if [[ $(psql -At -c "select count(*) from pg_roles where rolname = 'authenticated'") == 0 ]]; then
      psql < ../supabase/tests/stub.sql
      psql -c "revoke all on public.dev_applied_migrations from anon, authenticated"
    fi
    for m in ../supabase/migrations/*.sql; do
      n=$(basename "$m")
      if [[ $(psql -At -c "select count(*) from public.dev_applied_migrations where name = '$n'") == 0 ]]; then
        { cat "$m"; echo "insert into public.dev_applied_migrations values ('$n');"; } | psql
        echo "applied $n"
      fi
    done
    echo "alter role reliquary_mcp login password :'pw';" | psql -v pw="$MCP_DB_PASSWORD"
    "$engine" run --rm --network none -v "$PWD":/app:Z -w /app $node npx tsc
    "$engine" rm -f $srv >/dev/null 2>&1 || true
    "$engine" run -d --name $srv --network host --restart unless-stopped -v "$PWD":/app:Z -w /app \
      -e DATABASE_URL="postgres://reliquary_mcp:$MCP_DB_PASSWORD@127.0.0.1:$pgport/postgres" \
      -e PORT=$port $node node dist/server.js >/dev/null
    until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
    echo "MCP endpoint: http://127.0.0.1:$port/mcp"
    ;;
  vault)
    id=$(as_me "select public.create_vault(:'name', 'open');" -v name="${2:?vault name}")
    echo "vault ${2} created: $id"
    ;;
  token)
    token=$(as_me "select public.create_access_token(:'name', 90);" -v name="${2:?token name, e.g. Claude Code on Linux}")
    echo "Token for '${2}' (shown once, valid 90 days):"
    echo "  $token"
    echo
    echo "Claude Code:"
    echo "  claude mcp add --transport http reliquary http://127.0.0.1:$port/mcp --header \"Authorization: Bearer $token\""
    ;;
  down) "$engine" stop $srv $pg >/dev/null 2>&1 || true; echo "stopped (data kept)" ;;
  logs) "$engine" logs -f $srv ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
