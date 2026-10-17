# SessionStart: what Claude Code prints here becomes context for the session.
. "$(dirname "$0")/project.sh"
cat <<EOF
This project is linked to the Reliquary $vault. Before other work, give your person a short brief from Reliquary:
1. Call list_flags for that vault: what changed since you last looked (proposals waiting on them, replies to theirs, watched paths, threads). Show it, then call advance_flags with its through value.
2. Call list_proposals for that vault: if any proposals wait on them, say how many and how old the oldest is, in one line (and nothing when none are waiting).
3. Call my_places: steps they hold and lines they wait in.
Keep it to a few lines. If Reliquary isn't connected (run /mcp), say so once and carry on.
EOF
