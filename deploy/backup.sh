#!/usr/bin/env bash
# Nightly database backup. Install with:
#   sudo cp deploy/backup.sh /usr/local/bin/nit-backup && sudo chmod +x /usr/local/bin/nit-backup
#   sudo crontab -e   ->   15 2 * * * /usr/local/bin/nit-backup
#
# Keeps 14 days. A backup that has never been restored is not a backup: restore one into a
# scratch database every month and run `npm run db:migrate` against it.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/nit}"
KEEP_DAYS="${KEEP_DAYS:-14}"
ENV_FILE="${ENV_FILE:-/opt/nit-hospital-automation/.env}"

# shellcheck disable=SC1090
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$DATABASE_URL" ] || { echo "DATABASE_URL not found in $ENV_FILE" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M)"
FILE="$BACKUP_DIR/nit-$STAMP.sql.gz"

pg_dump "$DATABASE_URL" | gzip > "$FILE"
chmod 600 "$FILE"   # patient data: readable only by root
find "$BACKUP_DIR" -name 'nit-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
