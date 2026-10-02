#!/usr/bin/env bash
# One-shot, before Supabase Auth starts (the compose file's `db-init`): the
# roles, schemas and extensions Supabase would provide (deploy/sql/00_roles.sql),
# and the password Auth logs in with. Safe to run on every start. Unlike
# migrate.sh, never run standalone: compose.yml's `depends_on: db: condition:
# service_healthy` (db's own pg_isready healthcheck) is what gates this, so
# it doesn't poll for readiness itself.
#
# Runs in the postgres:17 image. Environment:
#   PGHOST, PGPORT, PGDATABASE   the database (default db:5432/postgres)
#   PGPASSWORD                   the postgres superuser's password
#   AUTH_DB_PASSWORD             supabase_auth_admin's password
#   DEPLOY_DIR                   where deploy/ is mounted (default /deploy)
# Never prints a password.
set -euo pipefail

export PGHOST=${PGHOST:-db} PGPORT=${PGPORT:-5432} PGDATABASE=${PGDATABASE:-postgres} PGUSER=${PGUSER:-postgres}
dir=${DEPLOY_DIR:-/deploy}
: "${AUTH_DB_PASSWORD:?AUTH_DB_PASSWORD is not set (deploy/setup.sh writes it to .env)}"

psql -X -q -v ON_ERROR_STOP=1 -f "$dir/sql/00_roles.sql"
# psql reads the password from its environment (\getenv), so it is never on
# a command line, where `ps` would show it.
psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv pw AUTH_DB_PASSWORD
alter role supabase_auth_admin login password :'pw';
SQL
echo "db-init: roles, schemas and extensions ready"
