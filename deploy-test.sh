#!/bin/bash
# 测试部署脚本：本地代码 → 实验室 5090 测试服务器（沙特，内网 10.76.106.91）
#
# 用途：日常开发测试。正式发布走 deploy.sh（AWS 生产）。
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
# 打包的是【工作区文件】而不是某个 commit：工作区有没提交的改动时，
# 光写 HEAD 的 SHA 等于谎报「线上跑的就是这个 commit」。带上 -dirty，事后才追得清。
if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain -- PokerServer)" ]; then BUILD_SHA="$BUILD_SHA-dirty.$(date +%H%M%S)"; fi
# ↑ 带上部署时刻：没提交就连着部署好几次时，构建号原来每次都一样（同一个 HEAD + -dirty），
#   前端「你缓存了旧版」的检测就比不出新旧 —— 2026-11-17 验收时玩家拿着旧前端测了半天，检测一声没吭。
BUILD_AT="$(date '+%Y-%m-%d %H:%M:%S')"
# 先 cd 再用相对路径 require：Git Bash 下把 $SCRIPT_DIR 直接塞进 require() 会因 POSIX 路径解析失败
APP_VERSION="$(cd "$SCRIPT_DIR/PokerServer" && node -p "require('./package.json').version")"
echo "🏷️  版本 $APP_VERSION · $BUILD_SHA · $BUILD_AT"
cat > "$SCRIPT_DIR/PokerServer/build-info.json" <<BUILDJSON
{ "commit": "$BUILD_SHA", "builtAt": "$BUILD_AT", "env": "$BUILD_ENV" }
BUILDJSON
# 占位符不在的话下面的 sed 会【静默不替换】，前端构建号就冻死在旧值（deploy.sh 同一道检查）
if ! grep -q "const CLIENT_BUILD = '__BUILD__'" "$SCRIPT_DIR/PokerServer/public/js/00-state.js"; then
    echo "❌ 00-state.js 里找不到 __BUILD__ 占位符，先改回 const CLIENT_BUILD = '__BUILD__' 再部署。"
    exit 1
fi
# 前端构建号：把 00-state.js 里的占位替换成真实 SHA（打包用的临时副本，改完还原）
STATE_BAK="$(mktemp -t poker_state.XXXXXX)"
cp "$SCRIPT_DIR/PokerServer/public/js/00-state.js" "$STATE_BAK"
# 只替换那个常量本身，别顺手把注释里提到的同名占位也改了
sed -i "s/const CLIENT_BUILD = '__BUILD__'/const CLIENT_BUILD = '$BUILD_SHA'/" "$SCRIPT_DIR/PokerServer/public/js/00-state.js"
restore_build_stamp() { cp "$STATE_BAK" "$SCRIPT_DIR/PokerServer/public/js/00-state.js"; rm -f "$STATE_BAK"; }
trap restore_build_stamp EXIT



# Step 2: 打包 —— 只打 git 里有的源码（含还没提交的新文件），不打测试和运行时数据
# 原来是「目录里的文件全打、再排除几个数据文件」：41 个测试文件跟着上了生产，
# 以后谁在 PokerServer/ 根目录随手放个文件也会被带上去。
echo ""
echo "🚀 打包并上传..."
DEPLOY_TMP="$(mktemp -t poker_deploy.XXXXXX).tar.gz"
LIST_TMP="$(mktemp -t poker_files.XXXXXX)"
cd "$SCRIPT_DIR/PokerServer"
git ls-files --cached --others --exclude-standard -- . \
    | grep -v '\.test\.js$' | grep -v '^\.eslintrc' \
    | while read -r f; do [ -e "$f" ] && echo "$f"; done > "$LIST_TMP"
echo "build-info.json" >> "$LIST_TMP"
tar czf "$DEPLOY_TMP" -T "$LIST_TMP"
echo "   $(wc -l < "$LIST_TMP") 个文件"
scp -q "$DEPLOY_TMP" "$SERVER_HOST:/tmp/poker_deploy_$PM2_APP.tar.gz"
rm -f "$DEPLOY_TMP" "$LIST_TMP"
cd "$SCRIPT_DIR"

# Step 3: 服务器端：临时目录里装好依赖 → 在线备份 → 停机几秒切换 → 校验快照
# 具体步骤见 PokerServer/scripts/deploy-remote.sh（两个部署脚本共用）
ssh "$SERVER_HOST" "set -e; STAGE=\$(mktemp -d /tmp/poker_stage.XXXXXX); tar xzf /tmp/poker_deploy_$PM2_APP.tar.gz -C \$STAGE; rm -f /tmp/poker_deploy_$PM2_APP.tar.gz; \
    SERVER_PATH='$SERVER_PATH' DB_PATH='$DB_PATH' BACKUP_PATH='$BACKUP_PATH' PM2_APP='$PM2_APP' bash \$STAGE/scripts/deploy-remote.sh \$STAGE"

# Step 4: 发版后自查错误日志（2026-08-10 加）
# 连着三个经济漏洞（边池分钱、straddle 少扣、补码白拿）里，有两个是【部署后翻 error.log】
# 才发现的——玩家自己不会报，「点了没反应」「补不上码」他们只当是自己的问题。
# 筹码守恒审计也抓不到这类：钱没凭空多，只是分错人；或者漏的是金币、根本不在牌谱里。

# 版本核对：不再靠 grep 关键字猜，直接问服务器它是哪一版
echo ""
echo "🏷️  线上版本核对..."
# 刚 pm2 restart 完进程可能还没开始监听：重试几次，别把「还没起来」误报成「版本对不上」
LIVE=$(ssh "$SERVER_HOST" "curl -s --retry 6 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/version")
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
BEFORE=$(cat "/tmp/poker_errsize_$PM2_APP" 2>/dev/null || echo unknown)
if ! printf '%s' "$BEFORE" | grep -qE '^[0-9]+$'; then
  echo "   （重启前没取到错误日志基准，这次跳过比对——不猜，免得把历史日志当成新错误）"
  exit 0
fi
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
