#!/bin/bash
# Double-click this in Finder (or run ./start.command) to start the Ledger server.
# Builds the frontend, then serves at http://localhost:7815
set -e

# Make sure bun + the 1Password CLI (op) are findable, regardless of how this was launched.
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"

cd "$(dirname "$0")"

echo "Building frontend..."
bun run build

echo "Starting Ledger at http://localhost:7815  (press Ctrl-C to stop)"
exec bun run src/server/index.ts
