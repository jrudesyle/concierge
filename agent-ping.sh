#!/usr/bin/env bash
# ── Agent Ping Script ──
# Lightweight shell script for agents to send status updates.
# Works on Linux and macOS with just curl.
#
# Usage:
#   ./agent-ping.sh <agent-id> <subtask-id> <label> <state>
#
# Examples:
#   ./agent-ping.sh qa-tests login-retry "Running login attempt #5" running
#   ./agent-ping.sh koreader book-sync "Book cleaned and synced" done
#   ./agent-ping.sh job-search linkedin-scan "LinkedIn API rate limited" error
#
# Pipe mode (label from stdin):
#   echo "Found 2 new matches" | ./agent-ping.sh job-search scan-results pending
#
# Configure: Set DASHBOARD_URL or it defaults to localhost
# On work MacBook, add to ~/.zshrc:
#   export DASHBOARD_URL="http://192.168.1.14:3030"

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3030}"

if [ $# -lt 4 ]; then
  echo "Usage: $0 <agent-id> <subtask-id> <label> <state>"
  echo ""
  echo "  state = done | running | error | pending"
  echo ""
  echo "Examples:"
  echo "  $0 qa-tests login-flow \"Login successful\" done"
  echo "  $0 koreader scan \"Scanning for new EPUBs\" running"
  exit 1
fi

AGENT="$1"
SUBTASK_ID="$2"
LABEL="$3"
STATE="$4"

# Also check stdin for label override (pipe mode)
if [ ! -t 0 ]; then
  read -r PIPED_LABEL
  [ -n "$PIPED_LABEL" ] && LABEL="$PIPED_LABEL"
fi

# Validate state
case "$STATE" in
  done|running|error|pending) ;;
  *)
    echo "Error: Invalid state '$STATE'. Must be: done, running, error, pending"
    exit 1
    ;;
esac

PAYLOAD=$(cat <<EOF
{
  "agent": "$AGENT",
  "subtask": {
    "id": "$SUBTASK_ID",
    "label": "$LABEL",
    "state": "$STATE"
  }
}
EOF
)

RESPONSE=$(curl -s -X POST "$DASHBOARD_URL/api/update" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo "✅ [${AGENT}] ${LABEL} → ${STATE}"
else
  echo "❌ Failed to send update: $RESPONSE"
  echo "   Is the dashboard running at ${DASHBOARD_URL}?"
fi
