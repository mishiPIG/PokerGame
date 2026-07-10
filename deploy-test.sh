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
PM2_APP="poker-test"
TEST_URL="http://10.76.106.91:3000"

# Step 1: 打包源码（排除 node_modules 和 data.json，避免覆盖服务器测试数据）
echo "🚀 同步代码到测试服务器（5090）..."
DEPLOY_TMP="/tmp/poker_test_$$.tar.gz"
cd "$SCRIPT_DIR/PokerServer"
tar czf "$DEPLOY_TMP" $(find . -maxdepth 1 -type f ! -name 'data.json' ! -name 'hands.jsonl' ! -name 'secret.key' ! -name 'mail.json') avatars
scp "$DEPLOY_TMP" "$SERVER_HOST:/tmp/poker_test.tar.gz"
ssh "$SERVER_HOST" "cd $SERVER_PATH && tar xzf /tmp/poker_test.tar.gz && rm /tmp/poker_test.tar.gz"
rm -f "$DEPLOY_TMP"
cd "$SCRIPT_DIR"

# Step 2: 安装依赖并重启
echo ""
echo "📦 测试服务器安装依赖..."
ssh "$SERVER_HOST" "cd $SERVER_PATH && npm install --omit=dev"

echo ""
echo "🔄 重启 pm2 进程（$PM2_APP）..."
ssh "$SERVER_HOST" "cd $SERVER_PATH && pm2 restart $PM2_APP --update-env || pm2 start server.js --name $PM2_APP"

echo ""
echo "✅ 测试部署完成 → $TEST_URL"
