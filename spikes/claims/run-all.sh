#!/usr/bin/env bash
# Every edge-case and adversary suite, each on a fresh database, in the order the
# spikes were built. About two minutes. The stress and load scripts are separate
# (see the page that links this directory). Needs scratch-server.sh start first.
set -uo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
fresh() { dropdb $H --if-exists spike 2>/dev/null; createdb $H spike; }
load()  { for f in "$@"; do psql $H -d spike -X -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "FAILED to load $f"; return 1; }; done; }
run()   { # name, files to load, suite
  local name="$1" suite="$2"; shift 2
  fresh; load "$@" || return 1
  local out; out=$(psql $H -d spike -X -q -v ON_ERROR_STOP=1 -f "$suite" 2>&1 | grep -E 'ERROR|passed')
  printf '%-34s %s\n' "$name" "$(echo "$out" | head -1 | sed 's/psql:[^ ]* //')"
}
run "1 claims (11 checks)"            semantics.sql       schema.sql
run "2 dependencies (17 checks)"      plan_semantics.sql  schema.sql plan.sql
run "3 rules and waiting (26 checks)" queue_semantics.sql schema.sql plan.sql queue.sql
run "4 hostile agents (adversary)"    guard_semantics.sql schema.sql plan.sql queue.sql guard.sql
