#!/usr/bin/env bash
# Run Reliquary's MCP endpoint locally, with a persistent Postgres, so you can
# connect your own agents before hosting and OAuth exist.
#
#   ./dev.sh up              start Postgres, the MCP server and the web UI
#   ./dev.sh ui              open the web UI, signed in (link never printed)
#   ./dev.sh vault "<name>"   create a vault owned by you
#   ./dev.sh token "<name>"   mint a token into mcp/.tokens/ (never printed)
#   ./dev.sh claude "<name>"  mint a token and add it to Claude Code (CLI)
#   ./dev.sh revoke "<name>"  revoke your live tokens with that name
#
# Tokens are never written to the terminal: anything printed there can end up
# in an agent's context (e.g. via Claude Code's ! commands), and secrets must
# never reach a model.
#   ./dev.sh down            stop (data kept in the reliquary-devdata volume)
#
# Secrets live in mcp/.env.dev (gitignored, mode 600).
set -euo pipefail
cd "$(dirname "$0")"

engine=$(command -v podman || command -v docker)
pg=reliquary-dev-pg
srv=reliquary-dev-mcp
web=reliquary-dev-web
webport=8790
pgport=54331
port=8787
node=docker.io/library/node:22-slim
envfile=.env.dev

rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(24))'; }
# 32 random bytes, base64url, no padding: secrets.ts's key shape.
randkey() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))'; }
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

if [[ ! -f $envfile ]]; then
  umask 077
  {
    echo "PG_PASSWORD=$(rand)"
    echo "MCP_DB_PASSWORD=$(rand)"
    echo "ME=$(python3 -c 'import uuid; print(uuid.uuid4())')"
  } > $envfile
fi
grep -q '^WEB_DB_PASSWORD=' $envfile || echo "WEB_DB_PASSWORD=$(rand)" >> $envfile
# Environment variable and link credential encryption (secrets.ts): only the
# web container ever holds this. LINK_PROXY_SECRET authenticates mcp/'s own
# calls to the web app's internal link-call endpoint (linkproxy.ts); both
# containers hold it.
grep -q '^VARIABLES_KEY=' $envfile || echo "VARIABLES_KEY=$(randkey)" >> $envfile
grep -q '^LINK_PROXY_SECRET=' $envfile || echo "LINK_PROXY_SECRET=$(rand)" >> $envfile
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
      -e LINK_PROXY_SECRET="$LINK_PROXY_SECRET" \
      -e PORT=$port $node node dist/server.js >/dev/null
    until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
    echo "alter role reliquary_web login password :'pw';" | psql -v pw="$WEB_DB_PASSWORD"
    "$engine" run --rm --network none -v "$PWD/../web":/app:Z -w /app $node npx tsc
    "$engine" rm -f $web >/dev/null 2>&1 || true
    "$engine" run -d --name $web --network host --restart unless-stopped -v "$PWD/../web":/app:Z -w /app \
      -e DATABASE_URL="postgres://reliquary_web:$WEB_DB_PASSWORD@127.0.0.1:$pgport/postgres" \
      -e VARIABLES_KEY="$VARIABLES_KEY" -e LINK_PROXY_SECRET="$LINK_PROXY_SECRET" \
      -e LOCAL_USER_ID="$ME" -e LOGIN_FILE=/app/.login -e PORT=$webport $node node dist/server.js >/dev/null
    until curl -sf "http://127.0.0.1:$webport/healthz" >/dev/null; do sleep 0.3; done
    echo "MCP endpoint: http://127.0.0.1:$port/mcp"
    echo "Web UI:       http://127.0.0.1:$webport  (sign in with ./mcp/dev.sh ui)"
    ;;
  vault)
    id=$(as_me "select public.create_vault(:'name', 'open');" -v name="${2:?vault name}")
    echo "vault ${2} created: $id"
    ;;
  token)
    name=${2:?token name, e.g. Hermes on Linux}
    mkdir -p .tokens && chmod 700 .tokens
    file=".tokens/$(echo "$name" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-*$//').token"
    ( umask 077
      as_me "select public.create_access_token(:'name', 90);" -v name="$name" > "$file" )
    copied=""
    if command -v wl-copy >/dev/null; then tr -d '\n' < "$file" | wl-copy && copied=" and copied to the clipboard"
    elif command -v xclip >/dev/null; then tr -d '\n' < "$file" | xclip -selection clipboard && copied=" and copied to the clipboard"
    fi
    echo "Token for '$name' saved to mcp/$file (mode 600, gitignored)$copied. Valid 90 days."
    echo "Use it as the header  Authorization: Bearer <token>  with MCP URL http://127.0.0.1:$port/mcp"
    ;;
  claude)
    name=${2:-Claude Code}
    command -v claude >/dev/null || { echo "The claude CLI isn't on PATH. Use ./dev.sh token instead."; exit 1; }
    token=$(as_me "select public.create_access_token(:'name', 90);" -v name="$name")
    claude mcp remove reliquary -s user >/dev/null 2>&1 || true
    claude mcp add --transport http -s user reliquary "http://127.0.0.1:$port/mcp" \
      --header "Authorization: Bearer $token" >/dev/null
    unset token
    echo "Claude Code (user scope) now reaches Reliquary as '$name'. The token was not shown."
    ;;
  revoke)
    n=$(as_me "select count(public.revoke_access_token(id)) from public.access_tokens where name = :'name' and revoked_at is null;" \
      -v name="${2:?token name}")
    echo "revoked $n token(s) named '$2'"
    ;;
  ui)
    curl -sf "http://127.0.0.1:$webport/healthz" >/dev/null || { echo "Web UI isn't running. Run ./mcp/dev.sh up first."; exit 1; }
    link_file="$PWD/../web/.login"
    if command -v xdg-open >/dev/null && xdg-open "$(cat "$link_file")" >/dev/null 2>&1; then
      echo "Opened the web UI in your browser (single-use sign-in link, not shown here)."
    else
      echo "Couldn't open a browser. Open the single-use link stored in web/.login yourself."
    fi
    ;;
  down) "$engine" stop $web $srv $pg >/dev/null 2>&1 || true; echo "stopped (data kept)" ;;
  logs) "$engine" logs -f $srv ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
