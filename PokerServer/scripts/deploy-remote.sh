#!/bin/bash
# 服务器端的部署步骤：deploy.sh 和 deploy-test.sh 共用（2026-11-14 从两份几乎相同的 heredoc 合并而来）。
#
# 用法（由本地部署脚本通过 ssh 调用，不要手动跑）：
#   SERVER_PATH=… DB_PATH=… BACKUP_PATH=… PM2_APP=… bash <STAGE>/scripts/deploy-remote.sh <STAGE>
#
# 🔴 为什么要改成这样：原来是「先停服 → 再做备份 + 整库完整性校验 → 再启动」，
#    停机时长随数据库变大一路上涨（库每月涨 ~95MB）；新代码还是直接解压在运行中的目录上，
#    npm install 那段时间旧进程在给玩家发新前端。现在：
#      ① 新代码解压到临时目录，依赖在那里装好 —— 旧服务全程照常运行
#      ② 在线备份（SQLite Online Backup 对运行中的库也能得到一致快照）—— 旧服务仍在运行
#      ③ 停服 → 跑迁移 → rsync 同步到正式目录 → 启动        ← 只有这一段是停机，几秒钟
#      ④ 启动之后再校验刚才那份快照的完整性
#    rsync --delete 顺带解决了「仓库里删掉的文件在服务器上一直残留」（tar 解包从不删文件）。

set -euo pipefail
STAGE="$1"
: "${SERVER_PATH:?}" "${DB_PATH:?}" "${BACKUP_PATH:?}" "${PM2_APP:?}"
say() { echo "   $*"; }

# 运行时文件：只在服务器上存在，绝不能被同步覆盖或删除
RSYNC_EXCLUDES=(
    --exclude 'secret.key' --exclude 'mail.json' --exclude 'mail.json.*'
    --exclude 'data.json*' --exclude '*.jsonl*' --exclude 'voice_tmp/' --exclude '.local/'
    --exclude 'crash-report.json'
)

# 0) 记下错误日志当前大小：发版后自查只读【这之后】新增的部分
ERRLOG=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['pm2_env']['pm_err_log_path'] for x in d if x['name']=='$PM2_APP'][0])" 2>/dev/null || true)
[ -n "$ERRLOG" ] || ERRLOG="$HOME/.pm2/logs/${PM2_APP}-error.log"
# 🔴 取不到基准时必须写 unknown，【绝不能写 0】—— 写 0 等于把整个历史日志当成新错误喷出来（2026-09-17 误报过）
if [ -f "$ERRLOG" ]; then wc -c < "$ERRLOG" > "/tmp/poker_errsize_$PM2_APP"; else echo unknown > "/tmp/poker_errsize_$PM2_APP"; fi

# 1) 依赖：从正式目录拷一份 node_modules 过来，lock 文件没变就不必再装
echo "📦 准备依赖（旧服务照常运行）..."
if [ -d "$SERVER_PATH/node_modules" ]; then cp -a "$SERVER_PATH/node_modules" "$STAGE/node_modules"; fi
OLD_LOCK=$(sha256sum "$SERVER_PATH/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)
NEW_LOCK=$(sha256sum "$STAGE/package-lock.json" | cut -d' ' -f1)
if [ ! -d "$STAGE/node_modules" ] || [ "$OLD_LOCK" != "$NEW_LOCK" ]; then
    # 地理库（可选依赖）首次安装要下载解析 100MB+ 数据，在 1G 内存的机器上可能触发 OOM。
    # 正式目录里本来就没有它 → 这次也跳过可选依赖；已经装了的 → 照常（npm 不会去碰已装好的包）。
    OPT=""
    [ -d "$SERVER_PATH/node_modules/geoip-lite" ] || OPT="--omit=optional"
    say "package-lock 有变化，安装依赖 ${OPT}"
    ( cd "$STAGE" && npm install --omit=dev $OPT --no-audit --no-fund )
else
    say "package-lock 没变，沿用现有依赖"
fi

# 2) 在线备份（不停服）
echo "🗄️ 在线备份数据库..."
mkdir -p "$(dirname "$DB_PATH")" "$BACKUP_PATH"
if [ ! -f "$DB_PATH" ]; then
    echo "❌ 找不到数据库 $DB_PATH —— 拒绝在没有数据的情况下启动（新服务器请先按 OPS.local.md 恢复数据）"
    exit 1
fi
SNAPSHOT="$BACKUP_PATH/pokerdojo-predeploy-$(date +%Y%m%d-%H%M%S).sqlite"
node "$STAGE/scripts/backup-sqlite.js" "$DB_PATH" "$SNAPSHOT"
say "快照：$SNAPSHOT"

# 3) 停机窗口：停 → 迁移 → 同步 → 启
echo "🔁 切换（停机开始）..."
T0=$(date +%s.%N)
STOPPED=0; SYNCED=0
restore_old() {
    # 停了服却没能启动新版：至少把服务拉起来（同步之前失败 = 仍是旧代码，照常可用）
    if [ "$STOPPED" = 1 ]; then
        echo "⚠️ 切换中途失败（已同步新代码：$SYNCED），尝试重新拉起服务..."
        ( cd "$SERVER_PATH" && POKER_DB_PATH="$DB_PATH" NODE_ENV=production pm2 restart "$PM2_APP" --update-env ) || true
    fi
}
trap restore_old ERR
pm2 stop "$PM2_APP" >/dev/null 2>&1 || true
STOPPED=1
( cd "$STAGE" && POKER_DB_PATH="$DB_PATH" node scripts/migrate-sqlite.js )
mkdir -p "$SERVER_PATH"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$STAGE/" "$SERVER_PATH/"
SYNCED=1
cd "$SERVER_PATH"
POKER_DB_PATH="$DB_PATH" NODE_ENV=production pm2 restart "$PM2_APP" --update-env >/dev/null ||
    POKER_DB_PATH="$DB_PATH" NODE_ENV=production pm2 start server.js --name "$PM2_APP" >/dev/null
STOPPED=0
trap - ERR
pm2 save >/dev/null
T1=$(date +%s.%N)
say "停机 $(python3 -c "print(f'{$T1-$T0:.1f}')") 秒"

# 4) 启动之后再校验刚才那份快照
echo "🔍 校验部署前快照..."
if node scripts/verify-sqlite.js "$SNAPSHOT" > "$SNAPSHOT.verify.json" 2>&1; then
    say "快照完整性 ok"
else
    echo "⚠️ 部署前快照校验未通过！详见 $SNAPSHOT.verify.json（线上服务已在运行，请尽快人工检查）"
fi
rm -rf "$STAGE"
