#!/bin/bash
# Opens Personal Commentary in the browser, starting its local server if needed.
set -euo pipefail
cd "$(dirname "$0")"
DATA_DIR="${COMMENTARY_DATA_DIR:-$HOME/Library/Application Support/PersonalCommentary}"
LOG_DIR="${COMMENTARY_LOG_DIR:-$HOME/Library/Logs/PersonalCommentary}"
PORT_FILE="$DATA_DIR/port"
mkdir -p "$DATA_DIR" "$LOG_DIR"
running() {
  [ -f "$PORT_FILE" ] && curl -fsS --max-time 2 "http://127.0.0.1:$(cat "$PORT_FILE")/api/health" 2>/dev/null | grep -q '"id":"PersonalCommentary"'
}
if ! running; then
  [ -d node_modules ] || npm ci
  [ -f dist/web/index.html ] || npm run build
  NODE_ENV=production nohup node server/index.ts >> "$LOG_DIR/server.out" 2>&1 &
  for i in $(seq 1 60); do running && break; sleep 0.3; done
fi
if ! running; then
  echo "Personal Commentary could not start. See $LOG_DIR/server.out for details." >&2
  exit 1
fi
open "http://127.0.0.1:$(cat "$PORT_FILE")/"
