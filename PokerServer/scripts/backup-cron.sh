#!/bin/bash
# 每日备份（SQLite 版）。替代旧的 cp data.json/hands.jsonl 方案。
#
# ⚠️ 为什么不能再用 cp：SQLite 跑在 WAL 模式下，最新写入可能还在 -wal 文件里。
#    只复制主库文件会得到一个【不完整甚至损坏】的备份，而且平时看不出来，
#    等真要恢复时才发现——那时就晚了。必须用 SQLite Online Backup API
#    （scripts/backup-sqlite.js）生成一致性快照。
#
# 用法：backup-cron.sh <数据库路径> <备份目录> [保留份数]
# 退出码：0 成功；非 0 失败（cron 可据此告警）
set -euo pipefail

DB="${1:?用法: backup-cron.sh <db路径> <备份目录> [保留份数]}"
DST="${2:?用法: backup-cron.sh <db路径> <备份目录> [保留份数]}"
KEEP="${3:-30}"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ts=$(date +%Y%m%d_%H%M%S)
mkdir -p "$DST"

if [ ! -f "$DB" ]; then
  echo "[backup] ❌ 找不到数据库：$DB"
  exit 1
fi

OUT="$DST/pokerdojo-$ts.sqlite"
echo "[backup] $ts 开始备份 $DB → $OUT"

# 1) 一致性快照（Online Backup，不阻塞在线服务、不受 WAL 影响）
node "$SERVER_DIR/scripts/backup-sqlite.js" "$DB" "$OUT"

# 2) 立刻校验这份【备份文件本身】——没验证过的备份不算备份
if ! node "$SERVER_DIR/scripts/verify-sqlite.js" "$OUT" > "$OUT.verify.json" 2>&1; then
  echo "[backup] ❌ 备份校验失败，保留现场供排查：$OUT"
  exit 1
fi
if ! grep -q '"integrity": *"ok"' "$OUT.verify.json"; then
  echo "[backup] ❌ 备份完整性不是 ok，保留现场：$OUT"
  cat "$OUT.verify.json"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
HANDS=$(grep -o '"hands": *[0-9]*' "$OUT.verify.json" | tail -1 | grep -o '[0-9]*' || echo '?')
USERS=$(grep -o '"users": *[0-9]*' "$OUT.verify.json" | head -1 | grep -o '[0-9]*' || echo '?')
echo "[backup] ✅ 校验通过 大小=$SIZE 用户=$USERS 牌谱=$HANDS"

# 3) 清理超出保留份数的旧备份（连同其校验报告）
# 🔴 只数【每日备份】（pokerdojo-<日期>_<时间>）。原来的 pokerdojo-*.sqlite 把
#    pokerdojo-predeploy-* 也算了进去 —— 每部署一次就挤掉一份每日备份。
#    （check-backups.js 本来就只认每日那种，两边口径现在一致。）
ls -1t "$DST"/pokerdojo-[0-9]*_[0-9]*.sqlite 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.verify.json"
done
# 部署前快照单独留最近 5 份（连同验证时留下的 -wal/-shm）
ls -1t "$DST"/pokerdojo-predeploy-*.sqlite 2>/dev/null | tail -n +6 | while read -r old; do
  rm -f "$old" "$old.verify.json" "$old-wal" "$old-shm"
done

echo "[backup] $ts done（保留最近 $KEEP 份）"
