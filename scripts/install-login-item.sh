#!/bin/bash
# Installs a LaunchAgent so the Personal Commentary server starts at login and restarts if it stops.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
DEST="$HOME/Library/LaunchAgents/local.personalcommentary.plist"
mkdir -p "$HOME/Library/Logs/PersonalCommentary" "$HOME/Library/LaunchAgents"
[ -f "$ROOT/dist/web/index.html" ] || (cd "$ROOT" && npm run build)
sed -e "s#__NODE__#$NODE#g" -e "s#__ROOT__#$ROOT#g" -e "s#__HOME__#$HOME#g" "$ROOT/scripts/launchd/local.personalcommentary.plist.template" > "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "Installed $DEST"
