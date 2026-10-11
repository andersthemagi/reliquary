# Shared by scripts/netlify-deploy.sh and scripts/netlify-rollback.sh: a
# curl+jq wrapper for the Netlify REST API, and the "poll a list of names
# until each one checks out, or time out" loop both scripts run after
# kicking off their requests. Sourced, not run; needs NETLIFY_AUTH_TOKEN and
# a $tmp scratch directory (the caller's own mktemp -d, trapped for removal)
# already set.
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN is required}"
api_base=${NETLIFY_API:-https://api.netlify.com/api/v1}

# netlify_api <method> <path> [json body file]: status code on stdout, body in
# $tmp/out. The token goes to curl on stdin, never as an argument.
netlify_api() {
  local args=(-sS -o "$tmp/out" -w '%{http_code}' --max-time 30 -X "$1" -H @- -H 'content-type: application/json')
  [ -z "${3:-}" ] || args+=(--data "@$3")
  curl "${args[@]}" "$api_base$2" <<< "authorization: Bearer $NETLIFY_AUTH_TOKEN" 2>/dev/null || echo 000
}
netlify_field() { jq -r "$1 // empty" "$tmp/out" 2>/dev/null || true; }

# netlify_poll_until <wait_s> <sleep_s> <verb> <suffix> <check-fn> <name>...:
# calls `check-fn <name>` for each still-pending name every <sleep_s>. The
# check echoes and returns 0 once a name is done, returns 1 to keep waiting
# on it, or exits the script itself to abort right away (e.g. an error
# state). Exits 1 after <wait_s>, naming whichever names never checked out:
# "::error::still <verb> after <wait_s>s: <names><suffix>".
netlify_poll_until() {
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
