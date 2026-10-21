#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# kefu 資料庫備份腳本(pg_dump)
#
# 用法(在 docker-compose.yml 所在目錄執行):
#   ./ops/backup.sh                 # 備份到預設目錄 ./backups
#   BACKUP_DIR=/mnt/nas ./ops/backup.sh
#   RETENTION_DAYS=30 ./ops/backup.sh
#
# 建議以 cron 每日執行,例如:
#   0 3 * * *  cd /path/to/kefu && ./ops/backup.sh >> /var/log/kefu-backup.log 2>&1
#
# 還原(謹慎!會覆蓋現有資料):
#   gunzip -c backups/kefu-YYYYmmdd-HHMMSS.sql.gz | \
#     docker compose exec -T postgres psql -U kefu -d kefu
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"   # 保留天數,超過自動清除
PG_SERVICE="${PG_SERVICE:-postgres}"     # docker compose 服務名
PG_USER="${PG_USER:-kefu}"
PG_DB="${PG_DB:-kefu}"

# 選擇 docker compose 指令(新版 "docker compose" / 舊版 "docker-compose")
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "找不到 docker compose,請先安裝。" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/kefu-$TS.sql.gz"

echo "[$(date '+%F %T')] 開始備份 $PG_DB -> $OUT"
# -Fp 純文字 SQL、--no-owner 便於跨環境還原;透過管道 gzip 壓縮
$DC exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner \
  | gzip -9 > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date '+%F %T')] 備份完成($SIZE):$OUT"

# 清理過期備份
find "$BACKUP_DIR" -name 'kefu-*.sql.gz' -type f -mtime +"$RETENTION_DAYS" -print -delete \
  | sed 's/^/  已刪除過期備份: /' || true

echo "[$(date '+%F %T')] 完成。現有備份:"
ls -1t "$BACKUP_DIR"/kefu-*.sql.gz 2>/dev/null | head -10 || true
