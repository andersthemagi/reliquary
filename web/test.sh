#!/usr/bin/env bash
# End-to-end test for the web UI: Postgres with every migration, the web
# server signed in as Ana, and node:test driving it over HTTP. Also: a hosted
# instance (PUBLIC_URL, no public/), and two AUTH_MODE=supabase instances
# sharing one SESSION_SECRET, signing in against a fake Supabase Auth
# (test/fake-auth.mjs).
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
pgport=$((54332 + 10 * slot))
port=$((8791 + 10 * slot))
hosted_port=$((port + 1))
auth_a_port=$((port + 2))
auth_b_port=$((port + 3))
fake_port=$((port + 4))
fake_url=http://127.0.0.1:$fake_port
fake_key=sb_publishable_fake_$slot
node=docker.io/library/node:22-slim

cleanup() {
  "$engine" rm -f "$pg" "$srv" "$hosted" "$auth_a" "$auth_b" "$fake" >/dev/null 2>&1 || true
  rm -f .login-test-$slot .login-test-hosted-$slot .auth-secrets-$slot
}
trap cleanup EXIT
cleanup

"$engine" run -d --name "$pg" --network host -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
# Ask over TCP: the image's init-time server listens on the socket only, so a
# socket check can pass before the real server is up (a flaky race).
until "$engine" exec "$pg" pg_isready -h 127.0.0.1 -U postgres -p $pgport -q 2>/dev/null; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql >/dev/null
# A second database for test/variables_keys.test.mjs: key rotation moves
# every stored value and the server checks every stored key id, so it can't
# share a database with files that seal under keys of their own.
psql -c "create database keys"
cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql -d keys >/dev/null
echo "alter role reliquary_web login password 'test';" | psql
seed=$(psql -A -t < test/seed.sql | grep '=')

# A fresh checkout (CI, a new worktree) has no node_modules yet.
[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
"$engine" run --rm --network none -v "$PWD":/app:Z -w /app "$node" npx tsc
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/app/.login-test-$slot \
  -e PORT=$port "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
# The hosted instance runs a copy of dist/ in /app, so /app/public doesn't
# exist; node_modules is linked, not copied.
"$engine" run -d --name "$hosted" --network host -v "$PWD":/src:Z \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/src/.login-test-hosted-$slot \
  -e PUBLIC_URL="$hosted_url" -e PORT=$hosted_port "$node" sh -c \
  'mkdir -p /app && cp -r /src/dist /src/package.json /app/ && ln -s /src/node_modules /app/node_modules && cd /app && exec node dist/server.js' >/dev/null
until curl -sf "http://127.0.0.1:$hosted_port/healthz" >/dev/null; do
  [ "$("$engine" inspect -f '{{.State.Running}}' "$hosted")" = true ] || { "$engine" logs "$hosted"; echo "hosted server exited"; exit 1; }
  sleep 0.3
done

"$engine" run -d --name "$fake" --network host -v "$PWD":/app:Z -w /app \
  -e FAKE_AUTH_PORT=$fake_port -e FAKE_AUTH_URL=$fake_url -e FAKE_AUTH_APIKEY=$fake_key \
  -e FAKE_AUTH_USERS=ana@example.test=00000000-0000-0000-0000-00000000000a,eve@example.test=00000000-0000-0000-0000-0000000000e1 \
  "$node" node test/fake-auth.mjs >/dev/null
until curl -sf -H "apikey: $fake_key" "$fake_url/auth/v1/.well-known/jwks.json" >/dev/null; do sleep 0.3; done
# One secret for both instances (as on Vercel), fresh each run, never printed.
session_secret=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
for inst in "$auth_a:$auth_a_port" "$auth_b:$auth_b_port"; do
  "$engine" run -d --name "${inst%%:*}" --network host -v "$PWD":/app:Z -w /app \
    -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
    -e AUTH_MODE=supabase -e SUPABASE_URL=$fake_url -e SUPABASE_PUBLISHABLE_KEY=$fake_key -e JWT_ALG=ES256 \
    -e SESSION_SECRET="$session_secret" -e PUBLIC_URL="$hosted_url" -e PORT="${inst##*:}" "$node" node dist/server.js >/dev/null
done
for p in $auth_a_port $auth_b_port; do
  until curl -sf "http://127.0.0.1:$p/healthz" >/dev/null; do
    [ "$("$engine" inspect -f '{{.State.Running}}' "$auth_a")" = true ] && [ "$("$engine" inspect -f '{{.State.Running}}' "$auth_b")" = true ] \
      || { "$engine" logs "$auth_a"; "$engine" logs "$auth_b"; echo "supabase-mode server exited"; exit 1; }
    sleep 0.3
  done
done

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
"$engine" run --rm --network host -v "$PWD":/app:Z -w /app "${env_args[@]}" \
  -e WEB_URL="http://127.0.0.1:$port" -e LOGIN_FILE=/app/.login-test-$slot \
  -e TEST_DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e WEB_HOSTED_URL="http://127.0.0.1:$hosted_port" -e WEB_HOSTED_PUBLIC_URL="$hosted_url" \
  -e HOSTED_LOGIN_FILE=/app/.login-test-hosted-$slot \
  -e WEB_AUTH_A_URL="http://127.0.0.1:$auth_a_port" -e WEB_AUTH_B_URL="http://127.0.0.1:$auth_b_port" \
  -e WEB_AUTH_PUBLIC_URL="$hosted_url" -e FAKE_AUTH_URL=$fake_url -e AUTH_SECRETS_FILE=/app/.auth-secrets-$slot \
  "$node" node --test --test-concurrency=1 test/*.test.mjs

echo "== server log (must contain no tokens, codes or file text)"
{ "$engine" logs "$srv"; "$engine" logs "$hosted"; } 2>&1 | grep -E 'rl[qei]_|code=|EUR|script|SEKRIT' && { echo "LEAK in server log"; exit 1; } || echo "clean"
echo "== supabase-mode server logs (must contain no JWTs, refresh tokens, codes, token hashes or emails)"
# test/auth.test.mjs wrote every code, token hash and refresh token it saw
# to .auth-secrets-<slot>; none may appear in a log.
[ -s .auth-secrets-$slot ] || { echo "auth.test.mjs recorded no secrets to look for"; exit 1; }
{ "$engine" logs "$auth_a"; "$engine" logs "$auth_b"; } > .auth-logs-$slot 2>&1
leak=0
grep -E 'eyJ|@|token_hash|rlq_|rli_|EUR|script' .auth-logs-$slot && leak=1
grep -F -f .auth-secrets-$slot .auth-logs-$slot && leak=1
grep -qF "$session_secret" .auth-logs-$slot && { echo "(the session secret)"; leak=1; }
rm -f .auth-logs-$slot
[ $leak = 0 ] || { echo "LEAK in supabase-mode server log"; exit 1; }
echo "clean"
