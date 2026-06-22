#!/bin/bash
# 部署脚本：本地代码 → GitHub → 服务器
#
# 用法：
#   bash deploy.sh "commit message"   # 提交 + 推 GitHub + 部署服务器
#   bash deploy.sh                    # 仅同步服务器（跳过 git）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_HOST="Hongkong"                       # 生产服务器（阿里云香港，替代卡顿的深圳）
SERVER_PATH="/root/PokerGame/PokerServer"
PM2_APP="poker"
PUBLIC_URL="http://47.76.61.168:3000"

# Step 1: Git 提交（如果提供了 commit message）
if [ -n "$1" ]; then
    echo "📝 提交并推送到 GitHub..."
    cd "$SCRIPT_DIR"
    git add .
    git commit -m "$1"
    git push
    echo "✅ GitHub 已更新"
else
    echo "⏭️  跳过 git（未提供 commit message）"
fi

# Step 2: 打包源码（排除 node_modules）并上传到服务器
echo ""
echo "🚀 同步代码到服务器..."
DEPLOY_TMP="/tmp/poker_deploy_$$.tar.gz"
cd "$SCRIPT_DIR/PokerServer"
tar czf "$DEPLOY_TMP" $(find . -maxdepth 1 -type f ! -name "data.json" ! -name "hands.jsonl") avatars
scp "$DEPLOY_TMP" "$SERVER_HOST:/tmp/poker_deploy.tar.gz"
ssh "$SERVER_HOST" "cd $SERVER_PATH && tar xzf /tmp/poker_deploy.tar.gz && rm /tmp/poker_deploy.tar.gz"
rm -f "$DEPLOY_TMP"
cd "$SCRIPT_DIR"

# Step 3: 安装依赖（服务器端编译 native 模块）并重启
echo ""
echo "📦 服务器安装依赖..."
ssh "$SERVER_HOST" "cd $SERVER_PATH && npm install --omit=dev"

echo ""
echo "🔄 重启 pm2 进程..."
ssh "$SERVER_HOST" "cd $SERVER_PATH && pm2 restart $PM2_APP --update-env || pm2 start server.js --name $PM2_APP"

echo ""
echo "✅ 部署完成 → $PUBLIC_URL"
