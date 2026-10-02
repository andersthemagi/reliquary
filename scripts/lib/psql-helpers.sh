# Shared by scripts/feedback.sh and scripts/plan.sh: the UUID-shaped-argument
# check and the psql-over-a-container wrapper both use. Sourced, not run,
# from the repo root (both scripts `cd "$(dirname "$0")/.."` first); needs
# $engine already set, and $ref/$host too unless PLAN_DB_CONTAINER is.
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
need() { [[ $2 =~ $3 ]] || { echo "That isn't $1: $2" >&2; exit 2; }; }

# psql with the SQL on stdin and the arguments as psql variables.
run() {
  if [ -n "${PLAN_DB_CONTAINER:-}" ]; then
    "$engine" exec -i "$PLAN_DB_CONTAINER" psql -U postgres -d "${PLAN_DB_NAME:-postgres}" \
      -X -q -v ON_ERROR_STOP=1 -P pager=off -P footer=off "$@"
  else
    [[ -s supabase/.db-password ]] || { echo "Missing supabase/.db-password." >&2; exit 1; }
    "$engine" run --rm -i --network host -v "$PWD/supabase":/s:ro,Z -e REF="$ref" -e HOST="$host" \
      docker.io/library/postgres:17 bash -c '
        export PGPASSWORD=$(tr -d "[:space:]" < /s/.db-password)
        exec psql "host=$HOST port=5432 dbname=postgres user=postgres.$REF sslmode=require" \
          -X -q -v ON_ERROR_STOP=1 -P pager=off -P footer=off "$@"' psql "$@"
  fi
}
