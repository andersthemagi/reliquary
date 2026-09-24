#!/usr/bin/env bash
# The keys that encrypt variable values (docs/variables.md, "Key rotation"),
# kept in a gitignored file, mode 600, one `id:key` per line, the current
# (sealing) key first. scripts/vercel-env.sh turns the file into the web
# app's VARIABLES_KEYS. It prints key ids only, never a key, so it is safe to
# run from anywhere, including a chat with a model. Keep a copy of every key
# in a password manager too: Vercel can't show a Sensitive value again, and
# losing a key loses every value sealed with it.
#
#   scripts/variables-keys.sh list        the key ids, current first
#   scripts/variables-keys.sh new         a new random key with the next id
#                                         (k2, k3, ...); it becomes current
#   scripts/variables-keys.sh drop <id>   forget an old key (never the current
#                                         one); only after
#                                         scripts/rotate-variables-key.sh says
#                                         everything is on the current key
#   scripts/variables-keys.sh ensure      make the file if it's missing
#
# The first time, a key from before rotation (supabase/.variables-secret,
# the single VARIABLES_KEY, whose values carry id k1) is taken over as k1;
# with none, a new k1 is made. KEYS_FILE and LEGACY_KEY_FILE override the
# paths (tests).
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

file=${KEYS_FILE:-supabase/.variables-keys-secret}
legacy=${LEGACY_KEY_FILE:-supabase/.variables-secret}

genkey() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
ids() { cut -d: -f1 "$file"; }
show() { echo "Keys in $file (current first):"; ids | sed 's/^/  /'; }

ensure() {
  if [[ ! -s $file ]]; then
    if [[ -s $legacy ]]; then
      printf 'k1:%s\n' "$(tr -d '[:space:]' < "$legacy")" > "$file"
      echo "Took over the key in $legacy as k1."
    else
      printf 'k1:%s\n' "$(genkey)" > "$file"
      echo "Made a new key k1."
    fi
    chmod 600 "$file"
  fi
  # One id:key per line: an id of 1 to 32 letters, digits, - or _, and 32
  # bytes of base64url. Never echo a line: it holds a key.
  if grep -Evq '^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{43}$' "$file" || [[ -n $(ids | sort | uniq -d) ]]; then
    echo "$file is malformed: want one id:key per line, each id once (not shown here)." >&2
    exit 1
  fi
}

# Replaces the file with stdin, atomically, mode 600.
replace() {
  local tmp
  tmp=$(mktemp "$file.XXXXXX")
  cat > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

case ${1:-} in
  ensure)
    ensure
    ;;
  list)
    ensure
    show
    ;;
  new)
    ensure
    n=$(ids | sed -n 's/^k\([0-9]\{1,9\}\)$/\1/p' | sort -n | tail -1)
    id=k$((${n:-0} + 1))
    { printf '%s:%s\n' "$id" "$(genkey)"; cat "$file"; } | replace
    echo "Added $id; it is now the current key. Copy it from $file to your password manager yourself (never through a chat)."
    show
    ;;
  drop)
    id=${2:?which key id to drop}
    ensure
    if [[ $(ids | head -1) == "$id" ]]; then
      echo "$id is the current key; add a new one (new) and re-encrypt before dropping it." >&2
      exit 1
    fi
    if ! ids | grep -qxF -- "$id"; then
      echo "There is no key $id in $file." >&2
      exit 1
    fi
    awk -F: -v id="$id" '$1 != id' "$file" | replace
    echo "Dropped $id. Keep its copy in your password manager until a backup older than the rotation no longer matters."
    show
    ;;
  *)
    echo "usage: scripts/variables-keys.sh list | new | drop <id> | ensure" >&2
    exit 2
    ;;
esac
