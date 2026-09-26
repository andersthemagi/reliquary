#!/usr/bin/env bash
# The email templates to paste into the hosted Supabase dashboard
# (Authentication > Emails), from web/emails/ (written by
# web/emails/build.mjs; self-hosted instances serve the same files).
#
#   scripts/email-templates.sh            every template: where it goes, its subject, its file
#   scripts/email-templates.sh <id>       one template: its subject, and its HTML copied to the
#                                         clipboard (wl-copy, xclip, xsel or pbcopy), or printed
#                                         when there's no clipboard or with --print
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
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) id=$a ;;
  esac
done

# Supabase's templates only (gotrue key set): the vault invite is the app's own.
rows() { grep -v '^#' "$manifest" | awk -F'\t' '$5 != "-"'; }

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
