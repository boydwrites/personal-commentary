#!/bin/bash
# Builds the UI and starts a self-contained, offline fixture demo.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
exec node scripts/demo.ts "$@"
