#!/usr/bin/env bash
# Back up the match server: an online, consistent copy of the SQLite database
# (sqlite3 .backup, safe while matches run) plus records/, into $KB_BACKUP_DIR,
# then prune old backups and optionally copy them off the VM. #26
#
#   deploy/backup.sh                 # from the compose directory (where docker-compose.yml and .env are)
#   crontab: 17 3 * * * cd /opt/knockback && deploy/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
DEST=${KB_BACKUP_DIR:-./backups}
KEEP=${KB_BACKUP_KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"

if ! docker compose ps --status running --services | grep -qx server; then
  echo "backup: the server container is not running (docker compose up -d first)" >&2
  exit 1
fi
CID=$(docker compose ps -q server)

# 1. database: online backup inside the container, check it, copy it out
docker compose exec -T server sqlite3 /data/match-server.db ".backup '/data/backups/match-server-$STAMP.db'"
# one self-contained file (no -wal/-shm beside it), then check it
docker compose exec -T server sqlite3 "/data/backups/match-server-$STAMP.db" "PRAGMA journal_mode=DELETE;" > /dev/null
check=$(docker compose exec -T server sqlite3 "/data/backups/match-server-$STAMP.db" "PRAGMA integrity_check;")
if [ "$check" != "ok" ]; then
  echo "backup: integrity check failed: $check" >&2
  exit 1
fi
docker cp "$CID:/data/backups/match-server-$STAMP.db" "$DEST/match-server-$STAMP.db"
docker compose exec -T server rm -f "/data/backups/match-server-$STAMP.db"

# 2. records (JSON files; small)
docker compose exec -T server tar -C /data -czf - records > "$DEST/records-$STAMP.tar.gz"

# 3. prune local copies
find "$DEST" -maxdepth 1 \( -name 'match-server-*.db' -o -name 'records-*.tar.gz' \) -mtime +"$KEEP" -delete

# 4. off the VM
if [ -n "${KB_BACKUP_REMOTE:-}" ]; then
  rsync -a --include='match-server-*.db' --include='records-*.tar.gz' --exclude='*' "$DEST/" "$KB_BACKUP_REMOTE"
fi

echo "backup: $DEST/match-server-$STAMP.db ($(du -h "$DEST/match-server-$STAMP.db" | cut -f1)), $DEST/records-$STAMP.tar.gz ($(du -h "$DEST/records-$STAMP.tar.gz" | cut -f1))${KB_BACKUP_REMOTE:+, copied to $KB_BACKUP_REMOTE}"
