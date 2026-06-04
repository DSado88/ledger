#!/usr/bin/env bash
# Launchd entrypoint for the always-on Ledger server.
#
# Loads the 1Password service-account token from a 0600 file (kept out of the
# plist and out of git) so `op` can read Plaid credentials from the "Plaid"
# vault headlessly — no GUI/biometric unlock needed — then builds + serves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${LEDGER_OP_TOKEN_FILE:-$HOME/.config/ledger/op-token}"

if [ -r "$TOKEN_FILE" ]; then
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
  export OP_SERVICE_ACCOUNT_TOKEN
fi

cd "$ROOT"
exec bun run dev
