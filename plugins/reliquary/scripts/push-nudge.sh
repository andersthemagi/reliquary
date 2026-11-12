# PostToolUse on Bash: after a git push in a linked project, remind the agent
# it may propose an update. It only reminds: a person approves canon.
input=$(cat)
# ponytail: a pattern over the hook's JSON, not a parser; it misses a push
# hidden behind an alias, which only costs a reminder. Claude Code sends the
# command as a string; Codex's docs don't say whether it sends a string or
# an argv array, so both count: a shell line in one of the array's strings
# (["bash","-lc","git push"]) or git run directly (["git","push",...]).
s='[[:space:]]*'
printf '%s' "$input" | grep -Eq \
  -e "\"command\"$s:$s(\\[[^]]*)?\"([^\"]*[^a-z-])?git( -C [^ ]+)? push([^a-z-][^\"]*)?\"" \
  -e "\"command\"$s:$s\\[$s\"git\"$s,$s(\"-C\"$s,$s\"[^\"]*\"$s,$s)?\"push\"${s}[],]" || exit 0
. "$(dirname "$0")/project.sh"
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just pushed in a project linked to the Reliquary %s. If this work changed something the vault records (a decision, a plan step, docs), propose the update there with propose (canon files) or write_file (open files). Skip it if the vault already says so."}}\n' "$vault"
