#!/usr/bin/env bash
# Remove each guard from guard.sql in turn and run the adversary suite against the
# broken copy. Every mutant must fail a named assertion; one that passes means a
# guard nothing tests. About four minutes. Needs scratch-server.sh start first.
set -uo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
caught=0; total=0
for m in no-hoard-cap no-person-cap no-connection-check public-execute table-grant no-fast-path no-max-hold \
         no-ticket-cap no-fairness no-blocker-gate no-counter-decrement no-strikes no-cooldown no-strike-reset places-by-token; do
  python3 mutate_guard.py "$m" || { echo "$m: mutation did not apply"; continue; }
  dropdb $H --if-exists spike 2>/dev/null; createdb $H spike
  psql $H -d spike -X -q -v ON_ERROR_STOP=1 -f schema.sql -f plan.sql -f queue.sql -f guard_mutant.sql >/dev/null 2>&1
  out=$(psql $H -d spike -X -q -v ON_ERROR_STOP=1 -f guard_semantics.sql 2>&1 | grep -E 'ERROR|passed' | head -1 | sed 's/psql:guard_semantics.sql:[0-9]*: //')
  total=$((total + 1))
  case "$out" in *ERROR*) caught=$((caught + 1)); verdict="caught";; *) verdict="NOT CAUGHT";; esac
  printf '%-22s %-10s %s\n' "$m" "$verdict" "$out"
done
rm -f guard_mutant.sql
echo "caught $caught of $total"
