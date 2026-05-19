#!/bin/bash
# 部署脚本：本地代码 → GitHub → 服务器
#
# 用法：
#   bash deploy.sh "commit message"   # 提交 + 推 GitHub + 部署服务器
#   bash deploy.sh                    # 仅同步服务器（跳过 git）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_HOST="Shenzhen"
SERVER_PATH="/root/PokerGame/PokerServer"
PM2_APP="poker"
PUBLIC_URL="http://47.112.8.25:3000"

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

# Step 2: rsync 同步到服务器（排除 node_modules）
echo ""
echo "🚀 同步代码到服务器..."
rsync -av --delete --exclude='node_modules' \
    "$SCRIPT_DIR/PokerServer/" "$SERVER_HOST:$SERVER_PATH/"

# Step 3: 重启 pm2 进程
echo ""
echo "🔄 重启 pm2 进程..."
ssh "$SERVER_HOST" "pm2 restart $PM2_APP"

echo ""
echo "✅ 部署完成 → $PUBLIC_URL"
