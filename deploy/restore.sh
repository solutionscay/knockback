#!/usr/bin/env bash
# Restore the match server from a backup made by deploy/backup.sh. #26
#
#   deploy/restore.sh backups/match-server-<stamp>.db [backups/records-<stamp>.tar.gz]
#
# Takes a safety backup first (if the server runs), stops the server, replaces
# the database (dropping its WAL), merges the records archive into records/
# (records already there are kept: they never change), checks the database and starts again.
# Matches that were running in the backup resume from their stored rounds.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${1:?usage: deploy/restore.sh <match-server-*.db> [records-*.tar.gz]}
RECORDS=${2:-}
[ -f "$DB" ] || { echo "restore: no such file: $DB" >&2; exit 1; }
[ -z "$RECORDS" ] || [ -f "$RECORDS" ] || { echo "restore: no such file: $RECORDS" >&2; exit 1; }

if docker compose ps --status running --services | grep -qx server; then
  echo "restore: safety backup of the current state first"
  deploy/backup.sh
fi
docker compose stop server

# a one-off container with the same volume, no server process
run() { docker compose run --rm --no-deps -T --entrypoint sh server -c "$1"; }
run 'set -e; rm -f /data/match-server.db-wal /data/match-server.db-shm; cat > /data/match-server.db.restore; mv /data/match-server.db.restore /data/match-server.db' < "$DB"
check=$(run 'sqlite3 /data/match-server.db "PRAGMA integrity_check;"')
[ "$check" = "ok" ] || { echo "restore: integrity check failed: $check" >&2; exit 1; }
if [ -n "$RECORDS" ]; then
  run 'tar -C /data -xzf - --skip-old-files' < "$RECORDS"
fi

docker compose up -d server
echo "restore: done from $DB${RECORDS:+ and $RECORDS}; check: docker compose ps, docker compose logs server"
