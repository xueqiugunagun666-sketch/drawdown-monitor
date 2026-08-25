#!/bin/bash
# SQLite 备份。用 .backup 命令而不是直接 cp ——
# 直接复制正在写入的 WAL 数据库可能得到损坏的文件。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${APP_DIR}/data/monitor.db"
OUT_DIR="${APP_DIR}/backups"
KEEP_DAYS=14   # 每 6 小时一次 x 14 天 = 56 份，压缩后约 350MB，50G 盘绰绰有余

[ -f "$DB" ] || { echo "数据库不存在: $DB"; exit 0; }
mkdir -p "$OUT_DIR"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP="${OUT_DIR}/monitor-${STAMP}.db"

# .backup 是原子的，且能安全地在写入过程中执行
sqlite3 "$DB" ".backup '${TMP}'"
gzip -9 "$TMP"

echo "已备份: ${TMP}.gz ($(du -h "${TMP}.gz" | cut -f1))"

# 清理过期备份
find "$OUT_DIR" -name 'monitor-*.db.gz' -mtime "+${KEEP_DAYS}" -delete
echo "现存备份: $(find "$OUT_DIR" -name 'monitor-*.db.gz' | wc -l) 份"
