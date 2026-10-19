#!/usr/bin/env bash
# Prints the psql script that builds a test database: the Supabase stand-ins
# (stub.sql), every migration as supabase_postgres (the role stub.sql shapes
# like hosted Supabase's postgres, not a superuser, so a statement production
# would refuse fails here too), then the test support schema as the
# superuser again. Pipe it into psql:
#
#   supabase/tests/schema.sh | psql -U postgres -d <db>
#
# Each migration runs in a transaction of its own, as `supabase db push` runs
# it. A push also opens one connection for everything it has to apply, so
# what an earlier file loaded (an extension's library, and with it the
# settings it defines) is still loaded for the next file of the same push
# and gone for the next push. Which files share a push is history: a
# migration can only count on its own connection, so from the first one
# after v0.27.0's cut (FRESH_FROM) each runs on a connection of its own.
# Earlier files ran as they ran: 20261017120000 sets hnsw.iterative_scan
# first thing, which only passed because 20261017110000 had loaded pgvector
# on the same connection a moment before (v0.27.1's deploy failed on the
# same setting in a file that was pending alone).
set -euo pipefail
cd "$(dirname "$0")/.."
FRESH_FROM=20261019150000
cat tests/stub.sql
echo '\connect'
echo "set role supabase_postgres;"
for m in migrations/*.sql; do
  stamp=${m##*/}; stamp=${stamp%%_*}
  if [[ $stamp -ge $FRESH_FROM ]]; then
    echo '\connect'
    echo "set role supabase_postgres;"
  fi
  echo "begin;"
  cat "$m"
  echo "commit;"
done
echo '\connect'
cat tests/support.sql
