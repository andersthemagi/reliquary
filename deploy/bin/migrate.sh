#!/usr/bin/env bash
# One-shot, after Supabase Auth has created its tables (the compose file's
# `migrate`): applies Reliquary's migrations that this database hasn't had,
# then the self-hosting overlay (deploy/sql/10_self_hosted.sql), then gives
# the app roles their passwords. Upgrading is: pull, rebuild, run this.
#
# Each migration runs in one transaction with its bookkeeping row, in
# reliquary_deploy.migrations (name and sha256), so a failed one leaves
# nothing half-applied and runs again next time. Migrations are never edited
# after they ship (AGENTS.md): one whose file changed since it was applied is
# reported and stops the run.
#
# Runs in the postgres:17 image. Environment:
#   PGHOST, PGPORT, PGDATABASE, PGPASSWORD   as the postgres superuser
#   WEB_DB_PASSWORD, MCP_DB_PASSWORD        for reliquary_web, reliquary_mcp
#   MIGRATIONS_DIR   default /migrations (supabase/migrations, read-only)
#   DEPLOY_DIR       default /deploy
# Never prints a password.
set -euo pipefail

export PGHOST=${PGHOST:-db} PGPORT=${PGPORT:-5432} PGDATABASE=${PGDATABASE:-postgres} PGUSER=${PGUSER:-postgres}
migrations=${MIGRATIONS_DIR:-/migrations}
dir=${DEPLOY_DIR:-/deploy}
: "${WEB_DB_PASSWORD:?WEB_DB_PASSWORD is not set (deploy/setup.sh writes it to .env)}"
: "${MCP_DB_PASSWORD:?MCP_DB_PASSWORD is not set (deploy/setup.sh writes it to .env)}"

q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

# wait_for <tries> <check...>: runs <check> once a second until it passes, or
# gives up after <tries> seconds (the caller decides what that means).
wait_for() {
  local tries=$1
  shift
  for _ in $(seq "$tries"); do "$@" && return 0; sleep 1; done
  return 1
}

wait_for 120 pg_isready -q || true
# Supabase Auth creates auth.users when it starts; the migrations read it.
auth_ready() { [ "$(q -At -c "select to_regclass('auth.users') is not null")" = t ]; }
wait_for 120 auth_ready ||
  { echo "migrate: auth.users doesn't exist after 2 minutes: is Supabase Auth (the auth service) running?" >&2; exit 1; }

q <<'SQL'
set client_min_messages = warning;
create schema if not exists reliquary_deploy;
revoke all on schema reliquary_deploy from public;
create table if not exists reliquary_deploy.migrations (
  name       text primary key,
  sha256     text not null,
  applied_at timestamptz not null default now()
);
SQL

applied=0
for m in "$migrations"/*.sql; do
  name=$(basename "$m")
  sum=$(sha256sum "$m" | cut -d' ' -f1)
  have=$(q -At -v name="$name" <<<"select sha256 from reliquary_deploy.migrations where name = :'name'")
  if [ -n "$have" ]; then
    [ "$have" = "$sum" ] && continue
    echo "migrate: $name changed since it was applied here (migrations are never edited after they ship); stopping" >&2
    exit 1
  fi
  { cat "$m"
    echo
    echo "insert into reliquary_deploy.migrations (name, sha256) values (:'name', :'sum');"
  } | q -1 -v name="$name" -v sum="$sum" 2> >(grep -v '^psql:.*NOTICE' >&2)
  echo "migrate: applied $name"
  applied=$((applied + 1))
done
echo "migrate: $applied new migration(s)"

q -f "$dir/sql/10_self_hosted.sql"
echo "migrate: self-hosting overlay applied (plan self_hosted, no limits)"

# The app roles log in with their own passwords (never postgres's), read by
# psql from its environment (\getenv), never from a command line.
q <<'SQL'
\getenv web WEB_DB_PASSWORD
\getenv mcp MCP_DB_PASSWORD
alter role reliquary_web login password :'web';
alter role reliquary_mcp login password :'mcp';
SQL
echo "migrate: done"
