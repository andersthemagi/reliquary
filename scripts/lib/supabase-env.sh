# Shared default Supabase project ref and pooler host, for scripts that talk
# to the hosted database directly: db-push.sh, backup.sh,
# set-role-passwords.sh, feedback.sh, plan.sh, netlify-env.sh. Sourced, not
# run. Override with SUPABASE_PROJECT_REF / SUPABASE_POOLER_HOST to point at
# a different project.
# shellcheck disable=SC2034 # read by the scripts that source this
ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
host=${SUPABASE_POOLER_HOST:-aws-0-eu-central-1.pooler.supabase.com}
