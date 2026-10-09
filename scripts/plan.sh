#!/usr/bin/env bash
# Plans and limits, by hand: there are no payments yet, so the operator puts
# people on plans and vaults on tiers (docs/ops/runbook.md, "Plans and
# testers"; supabase/migrations/20260925230000_plans.sql).
#
#   scripts/plan.sh plans                         the plans and vault tiers, with their limits
#   scripts/plan.sh show <email>                  a person's plan, and the vaults they own
#   scripts/plan.sh user <email> <plan>           put a person on a plan (free, alpha_tester, staff)
#   scripts/plan.sh vault <vault-id> <tier>       give a vault a tier (pro), or standard to undo
#   scripts/plan.sh grant-storage <vault-id> <amount>
#                                                  give a vault <amount> (e.g. 500mb, 2gb) more storage
#                                                  than its tier or plan allows; 0 takes the grant back
#   scripts/plan.sh usage [<email>|<vault-id>]    people and storage per vault, largest first
#   scripts/plan.sh admit <email>                 let an account create vaults while invite-only
#   scripts/plan.sh revoke-admission <email>      take that back (they keep their vaults)
#   scripts/plan.sh invite-only on|off            whether accounts need admitting (on in the alpha)
#   scripts/plan.sh check                         storage counters that drifted, accounts gone from Auth
#   scripts/plan.sh recount <vault-id>            set a vault's storage counter to a full scan
#
# Nothing is deleted when a plan or tier is smaller: a vault over a limit
# takes nothing new until it is under. Admission and the checks are
# supabase/migrations/20260925240000_admission.sql and 20260925240400_storage_drift.sql.
#
# Runs psql as postgres against the hosted database, with
# supabase/.db-password read inside the container (never printed). Prints
# plans, emails, vault names and counts only: never a file's text, a token
# or a variable. To try it on a local Postgres with the migrations applied
# instead, set PLAN_DB_CONTAINER to that container's name (and
# PLAN_DB_NAME if the database isn't postgres).
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/supabase-env.sh
source scripts/lib/engine.sh
source scripts/lib/psql-helpers.sh

usage() { sed -n '6,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

NAME='^[a-z][a-z0-9_]{0,31}$'
EMAIL='^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'

# "500mb", "2gb", "0" or a plain byte count, decimal (1 MB = 1,000,000 bytes,
# matching private.size_text) -> a byte count, or exits naming the problem.
bytes_of() {
  local n unit
  [[ $1 =~ ^([0-9]+)(b|kb|mb|gb)?$ ]] || { echo "That isn't an amount of storage (500mb, 2gb, 0): $1" >&2; exit 2; }
  n=${BASH_REMATCH[1]}; unit=${BASH_REMATCH[2]:-b}
  case "$unit" in
    b) echo "$n" ;;
    kb) echo $((n * 1000)) ;;
    mb) echo $((n * 1000000)) ;;
    gb) echo $((n * 1000000000)) ;;
  esac
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
  grant-storage)
    [ $# -eq 3 ] || usage
    need "a vault id" "$2" "$UUID"
    run -v arg="$2" -v extra="$(bytes_of "$3")" <<'SQL'
select private.grant_vault_storage(:'arg'::uuid, :'extra'::bigint) as done;
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
  check)
    [ $# -eq 1 ] || usage
    run <<'SQL'
select vault_id as vault, vault_name as name, private.size_text(coalesce(counted, 0)) as counted,
       private.size_text(scanned) as scanned, drift as "drift (bytes)"
  from private.storage_drift();
select kind, vault_id as vault, vault_name as name, user_id as account, coalesce(role, '') as role
  from private.accounts_gone();
SQL
    ;;
  recount)
    [ $# -eq 2 ] || usage
    need "a vault id" "$2" "$UUID"
    run -v arg="$2" <<'SQL'
select private.recount_storage(:'arg'::uuid) as done;
SQL
    ;;
  *) usage ;;
esac
