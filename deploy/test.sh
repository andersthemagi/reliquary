#!/usr/bin/env bash
# The self-hosting smoke test: the compose stack in deploy/compose, built from
# this checkout, exactly as docs/public/how-to/self-host.md runs it, then its
# first owner end to end (deploy/test/smoke.mjs):
#
#   1. deploy/setup.sh writes a throwaway settings file (secrets generated);
#   2. the web and MCP images are built, the stack started (Postgres,
#      Supabase Auth, the migrations, web, MCP) with a mail catcher;
#   3. the owner tool makes the first account through Auth's admin API;
#   4. the owner signs in with the emailed code, creates a vault and a
#      token; an agent writes a file over MCP with it and reads it back;
#   5. the migrations run again and apply nothing (an upgrade is a re-run);
#   6. everything is removed (containers, volumes, the settings file).
#
#   ./deploy/test.sh              TEST_SLOT picks the ports (30000 + 10 * slot)
#   KEEP=1 ./deploy/test.sh       leave the stack up afterwards, to look around
#
# Not part of ./test.sh (it builds two images and takes a few minutes); CI
# runs it as its own job. Needs podman or docker, and a compose: `docker
# compose`, `podman compose`, or failing both, the docker CLI's compose in a
# container talking to podman's API socket. Never prints a secret.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)

slot=${TEST_SLOT:-0}
project=reliquary-deploy-test-$slot
tag=test-$slot
base=$((30000 + 10 * slot))
# shellcheck disable=SC2034 # all written to the settings file by name, below
T_PG=$base T_AUTH=$((base + 1)) T_WEB=$((base + 2)) T_MCP=$((base + 3)) T_SMTP=$((base + 4)) T_MAILAPI=$((base + 5))
email=owner@example.com
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}
[ -n "$engine" ] || { echo "deploy test: needs podman or docker" >&2; exit 1; }
node_image=docker.io/library/node:22-slim
compose_image=docker.io/library/docker:28-cli

work=$(mktemp -d "${TMPDIR:-/tmp}/rlq-deploy-$slot-XXXXXX")
envfile=$work/test.env
svc_pid=""

# Rootless podman without pasta or slirp4netns can't give containers a
# network of their own; the stack then shares the host's (compose.hostnet.yml).
network=${DEPLOY_TEST_NETWORK:-}
if [ -z "$network" ]; then
  network=bridge
  if [[ $(basename "$engine") == podman ]] &&
     [ "$("$engine" info --format '{{.Host.Security.Rootless}}')" = true ] &&
     ! command -v pasta >/dev/null && ! command -v slirp4netns >/dev/null; then
    network=host
  fi
fi

# A compose, in order of preference.
if [[ $(basename "$engine") == docker ]] && docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif [[ $(basename "$engine") == podman ]] && podman compose version >/dev/null 2>&1; then
  compose_cmd=(podman compose)
else
  # The docker CLI's compose plugin, in a container, against podman's
  # Docker-compatible API on a socket of our own. The checkout is mounted
  # at its own path, so the paths compose sends the engine are the host's.
  sock=${XDG_RUNTIME_DIR:-/tmp}/rlq-deploy-test-$slot.sock
  rm -f "$sock"
  "$engine" system service --time=0 "unix://$sock" >"$work/podman-service.log" 2>&1 &
  svc_pid=$!
  for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
  [ -S "$sock" ] || { echo "deploy test: podman's API socket didn't start" >&2; cat "$work/podman-service.log" >&2; exit 1; }
  "$engine" image inspect "$compose_image" >/dev/null 2>&1 || "$engine" pull -q "$compose_image" >/dev/null
  compose_cmd=("$engine" run --rm -i --network host --security-opt label=disable
    -v "$sock:/var/run/docker.sock" -v "$repo:$repo" -v "$work:$work" -w "$here/compose"
    "$compose_image" docker compose)
fi
files=(-f "$here/compose/compose.yml" -f "$here/test/compose.test.yml")
[ "$network" = host ] && files+=(-f "$here/test/compose.hostnet.yml")
compose() { "${compose_cmd[@]}" -p "$project" --env-file "$envfile" "${files[@]}" "$@"; }

cleanup() {
  local code=$?
  if [ "${KEEP:-}" = 1 ] && [ -f "$envfile" ]; then
    echo "deploy test: KEEP=1, the stack is still up (project $project, settings in $envfile)."
    echo "  web http://127.0.0.1:$T_WEB, MCP http://127.0.0.1:$T_MCP/mcp, mail http://127.0.0.1:$T_MAILAPI"
    echo "  remove it: ${compose_cmd[*]} -p $project --env-file $envfile ${files[*]} down -v"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  [ -z "$svc_pid" ] || kill "$svc_pid" 2>/dev/null || true
  exit $code
}
trap cleanup EXIT

echo "== deploy test: project $project, network $network, compose: ${compose_cmd[0]} ${compose_cmd[1]}"
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "== setup"
if [ "$network" = host ]; then smtp_host=127.0.0.1 smtp_port=$T_SMTP; else smtp_host=mailpit smtp_port=1025; fi
PUBLIC_URL=http://127.0.0.1:$T_WEB MCP_RESOURCE=http://127.0.0.1:$T_MCP/mcp \
  SMTP_HOST=$smtp_host SMTP_PORT=$smtp_port SMTP_SENDER=reliquary@example.com \
  WEB_BIND=127.0.0.1:$T_WEB MCP_BIND=127.0.0.1:$T_MCP \
  "$here/setup.sh" "$envfile"
# The test's own settings (no secret): image tag, ports, commit.
{
  echo "RELIQUARY_TAG=$tag"
  echo "GIT_COMMIT=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
  for v in T_PG T_AUTH T_WEB T_MCP T_SMTP T_MAILAPI; do echo "$v=${!v}"; done
} >>"$envfile"

echo "== build"
# podman's default (OCI) image format drops HEALTHCHECK; compose.yml has its own.
fmt=(); [[ $(basename "$engine") == podman ]] && fmt=(--format docker)
for app in web mcp; do
  "$engine" build -q "${fmt[@]}" --network host -f "$repo/$app/Dockerfile" -t "localhost/reliquary-$app:$tag" \
    --build-arg "GIT_COMMIT=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)" "$repo" >/dev/null
  echo "built localhost/reliquary-$app:$tag"
done

echo "== up"
t0=$SECONDS
if ! compose up -d --no-build --wait --wait-timeout 300 >"$work/up.log" 2>&1; then
  echo "deploy test: the stack didn't come up healthy" >&2
  cat "$work/up.log" >&2
  compose ps -a >&2 || true
  compose logs --no-color --tail 60 >&2 || true
  exit 1
fi
echo "stack healthy in $((SECONDS - t0))s"
compose logs --no-color migrate | grep -E "migrate: [0-9]+ new migration" || true

echo "== first owner (deploy/bin/owner.mjs, Auth's admin API)"
compose run --rm --no-deps -T owner "$email"
# Again: an existing account is said so, not an error.
compose run --rm --no-deps -T owner "$email"

echo "== smoke"
status=0
"$engine" run --rm --network host -v "$here/test:/t:ro,z" \
  -e WEB_URL=http://127.0.0.1:$T_WEB -e MCP_URL=http://127.0.0.1:$T_MCP/mcp \
  -e MAIL_API=http://127.0.0.1:$T_MAILAPI -e EMAIL=$email \
  "$node_image" node /t/smoke.mjs || status=1

echo "== upgrade: the migrations again"
again=$(compose run --rm --no-deps -T migrate 2>&1 | grep -E "migrate: [0-9]+ new migration" || true)
echo "$again"
[ "$again" = "migrate: 0 new migration(s)" ] || { echo "deploy test: a second migrate run applied something" >&2; status=1; }

if [ $status != 0 ]; then
  echo "deploy test: FAILED; the apps' logs:" >&2
  compose logs --no-color --tail 80 web mcp auth >&2 || true
  exit 1
fi
echo "deploy test: passed"
