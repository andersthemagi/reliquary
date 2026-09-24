#!/usr/bin/env bash
# Claude Code `headersHelper` for a local Reliquary: prints the Authorization
# header as JSON, read from a token file made by `./dev.sh token`. The token
# never has to live in an MCP config file.
#
#   headers-helper.sh [token-file-name]   default: Claude-Code-on-Linux
set -euo pipefail
dir="$(dirname "$(readlink -f "$0")")/.tokens"
file="$dir/${1:-Claude-Code-on-Linux}.token"
[[ -r $file ]] || { echo "reliquary: no token file at $file" >&2; exit 1; }
token=$(tr -d '\n' < "$file")
[[ $token =~ ^rlq_[0-9a-f]{64}$ ]] || { echo "reliquary: $file doesn't hold a token" >&2; exit 1; }
printf '{"Authorization": "Bearer %s"}\n' "$token"
