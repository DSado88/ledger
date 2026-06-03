#!/bin/bash
# Install (or reinstall) the daily Ledger DB backup LaunchAgent.
# Idempotent: safe to re-run. Backups land in data/backups/ (newest 14 kept),
# written daily at 03:30 by scripts/backup-ledger.sh.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.ledger.backup.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/com.ledger.backup.plist"
LEDGER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.ledger.backup"
UID_NUM="$(id -u)"

# Install the bundled plist into LaunchAgents, substituting this repo's absolute
# path for the __LEDGER_DIR__ placeholder (LaunchAgents require absolute paths).
mkdir -p "$HOME/Library/LaunchAgents"
[ -f "$SRC" ] || { echo "Missing $SRC — cannot install."; exit 1; }
sed "s|__LEDGER_DIR__|$LEDGER_DIR|g" "$SRC" > "$PLIST"

# Reload cleanly (ignore "not loaded" on first install).
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"

echo "Installed $LABEL — daily 03:30 backup."
echo "Run now:   launchctl kickstart gui/$UID_NUM/$LABEL"
echo "Status:    launchctl print gui/$UID_NUM/$LABEL | grep -E 'state|last exit'"
echo "Uninstall: launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST"
