# PostToolUse on Bash: after a git push in a linked project, remind the agent
# it may propose an update. It only reminds: a person approves canon.
input=$(cat)
# ponytail: a pattern over the hook's JSON, not a parser; it misses a push
# hidden behind an alias, which only costs a reminder.
printf '%s' "$input" | grep -Eq '"command"[[:space:]]*:[[:space:]]*"([^"]*[^a-z-])?git( -C [^ ]+)? push([^a-z-][^"]*)?"' || exit 0
. "$(dirname "$0")/project.sh"
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just pushed in a project linked to the Reliquary %s. If this work changed something the vault records (a decision, a plan step, docs), propose the update there with propose (canon files) or write_file (open files). Skip it if the vault already says so."}}\n' "$vault"
