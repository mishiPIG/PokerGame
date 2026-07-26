#!/bin/bash
# 测试部署脚本：本地代码 → 实验室 5090 测试服务器（沙特，内网 10.76.106.91）
#
# 用途：日常开发测试。深圳服务器（deploy.sh）留作正式产品发布。
#
# 用法：
#   bash deploy-test.sh        # 同步代码 + 重启（不走 git）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_HOST="5090"
SERVER_PATH="/home/caoy0d/PokerGame/PokerServer"
DB_PATH="/home/caoy0d/PokerGame/data/pokerdojo.sqlite"
BACKUP_PATH="/home/caoy0d/PokerGame/backups"
PM2_APP="poker-test"
TEST_URL="http://10.76.106.91:3000"

# Step 0: 部署前安全体检（eslint no-undef + 解构交叉核对）——专抓"用了但没定义/没准备好"的崩溃隐患，不过就中止。
echo "🔎 部署前安全检查（防「用了没定义」导致上线后崩溃）..."
( cd "$SCRIPT_DIR/PokerServer" && npm run check ) || { echo "❌ 安全检查未通过，已中止部署——请先修复上面报告的问题。"; exit 1; }
echo "✅ 安全检查通过"

# Step 1: 打包源码（排除 node_modules 和 data.json，避免覆盖服务器测试数据）
echo "🚀 同步代码到测试服务器（5090）..."
DEPLOY_TMP="/tmp/poker_test_$$.tar.gz"
cd "$SCRIPT_DIR/PokerServer"
tar czf "$DEPLOY_TMP" $(find . -maxdepth 1 -type f ! -name 'data.json*' ! -name 'hands.jsonl' ! -name 'secret.key' ! -name 'mail.json' ! -name 'feedback.jsonl') avatars scripts src public
scp "$DEPLOY_TMP" "$SERVER_HOST:/tmp/poker_test.tar.gz"
ssh "$SERVER_HOST" "cd $SERVER_PATH && tar xzf /tmp/poker_test.tar.gz && rm /tmp/poker_test.tar.gz"
rm -f "$DEPLOY_TMP"
cd "$SCRIPT_DIR"

# Step 2: 安装依赖
echo ""
echo "📦 测试服务器安装依赖..."
ssh "$SERVER_HOST" "cd $SERVER_PATH && npm install --omit=dev"

echo ""
echo "🗄️ 停写、备份并校验数据库..."
ssh "$SERVER_HOST" "DB_PATH='$DB_PATH' BACKUP_PATH='$BACKUP_PATH' SERVER_PATH='$SERVER_PATH' PM2_APP='$PM2_APP' bash -s" <<'REMOTE_DB'
set -e
mkdir -p "$(dirname "$DB_PATH")" "$BACKUP_PATH"
pm2 stop "$PM2_APP" >/dev/null 2>&1 || true
cd "$SERVER_PATH"
if [ -f "$DB_PATH" ]; then
  SNAPSHOT="$BACKUP_PATH/pokerdojo-predeploy-$(date +%Y%m%d-%H%M%S).sqlite"
  node scripts/backup-sqlite.js "$DB_PATH" "$SNAPSHOT"
  POKER_DB_PATH="$DB_PATH" node scripts/migrate-sqlite.js
else
  test -f data.json || { echo '❌ 首次切换缺少 data.json，拒绝创建空数据库'; exit 1; }
  IMPORT_DB="$DB_PATH.importing-$(date +%Y%m%d-%H%M%S)-$$"
  node scripts/migrate-json-to-sqlite.js --database "$IMPORT_DB" --data data.json --hands hands.jsonl --feedback feedback.jsonl
  node scripts/verify-sqlite.js "$IMPORT_DB"
  mv "$IMPORT_DB" "$DB_PATH"
fi
node scripts/verify-sqlite.js "$DB_PATH"
POKER_DB_PATH="$DB_PATH" NODE_ENV=production pm2 restart "$PM2_APP" --update-env ||
  POKER_DB_PATH="$DB_PATH" NODE_ENV=production pm2 start server.js --name "$PM2_APP"
pm2 save
REMOTE_DB

echo ""
echo "✅ 测试部署完成 → $TEST_URL"
