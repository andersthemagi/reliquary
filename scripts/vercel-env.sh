#!/usr/bin/env bash
# Prints the environment variables for the two Vercel projects, built from the
# gitignored secret files, as KEY=VALUE lines you can paste into Vercel
# (Project Settings -> Environment Variables accepts a pasted .env block).
# Run it yourself: it prints secrets to your terminal, so never run it where a
# model or a log can read the output.
#
#   scripts/vercel-env.sh web https://<web-host> https://<mcp-host>
#   scripts/vercel-env.sh mcp https://<web-host> https://<mcp-host>
#
# The web app also needs SUPABASE_PUBLISHABLE_KEY, from the Supabase dashboard
# (Project Settings -> API Keys); it is printed as a placeholder.
set -euo pipefail
cd "$(dirname "$0")/.."

app=${1:?web or mcp}
web=${2:?the web app origin, e.g. https://reliquary-web.vercel.app}
mcp=${3:?the mcp app origin, e.g. https://reliquary-mcp.vercel.app}
ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
host=${SUPABASE_POOLER_HOST:-aws-0-eu-central-1.pooler.supabase.com}
web=${web%/}; mcp=${mcp%/}

pw() { tr -d '[:space:]' < "supabase/.$1-db-password"; }
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))'; }

case $app in
  web)
    secret=supabase/.web-session-secret
    if [[ ! -s $secret ]]; then
      (umask 077; head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$secret")
    fi
    # The variables encryption key (docs/variables.md). Generated once into a
    # gitignored file; keep a copy in a password manager too: Vercel can't
    # show a Sensitive value again, and losing the key loses every value.
    vkey=supabase/.variables-secret
    if [[ ! -s $vkey ]]; then
      (umask 077; head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$vkey")
    fi
    cat <<EOF
VARIABLES_KEY=$(cat "$vkey")
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
    cat <<EOF
DATABASE_URL=postgres://reliquary_mcp.$ref:$(pw mcp | enc)@$host:6543/postgres
DATABASE_CA_FILE=supabase-ca.crt
MCP_RESOURCE=$mcp/mcp
AUTH_ISSUER=$web
EOF
    ;;
  *) echo "web or mcp"; exit 1 ;;
esac
