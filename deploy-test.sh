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

BUILD_ENV="test"
# Step 1.5: 打版本戳（2026-08-11 加）
# 以前确认「这次部署到底生效没有」只能 SSH 上去 grep 某个新增关键字，又土又容易看走眼。
# 现在把 版本号 + git 短 SHA + 构建时间 打进包里，最后一步 curl /api/version 直接核对。
# ⚠️ 版本号本身只在【上生产】时才手动涨（改 PokerServer/package.json 的 version），
#    测试服部署不涨号 —— 否则号涨得毫无意义。判定按玩家视角：
#      主=大改版 / 次=新功能 / 修订=修 bug。
BUILD_SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"
BUILD_AT="$(date '+%Y-%m-%d %H:%M:%S')"
# 先 cd 再用相对路径 require：Git Bash 下把 $SCRIPT_DIR 直接塞进 require() 会因 POSIX 路径解析失败
APP_VERSION="$(cd "$SCRIPT_DIR/PokerServer" && node -p "require('./package.json').version")"
echo "🏷️  版本 $APP_VERSION · $BUILD_SHA · $BUILD_AT"
cat > "$SCRIPT_DIR/PokerServer/build-info.json" <<BUILDJSON
{ "commit": "$BUILD_SHA", "builtAt": "$BUILD_AT", "env": "$BUILD_ENV" }
BUILDJSON
# 前端构建号：把 00-state.js 里的占位替换成真实 SHA（打包用的临时副本，改完还原）
cp "$SCRIPT_DIR/PokerServer/public/js/00-state.js" /tmp/00-state.orig.js
# 只替换那个常量本身，别顺手把注释里提到的同名占位也改了
sed -i "s/const CLIENT_BUILD = '__BUILD__'/const CLIENT_BUILD = '$BUILD_SHA'/" "$SCRIPT_DIR/PokerServer/public/js/00-state.js"
restore_build_stamp() { cp /tmp/00-state.orig.js "$SCRIPT_DIR/PokerServer/public/js/00-state.js"; }
trap restore_build_stamp EXIT



# Step 1: 打包源码（排除 node_modules 和 data.json，避免覆盖服务器测试数据）
echo "🚀 同步代码到测试服务器（5090）..."
DEPLOY_TMP="/tmp/poker_test_$$.tar.gz"
cd "$SCRIPT_DIR/PokerServer"
tar czf "$DEPLOY_TMP" $(find . -maxdepth 1 -type f ! -name 'data.json*' ! -name 'hands.jsonl' ! -name 'secret.key' ! -name 'mail.json' ! -name 'feedback.jsonl') avatars scripts src public tools
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
# 记下错误日志当前大小：Step 4 只读【这之后】新增的部分（比事后猜时间/过滤关键字都准）
ssh "$SERVER_HOST" "PM2_APP='$PM2_APP' bash -s" <<'REMOTE_ERRMARK'
ERRLOG=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['pm2_env']['pm_err_log_path'] for x in d if x['name']=='$PM2_APP'][0])" 2>/dev/null)
if [ -n "$ERRLOG" ] && [ -f "$ERRLOG" ]; then wc -c < "$ERRLOG" > "/tmp/poker_errsize_$PM2_APP"; else echo 0 > "/tmp/poker_errsize_$PM2_APP"; fi
REMOTE_ERRMARK

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

# Step 4: 发版后自查错误日志（2026-08-10 加）
# 连着三个经济漏洞（边池分钱、straddle 少扣、补码白拿）里，有两个是【部署后翻 error.log】
# 才发现的——玩家自己不会报，「点了没反应」「补不上码」他们只当是自己的问题。
# 筹码守恒审计也抓不到这类：钱没凭空多，只是分错人；或者漏的是金币、根本不在牌谱里。

# 版本核对：不再靠 grep 关键字猜，直接问服务器它是哪一版
echo ""
echo "🏷️  线上版本核对..."
LIVE=$(ssh "$SERVER_HOST" "curl -s http://127.0.0.1:3000/api/version")
LIVE_SHA=$(node -p "try{JSON.parse(process.argv[1]).commit}catch(e){''}" "$LIVE" 2>/dev/null)
if [ "$LIVE_SHA" = "$BUILD_SHA" ]; then
  echo "   ✅ 线上已是本次构建：$(node -p "JSON.parse(process.argv[1]).label" "$LIVE" 2>/dev/null)"
else
  echo "   ⚠️ 线上版本对不上！期望 $BUILD_SHA，实际返回：$LIVE"
fi

echo ""
echo "🩺 发版后错误日志自查（只看重启之后新增的部分）..."
ssh "$SERVER_HOST" "PM2_APP='$PM2_APP' bash -s" <<'REMOTE_ERRCHK'
sleep 12
ERRLOG=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['pm2_env']['pm_err_log_path'] for x in d if x['name']=='$PM2_APP'][0])" 2>/dev/null)
if [ -z "$ERRLOG" ] || [ ! -f "$ERRLOG" ]; then
  echo "   （找不到 $PM2_APP 的错误日志，跳过）"
  exit 0
fi
BEFORE=$(cat "/tmp/poker_errsize_$PM2_APP" 2>/dev/null || echo 0)
# 从重启前记下的字节位置往后读；再滤掉部署自己造成的 [shutdown] signal=（pm2 stop/restart 的正常输出）
NEW=$(tail -c "+$((BEFORE + 1))" "$ERRLOG" 2>/dev/null | grep -v '^\[shutdown\] signal=' | grep -v '^[[:space:]]*$' | tail -30)
if [ -z "$NEW" ]; then
  echo "   ✅ 重启之后没有新的错误输出"
else
  echo "   ⚠️ 重启之后有错误输出 —— 先看明白再收工："
  printf '%s
' "$NEW" | sed 's/^/      /'
fi
REMOTE_ERRCHK

echo ""
echo "✅ 测试部署完成 → $TEST_URL"
