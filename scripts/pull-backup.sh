#!/bin/bash
# 把服务器最新备份拉到本机 —— 异地副本。
#
# 服务器上的备份和数据库在同一块磁盘，能防误删与损坏，
# 防不了机器整台挂掉。这个脚本补上那一环。
#
#   npm run backup:pull
set -euo pipefail

HOST="${DRAWDOWN_SSH_HOST:-drawdown}"
REMOTE_DIR=/opt/drawdown-monitor/backups
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backups-remote"

mkdir -p "$LOCAL_DIR"

LATEST=$(ssh "$HOST" "ls -t ${REMOTE_DIR}/*.db.gz 2>/dev/null | head -1" || true)
[ -n "$LATEST" ] || { echo "服务器上没有备份文件"; exit 1; }

NAME=$(basename "$LATEST")
echo "拉取 $NAME …"
scp -q "${HOST}:${LATEST}" "${LOCAL_DIR}/${NAME}"

# 验证：解压后能不能查 —— 拉下来一个坏文件比没有更糟
TMP=$(mktemp)
gunzip -c "${LOCAL_DIR}/${NAME}" > "$TMP"
TOKENS=$(sqlite3 "$TMP" "select count(*) from tokens" 2>/dev/null || echo "ERR")
EVENTS=$(sqlite3 "$TMP" "select count(*) from events" 2>/dev/null || echo 0)
CANDLES=$(sqlite3 "$TMP" "select count(*) from candles" 2>/dev/null || echo "ERR")
rm -f "$TMP"

if [ "$TOKENS" = "ERR" ]; then
  echo "备份文件损坏，无法查询！"
  exit 1
fi

echo "已保存: ${LOCAL_DIR}/${NAME}  ($(du -h "${LOCAL_DIR}/${NAME}" | cut -f1))"
echo "校验通过: ${TOKENS} 个代币 / ${EVENTS} 条日程 / ${CANDLES} 根 candle"

# 本机只留最近 10 份
ls -t "${LOCAL_DIR}"/*.db.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "本机现存 $(ls "${LOCAL_DIR}"/*.db.gz 2>/dev/null | wc -l | tr -d ' ') 份"
