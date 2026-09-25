#!/usr/bin/env bash
# Plans and limits, by hand: there are no payments yet, so the operator puts
# people on plans and vaults on tiers (docs/ops/runbook.md, "Plans and
# testers"; supabase/migrations/20260925230000_plans.sql).
#
#   scripts/plan.sh plans                         the plans and vault tiers, with their limits
#   scripts/plan.sh show <email>                  a person's plan, and the vaults they own
#   scripts/plan.sh user <email> <plan>           put a person on a plan (free, alpha_tester)
#   scripts/plan.sh vault <vault-id> <tier>       give a vault a tier (pro), or standard to undo
#   scripts/plan.sh usage [<email>|<vault-id>]    people and storage per vault, largest first
#   scripts/plan.sh admit <email>                 let an account create vaults while invite-only
#   scripts/plan.sh revoke-admission <email>      take that back (they keep their vaults)
#   scripts/plan.sh invite-only on|off            whether accounts need admitting (on in the alpha)
#
# Nothing is deleted when a plan or tier is smaller: a vault over a limit
# takes nothing new until it is under. Admission is
# supabase/migrations/20260925240000_admission.sql.
#
# Runs psql as postgres against the hosted database, with
# supabase/.db-password read inside the container (never printed). Prints
# plans, emails, vault names and counts only: never a file's text, a token
# or a variable. To try it on a local Postgres with the migrations applied
# instead, set PLAN_DB_CONTAINER to that container's name (and
# PLAN_DB_NAME if the database isn't postgres).
set -euo pipefail
cd "$(dirname "$0")/.."

ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
host=${SUPABASE_POOLER_HOST:-aws-0-eu-central-1.pooler.supabase.com}
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}

usage() { sed -n '6,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
NAME='^[a-z][a-z0-9_]{0,31}$'
EMAIL='^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
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

# One row per vault: :'kind' is all, email or vault; :'arg' the email or id.
USAGE_SQL="
select v.id as vault, v.name, private.email_of(v.created_by) as account,
       case when l.tier_id = 'standard' then 'Standard (' || l.plan_name || ')' else l.tier_name end as tier,
       m.n || ' of ' || l.max_members as people,
       i.n as invites,
       private.size_text(coalesce(s.bytes, 0)) || ' of ' || private.size_text(l.max_bytes) as storage,
       case when m.n > l.max_members or coalesce(s.bytes, 0) > l.max_bytes then 'over' else '' end as \"limit\"
  from public.vaults v
  cross join private.vault_limits(v.id) l
  left join private.vault_storage s on s.vault_id = v.id
  cross join lateral (select count(*) as n from public.vault_members x where x.vault_id = v.id) m
  cross join lateral (select count(*) as n from private.vault_invites x
                       where x.vault_id = v.id
                         and private.invite_state(x.accepted_at, x.revoked_at, x.expires_at) = 'pending') i
 where :'kind' = 'all'
    or (:'kind' = 'vault' and v.id::text = :'arg')
    or (:'kind' = 'email' and v.created_by = (select private.user_by_email(:'arg') where :'kind' = 'email'))
 order by coalesce(s.bytes, 0) desc, v.name
 limit 200;"

cmd=${1:-}
case "$cmd" in
  plans)
    [ $# -eq 1 ] || usage
    run <<'SQL'
select id as plan, name, max_vaults as vaults, max_members as "people per vault",
       private.size_text(max_storage_bytes) as "storage per vault"
  from private.plans order by max_vaults, id;
select id as tier, name,
       coalesce(max_members::text, 'from the plan') as "people per vault",
       case when max_storage_bytes is null then 'from the plan' else private.size_text(max_storage_bytes) end as "storage per vault"
  from private.vault_tiers order by (id <> 'standard'), id;
SQL
    ;;
  show)
    [ $# -eq 2 ] || usage
    need "an email address" "$2" "$EMAIL"
    { cat <<'SQL'
select p.name as plan, o.n || ' of ' || p.max_vaults as "vaults owned",
       coalesce(to_char(a.set_at, 'YYYY-MM-DD HH24:MI "UTC"'), 'never (the default)') as "plan set",
       coalesce(a.set_by, '') as "set by"
  from (select private.user_by_email(:'arg') as id) u
  cross join private.plan_of(u.id) p
  cross join lateral (select count(*) as n from public.vaults v where v.created_by = u.id) o
  left join private.account_plans a on a.user_id = u.id;
select case when not private.invite_only() then 'yes (invite-only is off)'
            when d.user_id is null then 'no: they can''t create a vault until they accept an invite or are admitted'
            else 'yes (' || d.via || ', ' || to_char(d.admitted_at, 'YYYY-MM-DD') || ')' end as admitted
  from (select private.user_by_email(:'arg') as id) u
  left join private.admissions d on d.user_id = u.id;
SQL
      echo "$USAGE_SQL"; } | run -v kind=email -v arg="$2"
    ;;
  user)
    [ $# -eq 3 ] || usage
    need "an email address" "$2" "$EMAIL"
    need "a plan id" "$3" "$NAME"
    run -v arg="$2" -v plan="$3" <<'SQL'
select private.set_account_plan(private.user_by_email(:'arg'), :'plan') as done;
SQL
    ;;
  vault)
    [ $# -eq 3 ] || usage
    need "a vault id" "$2" "$UUID"
    need "a tier id" "$3" "$NAME"
    run -v arg="$2" -v tier="$3" <<'SQL'
select private.set_vault_tier(:'arg'::uuid, :'tier') as done;
SQL
    ;;
  usage)
    [ $# -le 2 ] || usage
    if [ $# -eq 1 ]; then
      echo "$USAGE_SQL" | run -v kind=all -v arg=
    elif [[ $2 =~ $UUID ]]; then
      echo "$USAGE_SQL" | run -v kind=vault -v arg="$2"
    else
      need "an email address or a vault id" "$2" "$EMAIL"
      echo "$USAGE_SQL" | run -v kind=email -v arg="$2"
    fi
    ;;
  admit)
    [ $# -eq 2 ] || usage
    need "an email address" "$2" "$EMAIL"
    run -v arg="$2" <<'SQL'
select private.admit_account(private.user_by_email(:'arg')) as done;
SQL
    ;;
  revoke-admission)
    [ $# -eq 2 ] || usage
    need "an email address" "$2" "$EMAIL"
    run -v arg="$2" <<'SQL'
select private.revoke_admission(private.user_by_email(:'arg')) as done;
SQL
    ;;
  invite-only)
    [ $# -eq 2 ] && [[ $2 == on || $2 == off ]] || usage
    run -v on="$([ "$2" = on ] && echo true || echo false)" <<'SQL'
select private.set_invite_only(:'on'::boolean) as done;
SQL
    ;;
  *) usage ;;
esac
