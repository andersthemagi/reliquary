#!/usr/bin/env bash
# Writes the environment variables for one Vercel project, built from the
# gitignored secret files, to supabase/.vercel-<app>.env (mode 600,
# gitignored) as KEY=VALUE lines you can paste into Vercel (Project Settings
# -> Environment Variables accepts a pasted .env block). It prints only the
# file's path and the variable names, never a value, so it is safe to run
# from anywhere, including a chat with a model.
#
#   scripts/vercel-env.sh web https://<web-host> https://<mcp-host>
#   scripts/vercel-env.sh mcp https://<web-host> https://<mcp-host>
#
# The web app also needs SUPABASE_PUBLISHABLE_KEY, from the Supabase dashboard
# (Project Settings -> API Keys); it is printed as a placeholder.
#
# The variables encryption keys (VARIABLES_KEYS, docs/variables.md "Key
# rotation") come from supabase/.variables-keys-secret, one id:key per line,
# the current key first (scripts/variables-keys.sh). To rotate
# (docs/ops/runbook.md, "Rotating VARIABLES_KEY"):
#
#   scripts/vercel-env.sh new-variables-key       a new current key; then `web`
#   scripts/vercel-env.sh drop-variables-key <id> after re-encrypting; then `web`
#   scripts/vercel-env.sh variables-keys          the key ids, current first
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

next="Next: scripts/vercel-env.sh web <web-origin> <mcp-origin>, then put VARIABLES_KEYS in the web Vercel project and redeploy (docs/ops/runbook.md)."
case ${1:-} in
  new-variables-key)
    scripts/variables-keys.sh new
    echo "$next Then run scripts/rotate-variables-key.sh."
    exit 0
    ;;
  drop-variables-key)
    scripts/variables-keys.sh drop "${2:?which key id to drop}"
    echo "$next"
    exit 0
    ;;
  variables-keys)
    scripts/variables-keys.sh list
    exit 0
    ;;
esac

app=${1:?web or mcp}
web=${2:?the web app origin, e.g. https://reliquary-web.vercel.app}
mcp=${3:?the mcp app origin, e.g. https://reliquary-mcp.vercel.app}
ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
host=${SUPABASE_POOLER_HOST:-aws-0-eu-central-1.pooler.supabase.com}
web=${web%/}; mcp=${mcp%/}

pw() { tr -d '[:space:]' < "supabase/.$1-db-password"; }
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))'; }

out=supabase/.vercel-$app.env
case $app in
  web)
    secret=supabase/.web-session-secret
    if [[ ! -s $secret ]]; then
      (umask 077; head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$secret")
    fi
    # The variables encryption keys (docs/variables.md, "Key rotation"), the
    # current one first. Made once (an older supabase/.variables-secret is
    # taken over as k1) into a gitignored file; keep a copy of each in a
    # password manager too: Vercel can't show a Sensitive value again, and
    # losing a key loses every value sealed with it.
    scripts/variables-keys.sh ensure
    cat > "$out" <<EOF
VARIABLES_KEYS=$(paste -sd, supabase/.variables-keys-secret)
DATABASE_URL=postgres://reliquary_web.$ref:$(pw web | enc)@$host:6543/postgres
DATABASE_CA_FILE=supabase-ca.crt
PUBLIC_URL=$web
MCP_PUBLIC_URL=$mcp/mcp
MCP_RESOURCE=$mcp/mcp
AUTH_MODE=supabase
SUPABASE_URL=https://$ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=<from Supabase: Project Settings -> API Keys>
JWT_ALG=ES256
SESSION_SECRET=$(cat "$secret")
EOF
    ;;
  mcp)
    cat > "$out" <<EOF
DATABASE_URL=postgres://reliquary_mcp.$ref:$(pw mcp | enc)@$host:6543/postgres
DATABASE_CA_FILE=supabase-ca.crt
MCP_RESOURCE=$mcp/mcp
AUTH_ISSUER=$web
EOF
    ;;
  *) echo "web or mcp"; exit 1 ;;
esac
chmod 600 "$out"
echo "Wrote $out (mode 600, gitignored). Names only:"
cut -d= -f1 "$out" | sed "s/^/  /"
