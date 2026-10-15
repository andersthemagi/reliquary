# Sourced by the hooks. Sets $vault to how to name the vault the nearest
# .reliquary.json links, or exits quietly: the plugin is installed for the
# user, so in a project not linked to a vault the hooks say nothing at all.
#
# The file comes from the repo, which may be someone else's: its vault name
# reaches the agent's context only as one word (no spaces), so a crafted one
# can't carry a sentence of instructions; anything else gets generic wording.

dir=${CLAUDE_PROJECT_DIR:-$PWD}
while [ ! -f "$dir/.reliquary.json" ]; do
  [ "$dir" = / ] || [ -z "$dir" ] && exit 0
  dir=$(dirname "$dir")
done
# ponytail: sed, not a JSON parser; no jq or node on every machine. A vault
# key split oddly across lines falls back to the generic wording below.
vault=$(tr -d '\n' < "$dir/.reliquary.json" | sed -n 's/.*"vault"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$vault" ] || exit 0
# These characters also need no escaping in the JSON push-nudge.sh writes.
printf '%s' "$vault" | grep -Eq '^[A-Za-z0-9._-]{1,64}$' && vault="vault $vault" || vault="vault named in .reliquary.json"
