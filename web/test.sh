#!/usr/bin/env bash
# End-to-end test for the web UI: Postgres with every migration, the web
# server signed in as Ana, and node:test driving it over HTTP. Also: a hosted
# instance (PUBLIC_URL, no public/), and two AUTH_MODE=supabase instances
# sharing one SESSION_SECRET, signing in against a fake Supabase Auth
# (test/fake-auth.mjs). And a split instance: the app on PUBLIC_URL and the
# public site on SITE_URL, told apart by the Host header (src/hosts.ts).
# And a rate-limit instance (src/ratelimit.ts): AUTH_MODE=supabase with
# small limits, trusting x-real-ip so tests can come from many addresses.
# The other instances, and those test files start themselves, multiply
# every limit by 1000 (RATE_LIMIT_SCALE): they count as in production, but
# the suite never reaches a limit.
set -euo pipefail
cd "$(dirname "$0")"

# CONTAINER_ENGINE picks one explicitly (CI uses docker).
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-web-test-pg-$slot
srv=reliquary-web-test-server-$slot
# A second server as hosted: PUBLIC_URL=https://..., no public/ (the CDN's).
hosted=reliquary-web-test-hosted-$slot
hosted_url=https://app.reliquary.test
# Supabase sign-in: instances A and B, and the fake Auth they both trust.
auth_a=reliquary-web-test-auth-a-$slot
auth_b=reliquary-web-test-auth-b-$slot
fake=reliquary-web-test-fake-auth-$slot
# The split instance: AUTH_MODE=supabase against the same fake Auth.
split=reliquary-web-test-split-$slot
split_app_url=https://app.reliquary.test
split_site_url=https://reliquary.test
pgport=$((54332 + 10 * slot))
port=$((8791 + 10 * slot))
hosted_port=$((port + 1))
auth_a_port=$((port + 2))
auth_b_port=$((port + 3))
fake_port=$((port + 4))
# Off the 87xx range: every last digit there is taken by some suite and slot.
split_port=$((18791 + 10 * slot))
rl=reliquary-web-test-rl-$slot
rl_port=$((18792 + 10 * slot))
fake_url=http://127.0.0.1:$fake_port
fake_key=sb_publishable_fake_$slot
node=docker.io/library/node:22-slim

cleanup() {
  # -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
  "$engine" rm -f -v "$pg" "$srv" "$hosted" "$auth_a" "$auth_b" "$fake" "$split" "$rl" >/dev/null 2>&1 || true
  rm -f .login-test-$slot .login-test-hosted-$slot .auth-secrets-$slot
}
trap cleanup EXIT
cleanup
source ../scripts/lib/containers.sh

start_postgres "$pg" $pgport
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql >/dev/null
# Many test files, the same few people: room past Free's limits (plans are
# tested with plans of their own: web/test/plans.test.mjs).
echo "select test_support.roomy_free();" | psql >/dev/null
# A second database for test/variables_keys.test.mjs: key rotation moves
# every stored value and the server checks every stored key id, so it can't
# share a database with files that seal under keys of their own.
psql -c "create database keys"
cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql -d keys >/dev/null
# A third for the rate-limit instance (test/rate_limits.test.mjs): counters
# are shared by every instance on a database, and the other files sign in
# as the same people from the same address.
psql -c "create database ratelimits"
cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql -d ratelimits >/dev/null
echo "alter role reliquary_web login password 'test';" | psql
# The operator's role, for test/variables_keys.test.mjs's re-encryption.
echo "alter role reliquary_ops login password 'test';" | psql
seed=$(psql -A -t < test/seed.sql | grep '=')

# A fresh checkout (CI, a new worktree) has no node_modules yet.
[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
# npm run build: gen-docs.mjs writes docs-build/ (docs/public, the MCP
# contract, the CLI's help, CHANGELOG.md), tsc, then stamp-version.mjs writes
# dist/version.json from ../version.txt. The build reads outside web/, so the
# whole checkout is mounted, read-only but for web/.
"$engine" run --rm --network none -v "$PWD/..":/repo:ro,z -v "$PWD":/repo/web:z -w /repo/web "$node" npm run -s build
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/app/.login-test-$slot \
  -e RATE_LIMIT_SCALE=1000 -e PORT=$port "$node" node dist/server.js >/dev/null
wait_until "$srv" "the web server to answer /healthz" curl -sf "http://127.0.0.1:$port/healthz"
# The hosted instance runs a copy of dist/ in /app, so /app/public doesn't
# exist; node_modules is linked, not copied.
"$engine" run -d --name "$hosted" --network host -v "$PWD":/src:Z \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/src/.login-test-hosted-$slot \
  -e PUBLIC_URL="$hosted_url" -e RATE_LIMIT_SCALE=1000 -e PORT=$hosted_port "$node" sh -c \
  'mkdir -p /app && cp -r /src/dist /src/docs-build /src/package.json /app/ && ln -s /src/node_modules /app/node_modules && cd /app && exec node dist/server.js' >/dev/null
wait_until "$hosted" "the hosted web server to answer /healthz" curl -sf "http://127.0.0.1:$hosted_port/healthz"

"$engine" run -d --name "$fake" --network host -v "$PWD":/app:Z -w /app \
  -e FAKE_AUTH_PORT=$fake_port -e FAKE_AUTH_URL=$fake_url -e FAKE_AUTH_APIKEY=$fake_key \
  -e FAKE_AUTH_USERS=ana@example.test=00000000-0000-0000-0000-00000000000a,eve@example.test=00000000-0000-0000-0000-0000000000e1 \
  "$node" node test/fake-auth.mjs >/dev/null
wait_until "$fake" "the fake Supabase Auth to serve its keys" curl -sf -H "apikey: $fake_key" "$fake_url/auth/v1/.well-known/jwks.json"
# One secret for both instances (as on Vercel), fresh each run, never printed.
session_secret=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
for inst in "$auth_a:$auth_a_port" "$auth_b:$auth_b_port"; do
  "$engine" run -d --name "${inst%%:*}" --network host -v "$PWD":/app:Z -w /app \
    -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
    -e AUTH_MODE=supabase -e SUPABASE_URL=$fake_url -e SUPABASE_PUBLISHABLE_KEY=$fake_key -e JWT_ALG=ES256 \
    -e SESSION_SECRET="$session_secret" -e PUBLIC_URL="$hosted_url" -e RATE_LIMIT_SCALE=1000 -e PORT="${inst##*:}" "$node" node dist/server.js >/dev/null
done
wait_until "$auth_a" "supabase-mode server A to answer /healthz" curl -sf "http://127.0.0.1:$auth_a_port/healthz"
wait_until "$auth_b" "supabase-mode server B to answer /healthz" curl -sf "http://127.0.0.1:$auth_b_port/healthz"
"$engine" run -d --name "$split" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e AUTH_MODE=supabase -e SUPABASE_URL=$fake_url -e SUPABASE_PUBLISHABLE_KEY=$fake_key -e JWT_ALG=ES256 \
  -e SESSION_SECRET="$session_secret" -e PUBLIC_URL="$split_app_url" -e SITE_URL="$split_site_url" \
  -e RATE_LIMIT_SCALE=1000 -e PORT=$split_port "$node" node dist/server.js >/dev/null
# Asked as the app host: on the site host /healthz is a redirect.
wait_until "$split" "the split-host server to answer /healthz" curl -sf -H "Host: ${split_app_url#https://}" "http://127.0.0.1:$split_port/healthz"

# The rate-limit instance: small limits (test/rate_limits.test.mjs), the
# same fake Auth and session secret, client addresses from x-real-ip.
rl_limits="signin_email_address=2/3600,signin_email_ip=3/3600,signin_code_address=2/900,signin_code_ip=3/900"
rl_limits="$rl_limits,signin_refresh_session=2/3600,signin_refresh_ip=3/3600,oauth_authorize_ip=2/600,oauth_token_ip=2/600,oauth_token_client=3/600"
rl_limits="$rl_limits,oauth_revoke_ip=2/600,oauth_revoke_client=3/600,cimd_fetch_host=1/600,invite_ip=2/3600"
rl_limits="$rl_limits,env_grant_minute=2/60,web_write_minute=3/60"
"$engine" run -d --name "$rl" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/ratelimits" \
  -e AUTH_MODE=supabase -e SUPABASE_URL=$fake_url -e SUPABASE_PUBLISHABLE_KEY=$fake_key -e JWT_ALG=ES256 \
  -e SESSION_SECRET="$session_secret" -e PUBLIC_URL="$hosted_url" -e CIMD_ALLOW_LOOPBACK=1 \
  -e TRUST_PROXY_IP=1 -e RATE_LIMITS="$rl_limits" -e PORT=$rl_port "$node" node dist/server.js >/dev/null
wait_until "$rl" "the rate-limit server to answer /healthz" curl -sf "http://127.0.0.1:$rl_port/healthz"

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
"$engine" run --rm --network host -v "$PWD":/app:Z -v "$PWD/..":/repo:ro,z -e REPO_DIR=/repo -w /app "${env_args[@]}" \
  -e WEB_URL="http://127.0.0.1:$port" -e LOGIN_FILE=/app/.login-test-$slot \
  -e TEST_DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e WEB_HOSTED_URL="http://127.0.0.1:$hosted_port" -e WEB_HOSTED_PUBLIC_URL="$hosted_url" \
  -e HOSTED_LOGIN_FILE=/app/.login-test-hosted-$slot \
  -e WEB_AUTH_A_URL="http://127.0.0.1:$auth_a_port" -e WEB_AUTH_B_URL="http://127.0.0.1:$auth_b_port" \
  -e WEB_AUTH_PUBLIC_URL="$hosted_url" -e FAKE_AUTH_URL=$fake_url -e AUTH_SECRETS_FILE=/app/.auth-secrets-$slot \
  -e WEB_SPLIT_URL="http://127.0.0.1:$split_port" -e WEB_SPLIT_APP_URL="$split_app_url" -e WEB_SPLIT_SITE_URL="$split_site_url" \
  -e WEB_RL_URL="http://127.0.0.1:$rl_port" -e RATE_LIMIT_SCALE=1000 \
  -e EXPECT_VERSION="$(tr -d '[:space:]' < ../version.txt)" \
  "$node" node --test --test-concurrency=1 test/*.test.mjs

echo "== server log (must contain no tokens, codes or file text)"
{ "$engine" logs "$srv"; "$engine" logs "$hosted"; } 2>&1 | grep -E 'rl[qei]_|code=|EUR|script|SEKRIT' && { echo "LEAK in server log"; exit 1; } || echo "clean"
echo "== supabase-mode server logs (must contain no JWTs, refresh tokens, codes, token hashes or emails)"
# test/auth.test.mjs wrote every code, token hash and refresh token it saw
# to .auth-secrets-<slot>; none may appear in a log.
[ -s .auth-secrets-$slot ] || { echo "auth.test.mjs recorded no secrets to look for"; exit 1; }
{ "$engine" logs "$auth_a"; "$engine" logs "$auth_b"; "$engine" logs "$split"; "$engine" logs "$rl"; } > .auth-logs-$slot 2>&1
leak=0
grep -E 'eyJ|@|token_hash|rlq_|rli_|EUR|script' .auth-logs-$slot && leak=1
# The addresses test/rate_limits.test.mjs sends from (documentation ranges).
grep -E '203\.0\.113\.|198\.51\.100\.|2001:db8' .auth-logs-$slot && leak=1
grep -F -f .auth-secrets-$slot .auth-logs-$slot && leak=1
grep -qF "$session_secret" .auth-logs-$slot && { echo "(the session secret)"; leak=1; }
rm -f .auth-logs-$slot
[ $leak = 0 ] || { echo "LEAK in supabase-mode server log"; exit 1; }
echo "clean"
