# Shared by scripts/vercel-deploy.sh and scripts/vercel-rollback.sh: a
# curl+jq wrapper for the Vercel REST API, and the "poll a list of names
# until each one checks out, or time out" loop both scripts run after
# kicking off their requests. Sourced, not run; needs VERCEL_TOKEN and a
# $tmp scratch directory (the caller's own mktemp -d, trapped for removal)
# already set.
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
api_base=${VERCEL_API:-https://api.vercel.com}
team=${VERCEL_TEAM_ID:+?teamId=$VERCEL_TEAM_ID}

# vercel_api <method> <path> [json body file]: status code on stdout, body in
# $tmp/out. <path> may already carry its own ?query, so team joins it with &
# in that case rather than a second leading ?.
vercel_api() {
  local args=(-sS -o "$tmp/out" -w '%{http_code}' --max-time 30 -X "$1" -H @- -H 'content-type: application/json')
  [ -z "${3:-}" ] || args+=(--data "@$3")
  local url="$api_base$2"
  if [ -n "$team" ]; then
    [[ $url == *'?'* ]] && url="$url&${team#?}" || url="$url$team"
  fi
  curl "${args[@]}" "$url" <<< "authorization: Bearer $VERCEL_TOKEN" 2>/dev/null || echo 000
}
vercel_field() { jq -r "$1 // empty" "$tmp/out" 2>/dev/null || true; }

# vercel_poll_until <wait_s> <sleep_s> <verb> <suffix> <check-fn> <name>...:
# calls `check-fn <name>` for each still-pending name every <sleep_s>. The
# check echoes and returns 0 once a name is done, returns 1 to keep waiting
# on it, or exits the script itself to abort right away (e.g. an ERROR
# state). Exits 1 after <wait_s>, naming whichever names never checked out:
# "::error::still <verb> after <wait_s>s: <names><suffix>".
vercel_poll_until() {
  local wait_s=$1 sleep_s=$2 verb=$3 suffix=$4 check=$5; shift 5
  local deadline=$((SECONDS + wait_s)) pending=("$@") left
  while [ ${#pending[@]} -gt 0 ]; do
    left=()
    for name in "${pending[@]}"; do
      "$check" "$name" || left+=("$name")
    done
    pending=(${left[@]+"${left[@]}"})
    [ ${#pending[@]} -eq 0 ] && break
    if [ $SECONDS -ge $deadline ]; then
      echo "::error::still $verb after ${wait_s}s: ${pending[*]}$suffix"
      exit 1
    fi
    sleep "$sleep_s"
  done
}
