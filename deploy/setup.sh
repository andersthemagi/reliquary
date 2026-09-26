#!/usr/bin/env bash
# Prepares a self-hosted Reliquary's settings (docs/public/how-to/self-host.md):
# writes deploy/compose/.env (or the file you name), mode 600, from
# .env.example, and generates every secret that is still empty. Run it again
# at any time: it never replaces a secret that is already there (a new
# database password or variables key would lock you out of your own data).
#
#   deploy/setup.sh                   deploy/compose/.env
#   deploy/setup.sh path/to/file.env  another file (tests use this)
#
# Settings can be given in the environment instead of editing the file
# afterwards, e.g.
#
#   PUBLIC_URL=https://app.example.com MCP_RESOURCE=https://mcp.example.com/mcp \
#     SMTP_HOST=smtp.example.com SMTP_SENDER=reliquary@example.com deploy/setup.sh
#
# Any of: PUBLIC_URL MCP_RESOURCE SITE_URL SMTP_HOST SMTP_PORT SMTP_USER
# SMTP_PASS SMTP_SENDER SMTP_SENDER_NAME RESEND_API_KEY EMAIL_FROM APP_HOST MCP_HOST SITE_HOST
# ACME_EMAIL TRUST_PROXY_IP WEB_BIND MCP_BIND. APP_HOST, MCP_HOST and
# SITE_HOST default to the hostnames in the URLs.
#
# Needs podman or docker (the secrets are made in a node container with no
# network). Prints setting names only, never a value.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
file=${1:-$here/compose/.env}
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}
[ -n "$engine" ] || { echo "setup: needs podman or docker to generate the secrets; install one and run this again" >&2; exit 1; }
node_image=${NODE_IMAGE:-docker.io/library/node:22-slim}
umask 077

settings=(PUBLIC_URL MCP_RESOURCE SITE_URL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_SENDER SMTP_SENDER_NAME
  RESEND_API_KEY EMAIL_FROM APP_HOST MCP_HOST SITE_HOST ACME_EMAIL TRUST_PROXY_IP WEB_BIND MCP_BIND)
secrets=(POSTGRES_PASSWORD AUTH_DB_PASSWORD WEB_DB_PASSWORD MCP_DB_PASSWORD GOTRUE_JWT_SECRET GOTRUE_JWT_KEYS SESSION_SECRET VARIABLES_KEYS)

if [ ! -e "$file" ]; then
  cp "$here/compose/.env.example" "$file"
  echo "setup: made $file from .env.example"
fi
chmod 600 "$file"

# The value of NAME in the file, unquoted ('' if absent or empty).
get() {
  local line
  line=$(grep -E "^$1=" "$file" | tail -n 1 || true)
  line=${line#*=}
  line=${line#\'}; line=${line%\'}
  printf '%s' "$line"
}
# Sets NAME to the value in the environment variable VALUE, single-quoted so
# compose takes it literally ($ and # included). The value goes through the
# environment, never a command line, so it never shows in `ps`.
put() {
  local tmp
  case $VALUE in *"'"*|*$'\n'*) echo "setup: $1 can't contain a single quote or a line break" >&2; exit 1 ;; esac
  tmp=$(mktemp "$file.XXXXXX")
  NAME=$1 VALUE=$VALUE awk 'BEGIN { n = ENVIRON["NAME"]; v = ENVIRON["VALUE"]; done = 0 }
    index($0, n "=") == 1 { if (!done) print n "=\047" v "\047"; done = 1; next }
    { print }
    END { if (!done) print n "=\047" v "\047" }' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}
host_of() { sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$1"; }

given=()
for name in "${settings[@]}"; do
  if [ -n "${!name+set}" ]; then VALUE=${!name} put "$name"; given+=("$name"); fi
done
[ -n "$(get APP_HOST)" ] || [ -z "$(get PUBLIC_URL)" ] || VALUE=$(host_of "$(get PUBLIC_URL)") put APP_HOST
[ -n "$(get MCP_HOST)" ] || [ -z "$(get MCP_RESOURCE)" ] || VALUE=$(host_of "$(get MCP_RESOURCE)") put MCP_HOST
[ -n "$(get SITE_HOST)" ] || [ -z "$(get SITE_URL)" ] || VALUE=$(host_of "$(get SITE_URL)") put SITE_HOST

missing=()
for name in "${secrets[@]}"; do [ -n "$(get "$name")" ] || missing+=("$name"); done
if [ ${#missing[@]} -gt 0 ]; then
  fresh=$("$engine" run --rm -i --network none "$node_image" node - <"$here/bin/secrets.mjs") ||
    { echo "setup: couldn't generate secrets in $node_image with $engine" >&2; exit 1; }
  for name in "${missing[@]}"; do
    VALUE=$(grep -E "^$name=" <<<"$fresh" | head -n 1 | cut -d= -f2-)
    [ -n "$VALUE" ] || { echo "setup: the secrets generator gave no $name" >&2; exit 1; }
    put "$name"
  done
  unset fresh VALUE
fi

echo "setup: $file is ready (mode 600)"
[ ${#given[@]} -eq 0 ] || echo "  set from the environment: ${given[*]}"
[ ${#missing[@]} -eq 0 ] && echo "  every secret was already there; none replaced" || echo "  generated: ${missing[*]}"
todo=()
for name in PUBLIC_URL MCP_RESOURCE SMTP_HOST SMTP_SENDER; do
  v=$(get "$name")
  if [ -z "$v" ] || [[ $v == *example.com* ]]; then todo+=("$name"); fi
done
if [ ${#todo[@]} -gt 0 ]; then
  echo "  still to set in $file: ${todo[*]}"
fi
echo "Keep a copy of $file somewhere safe (a password manager): without VARIABLES_KEYS no stored variable can be read."
