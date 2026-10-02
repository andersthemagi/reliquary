#!/usr/bin/env bash
# Feedback and bug reports, for the operator (docs/ops/runbook.md,
# "Feedback"; supabase/migrations/20260926163000_feedback.sql). People send
# it from the web app's Feedback button and their agents with send_feedback;
# the sender sees the status and reply set here.
#
#   scripts/feedback.sh list [<status>|all]      newest first, one line each (default: new)
#   scripts/feedback.sh show <id>                one in full: who, how, vault, page, message, reply
#   scripts/feedback.sh status <id> <status>     new, seen, planned, fixed or wont_fix
#   scripts/feedback.sh reply <id> <text>        the reply the sender sees ("" clears it)
#
# Runs psql as postgres against the hosted database, with
# supabase/.db-password read inside the container (never printed), like
# scripts/plan.sh. It prints feedback text and senders' emails, which are
# for the operator only: don't paste them anywhere public. To use it on a
# local or self-hosted Postgres instead, set PLAN_DB_CONTAINER to that
# container's name (and PLAN_DB_NAME if the database isn't postgres).
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/supabase-env.sh
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
source scripts/lib/psql-helpers.sh

usage() { sed -n '7,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

STATUS='^(new|seen|planned|fixed|wont_fix)$'

cmd=${1:-}
case "$cmd" in
  list)
    [ $# -le 2 ] || usage
    which=${2:-new}
    [[ $which == all || $which =~ $STATUS ]] || { echo "That isn't a status: $which (new, seen, planned, fixed, wont_fix or all)" >&2; exit 2; }
    run -v status="$which" <<'SQL'
select id, sent, kind, sender, via, status, notice, message from private.feedback_list(:'status', 200);
SQL
    ;;
  show)
    [ $# -eq 2 ] || usage
    need "a feedback id" "$2" "$UUID"
    run -v id="$2" -P format=unaligned -P fieldsep=': ' -P tuples_only=on <<'SQL'
select field, value from private.feedback_show(:'id'::uuid);
SQL
    ;;
  status)
    [ $# -eq 3 ] || usage
    need "a feedback id" "$2" "$UUID"
    need "a status (new, seen, planned, fixed or wont_fix)" "$3" "$STATUS"
    run -v id="$2" -v status="$3" <<'SQL'
select private.set_feedback_status(:'id'::uuid, :'status') as done;
SQL
    ;;
  reply)
    [ $# -eq 3 ] || usage
    need "a feedback id" "$2" "$UUID"
    run -v id="$2" -v reply="$3" <<'SQL'
select private.set_feedback_reply(:'id'::uuid, :'reply') as done;
SQL
    ;;
  *) usage ;;
esac
