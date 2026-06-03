#!/bin/bash
# Daily WAL-safe backup of the live Ledger database.
# Uses sqlite3 .backup (a consistent online snapshot that includes any pending
# WAL) — NOT a raw file copy, which could miss un-checkpointed writes.
# Keeps the newest $KEEP snapshots; older ones are pruned.
# Driven by the com.ledger.backup LaunchAgent (see scripts/install-backup.sh).
set -euo pipefail

# Resolve the repo root relative to this script so the backup is portable.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${LEDGER_DB:-$REPO_ROOT/data/ledger.db}"
DEST_DIR="$REPO_ROOT/data/backups"
KEEP=14

mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR" 2>/dev/null || true

[ -f "$DB" ] || { echo "$(date '+%F %T') no db at $DB — skipping"; exit 0; }

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_DIR/ledger-$TS.db"

# VACUUM INTO writes a single, defragmented, consistent snapshot (includes
# committed WAL) with no -wal/-shm sidecars to clean up.
/usr/bin/sqlite3 "$DB" "VACUUM INTO '$DEST'"
chmod 600 "$DEST" 2>/dev/null || true

# Verify the snapshot is a readable, non-corrupt database before pruning.
if ! /usr/bin/sqlite3 "$DEST" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "$(date '+%F %T') integrity check FAILED for $DEST — keeping it, not pruning"
  exit 1
fi

# Prune: keep the newest $KEEP backups.
ls -1t "$DEST_DIR"/ledger-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

echo "$(date '+%F %T') backed up → $DEST ($(ls -1 "$DEST_DIR"/ledger-*.db | wc -l | tr -d ' ') kept)"
