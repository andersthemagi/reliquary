# SessionStart: what Claude Code prints here becomes context for the session.
. "$(dirname "$0")/project.sh"
cat <<EOF
This project is linked to the Reliquary $vault. Before other work, give your person a short brief from Reliquary:
1. Call list_flags for that vault: what changed since you last looked (proposals waiting on them, replies to theirs, watched paths, threads). Show it, then call advance_flags with its through value.
2. Call list_proposals for that vault: say in one line how many proposals are open and how old the oldest is, or nothing when none are open. If it ends with a "more:" line, say "more than 100 open" and give no age.
3. Call my_places: steps they hold and lines they wait in.
Keep it to a few lines. If Reliquary isn't connected (run /mcp), say so once and carry on.
EOF
