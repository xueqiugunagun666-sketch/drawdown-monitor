#!/bin/bash
# SQLite 在线备份。用 .backup 命令而不是直接 cp ——
# 直接复制正在写入的 WAL 数据库可能得到损坏的文件。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${APP_DIR}/data/monitor.db"
OUT_DIR="${APP_DIR}/backups"
KEEP_DAYS=14

[ -f "$DB" ] || { echo "数据库不存在: $DB"; exit 0; }
mkdir -p "$OUT_DIR"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP="${OUT_DIR}/.monitor-${STAMP}.db.partial"
FINAL="${OUT_DIR}/monitor-${STAMP}.db.gz"

# 中断、超时或压缩失败时不留下一个看似可恢复的半成品。
cleanup() { rm -f "$TMP" "${TMP}.gz"; }
trap cleanup EXIT

# .backup 对源库是一致性快照；目标先写隐藏临时名，校验成功后才原子改名。
sqlite3 "$DB" ".timeout 10000" ".backup '${TMP}'"
CHECK=$(sqlite3 "$TMP" 'PRAGMA quick_check;')
[ "$CHECK" = "ok" ] || { echo "备份校验失败" >&2; exit 1; }

# -1 大幅降低 2GB 数据库对 CPU 的占用；空间不是当前瓶颈，报警延迟才是。
gzip -1 "$TMP"
mv "${TMP}.gz" "$FINAL"
trap - EXIT

echo "已备份: ${FINAL} ($(du -h "$FINAL" | cut -f1))"

# 清理过期备份
find "$OUT_DIR" -name 'monitor-*.db.gz' -mtime "+${KEEP_DAYS}" -delete
echo "现存备份: $(find "$OUT_DIR" -name 'monitor-*.db.gz' | wc -l) 份"
