#!/usr/bin/env bash
# The email templates to paste into the hosted Supabase dashboard
# (Authentication > Emails), from web/emails/ (written by
# web/emails/build.mjs; self-hosted instances serve the same files).
#
#   scripts/email-templates.sh            every template: where it goes, its subject, its file
#   scripts/email-templates.sh <id>       one template: its subject, and its HTML copied to the
#                                         clipboard (wl-copy, xclip, xsel or pbcopy), or printed
#                                         when there's no clipboard or with --print
#   scripts/email-templates.sh apply      put every template and subject into the hosted project
#                                         and turn the security notifications on, through
#                                         Supabase's Management API (PATCH /v1/projects/<ref>/config/auth)
#   scripts/email-templates.sh check      compare the project's templates and subjects with these
#                                         files; prints only "same" or "differs" per template
#
# apply and check read a Supabase personal access token from
# supabase/.access-token (gitignored; make one at
# https://supabase.com/dashboard/account/tokens, paste it into that file,
# chmod 600) or SUPABASE_ACCESS_TOKEN. The token is sent as a header read
# from a file, never on the command line, and never printed. The project is
# SUPABASE_PROJECT_REF, default bigonndpibguxuwtysnx. Needs curl and python3.
#
# Steps: web/README.md, "Supabase dashboard", and docs/ops/runbook.md,
# "Email templates". Needs only bash. Prints no secret (the templates hold none).
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
dir=$repo/web/emails
manifest=$dir/manifest.tsv
[ -f "$manifest" ] || { echo "email-templates: $manifest is missing (run node emails/build.mjs in web/)" >&2; exit 1; }

print=0
id=""
for a in "$@"; do
  case $a in
    --print) print=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) id=$a ;;
  esac
done

# Supabase's templates only (gotrue key set): the vault invite is the app's own.
rows() { grep -v '^#' "$manifest" | awk -F'\t' '$5 != "-"'; }

if [ "$id" = apply ] || [ "$id" = check ]; then
  ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
  tokfile=$repo/supabase/.access-token
  token=${SUPABASE_ACCESS_TOKEN:-}
  if [ -z "$token" ] && [ -f "$tokfile" ]; then token=$(tr -d '[:space:]' < "$tokfile"); fi
  if [ -z "$token" ]; then
    echo "email-templates: no access token. Make one at https://supabase.com/dashboard/account/tokens," >&2
    echo "paste it into supabase/.access-token (chmod 600), then run this again." >&2
    exit 2
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  umask 077
  printf 'Authorization: Bearer %s\n' "$token" > "$tmp/auth"
  unset token
  url="${SUPABASE_API_URL:-https://api.supabase.com}/v1/projects/$ref/config/auth"
  if [ "$id" = apply ]; then
    python3 - "$manifest" "$dir" > "$tmp/body.json" <<'PY'
import json, sys
manifest, d = sys.argv[1], sys.argv[2]
body = {}
for line in open(manifest, encoding="utf-8"):
    if line.startswith("#") or not line.strip():
        continue
    tid, file, _sec, _name, key, notify, subject = line.rstrip("\n").split("\t")
    if key == "-":
        continue
    k = key.lower()
    body[f"mailer_subjects_{k}"] = subject
    body[f"mailer_templates_{k}_content"] = open(f"{d}/{file}", encoding="utf-8").read()
    if notify != "-":
        body[f"mailer_notifications_{notify.lower()}_enabled"] = True
print(json.dumps(body))
PY
    code=$(curl -sS -o "$tmp/out" -w '%{http_code}' -X PATCH "$url" -H @"$tmp/auth" -H 'Content-Type: application/json' --data-binary @"$tmp/body.json") || code=000
    if [ "$code" = 200 ]; then
      echo "email-templates: applied $(rows | wc -l) templates and their subjects to project $ref, security notifications on."
      echo "Check one: sign out, then sign in at the app; the code comes in the new template."
      exit 0
    fi
    echo "email-templates: Supabase refused the update (HTTP $code) for project $ref." >&2
    python3 -c 'import json,sys
try: print("  why:", json.load(open(sys.argv[1])).get("message","(no message)"))
except Exception: print("  why: (no readable message)")' "$tmp/out" >&2
    [ "$code" = 401 ] && echo "  The access token was refused: make a new one and put it in supabase/.access-token." >&2
    exit 1
  fi
  code=$(curl -sS -o "$tmp/cfg" -w '%{http_code}' "$url" -H @"$tmp/auth") || code=000
  if [ "$code" != 200 ]; then echo "email-templates: couldn't read project $ref's auth settings (HTTP $code)." >&2; exit 1; fi
  python3 - "$manifest" "$dir" "$tmp/cfg" <<'PY'
import json, sys
manifest, d, cfg = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3]))
bad = 0
for line in open(manifest, encoding="utf-8"):
    if line.startswith("#") or not line.strip():
        continue
    tid, file, _sec, name, key, notify, subject = line.rstrip("\n").split("\t")
    if key == "-":
        continue
    k = key.lower()
    same = cfg.get(f"mailer_subjects_{k}") == subject and cfg.get(f"mailer_templates_{k}_content") == open(f"{d}/{file}", encoding="utf-8").read()
    if notify != "-" and cfg.get(f"mailer_notifications_{notify.lower()}_enabled") is not True:
        same = False
    bad += not same
    print(f"{'same   ' if same else 'differs'}  {name} ({tid})")
sys.exit(1 if bad else 0)
PY
  exit $?
fi

if [ -z "$id" ]; then
  echo "Supabase dashboard: Authentication > Emails. For each template: open it, set the"
  echo "subject, paste the HTML into the body (Source), save. Copy one with:"
  echo "  scripts/email-templates.sh <id>"
  section=""
  n=0
  while IFS=$'\t' read -r tid file sec name _gotrue notify subject; do
    if [ "$sec" != "$section" ]; then
      section=$sec
      echo
      if [ "$sec" = "Templates" ]; then echo "== Templates tab"; else echo "== $sec (turn each one on, then edit it)"; fi
    fi
    n=$((n + 1))
    printf '%2d. %s  (id: %s)\n    subject: %s\n    file:    web/emails/%s\n' "$n" "$name" "$tid" "$subject" "$file"
  done < <(rows)
  exit 0
fi

line=$(rows | awk -F'\t' -v id="$id" '$1 == id') || true
if [ -z "$line" ]; then
  echo "email-templates: no template \"$id\"; the ids are: $(rows | cut -f1 | tr '\n' ' ')" >&2
  exit 2
fi
IFS=$'\t' read -r _ file sec name _ _ subject <<< "$line"
echo "Supabase dashboard: Authentication > Emails > $sec > $name"
echo "Subject: $subject"

copy=()
if [ "$print" = 0 ]; then
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null; then copy=(wl-copy)
  elif [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null; then copy=(xclip -selection clipboard)
  elif [ -n "${DISPLAY:-}" ] && command -v xsel >/dev/null; then copy=(xsel --clipboard --input)
  elif command -v pbcopy >/dev/null; then copy=(pbcopy)
  fi
fi
if [ ${#copy[@]} -gt 0 ]; then
  "${copy[@]}" < "$dir/$file"
  echo "Body: web/emails/$file, copied to the clipboard ($(wc -c < "$dir/$file") bytes). Paste it as the body, then save."
else
  echo "Body (web/emails/$file):"
  echo
  cat "$dir/$file"
fi
