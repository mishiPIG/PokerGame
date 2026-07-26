# SQLite 合并后的首次发布操作手册

## 1. 适用范围

本文面向能够登录测试服和生产服务器、操作 PM2、执行部署脚本并处理备份的运维人员。

适用于 `refactor/database` 分支合并到发布分支后的：

1. 第一次从 `data.json`、`hands.jsonl`、`feedback.jsonl` 切换到 SQLite；
2. SQLite 已经上线后的普通版本发布；
3. 发布失败后的检查和恢复。

数据库总设计见 [DESIGN.md](./DESIGN.md)。本文只描述实际发布操作。

## 2. 最重要的区别

第一次 SQLite 发布是“数据源切换”，不是普通重启。

旧版本运行时：

```text
用户和金币 → PokerServer/data.json
已完成牌谱 → PokerServer/hands.jsonl
活跃牌局   → 仅存在旧 Node.js 进程内存
```

新版本运行时：

```text
用户、钱包流水、牌谱、活跃比赛快照 → SQLite
生产数据库 → /root/PokerGame/data/pokerdojo.sqlite
测试数据库 → /home/caoy0d/PokerGame/data/pokerdojo.sqlite
```

首次切换前必须确保没有活跃比赛。旧版进程内的进行中牌局没有 SQLite 快照；在牌局进行中直接发布，会丢失该局尚未结束的内存状态。

## 3. 部署脚本会自动完成什么

根目录的两个脚本已经支持 SQLite：

| 环境 | 本地命令 | PM2 进程 | SQLite 路径 |
|---|---|---|---|
| 测试服 | `bash deploy-test.sh` | `poker-test` | `/home/caoy0d/PokerGame/data/pokerdojo.sqlite` |
| 生产服 | `bash deploy.sh` | `poker` | `/root/PokerGame/data/pokerdojo.sqlite` |

脚本会依次：

1. 执行本地静态检查；
2. 上传代码，但不上传或覆盖服务器数据文件；
3. 在服务器安装生产依赖，包括 `better-sqlite3`；
4. 停止 PM2 进程，冻结数据写入；
5. 如果 SQLite 不存在，从服务器原有 JSON/JSONL 导入；
6. 如果 SQLite 已存在，先创建 SQLite Online Backup，再执行 Schema Migration；
7. 执行完整性和外键检查；
8. 使用正确的 `POKER_DB_PATH` 和 `NODE_ENV=production` 启动 PM2；
9. 执行 `pm2 save`。

任何导入、迁移或校验步骤失败，脚本都会停止，且不会带着不确定的数据继续启动服务。此时 PM2 可能保持 stopped，这是预期的故障保护。

首次导入先写入带 `.importing-*` 后缀的临时数据库。只有全部旧数据导入并校验成功后，脚本才会把它原子改名为正式 `pokerdojo.sqlite`。导入中途失败不会留下一个被误认为可用的正式数据库。

## 4. 合并后的发布顺序

必须先测试服，验收通过后再生产服：

```text
合并分支
→ 本地完整检查
→ 测试服首次迁移
→ 功能与崩溃恢复验收
→ 安排生产维护窗口
→ 备份生产旧文件并保存异地副本
→ 生产首次迁移
→ 数据与业务验收
→ 更新定时备份
```

## 5. 合并后、本地发布前检查

在仓库根目录执行：

```bash
git status
git log -5 --oneline

cd PokerServer
npm install
npm test
npm run check
cd ..
```

要求：

- 工作区没有不明确的未提交修改；
- SQLite 重构提交已经位于当前发布分支；
- 测试全部通过；
- 静态检查通过；
- 本地能正常安装 `better-sqlite3`。

如果代码已经合并并提交，部署时建议使用无参数形式：

```bash
bash deploy-test.sh
bash deploy.sh
```

不要为了发布而随意使用 `bash deploy.sh "message"`。带参数形式会执行 `git add .`、提交并推送，可能把无关修改一起提交；只有明确需要提交当前全部改动时才使用。

## 6. 第一步：测试服首次迁移

### 6.1 确认测试服没有活跃牌局

在客户端确认测试服大厅没有正在进行的比赛，并通知测试人员暂停创建新房间。

旧版服务没有持久化活跃牌局，因此不能跳过这一步。

### 6.2 检查旧数据文件

```bash
ssh 5090
cd /home/caoy0d/PokerGame/PokerServer

test -f data.json
test -f hands.jsonl
ls -lh data.json hands.jsonl feedback.jsonl 2>/dev/null
awk 'NF { n++ } END { print n+0 }' hands.jsonl
```

记下旧 `hands.jsonl` 的非空行数，发布后应与数据库 `hands` 数量一致。

### 6.3 执行测试服部署

回到本机仓库根目录：

```bash
bash deploy-test.sh
```

首次运行时，脚本会创建：

```text
/home/caoy0d/PokerGame/data/pokerdojo.sqlite
```

### 6.4 验证测试服数据库与进程

```bash
ssh 5090
cd /home/caoy0d/PokerGame/PokerServer

node scripts/verify-sqlite.js /home/caoy0d/PokerGame/data/pokerdojo.sqlite
pm2 status poker-test
pm2 logs poker-test --lines 100 --nostream
```

必须满足：

- `integrity` 为 `ok`；
- `foreignKeyErrors` 为空数组；
- `counts.users` 与旧用户数一致；
- `counts.hands` 与旧 `hands.jsonl` 非空行数一致；
- PM2 状态为 `online`；
- 日志没有 `DATABASE_NOT_FOUND`、Migration、SQLite 或恢复失败错误。

### 6.5 测试服业务验收

至少完成：

1. 旧账号用户名登录；
2. 邮箱登录；
3. 检查金币、头像、管理员权限和站内消息；
4. 查询旧牌谱和生涯统计；
5. 创建现金桌，完成买入、补码、至少一手牌和兑出；
6. 创建 SNG，完成报名、结束和派奖；
7. 验证签到只增加一次金币；
8. 提交反馈并确认可查询；
9. 检查新完成牌谱使 `counts.hands` 增加。

### 6.6 测试服重启恢复验收

创建一桌测试牌局，进行到翻牌或转牌后执行：

```bash
ssh 5090
pm2 restart poker-test
pm2 logs poker-test --lines 100 --nostream
```

玩家重新连接后检查：

- 房间和座位仍存在；
- 筹码、底池、下注、公共牌、底牌和行动位一致；
- 对手底牌没有泄露；
- 行动计时器继续工作；
- 同一手没有重复写入；
- 买入、兑出或派奖没有重复记账。

测试服以上项目未通过，不得继续生产发布。

## 7. 第二步：生产首次迁移

### 7.1 安排维护窗口

选择没有活跃牌局的时间，提前通知用户。维护窗口开始后：

1. 禁止创建新比赛；
2. 等待现有比赛自然结束或明确取消；
3. 确认大厅没有活跃比赛；
4. 再执行备份和发布。

不要在旧版仍有活跃比赛时依赖 `pm2 restart`；旧版的内存牌局无法迁移。

### 7.2 在生产机保存旧文件快照

```bash
ssh Hongkong
cd /root/PokerGame/PokerServer

test -f data.json
test -f hands.jsonl

cutover_time=$(date +%Y%m%d-%H%M%S)
cutover_dir="/root/PokerGame/backups/legacy-pre-sqlite-$cutover_time"
mkdir -p "$cutover_dir"
cp -p data.json hands.jsonl "$cutover_dir/"
if [ -f feedback.jsonl ]; then cp -p feedback.jsonl "$cutover_dir/"; fi

ls -lh "$cutover_dir"
awk 'NF { n++ } END { print n+0 }' hands.jsonl
```

记录：

- `data.json` 大小和修改时间；
- `hands.jsonl` 非空行数；
- `feedback.jsonl` 是否存在；
- 维护窗口开始时间。

随后从本机下载一份异地副本。以下命令在本机执行，将实际目录名替换为刚才生成的目录：

```bash
scp -r Hongkong:/root/PokerGame/backups/legacy-pre-sqlite-YYYYMMDD-HHMMSS backups_offsite/
```

确认异地副本存在后再继续。

### 7.3 执行生产部署

在本机仓库根目录执行：

```bash
bash deploy.sh
```

首次发布时脚本会：

- 停止 `poker`；
- 从服务器原有 `data.json`、`hands.jsonl`、`feedback.jsonl` 导入；
- 创建 `/root/PokerGame/data/pokerdojo.sqlite`；
- 校验数据库；
- 设置 `POKER_DB_PATH=/root/PokerGame/data/pokerdojo.sqlite`；
- 启动并保存 PM2 配置。

### 7.4 验证生产数据库

```bash
ssh Hongkong
cd /root/PokerGame/PokerServer

node scripts/verify-sqlite.js /root/PokerGame/data/pokerdojo.sqlite
ls -lh /root/PokerGame/data/pokerdojo.sqlite*
pm2 status poker
pm2 logs poker --lines 150 --nostream
```

数据库目录中可能同时看到：

```text
pokerdojo.sqlite
pokerdojo.sqlite-wal
pokerdojo.sqlite-shm
```

这是 WAL 模式的正常状态。不要只复制、删除或替换其中一个文件。

必须确认：

- `integrity: "ok"`；
- `foreignKeyErrors: []`；
- 用户数、消息数、牌谱数和反馈数符合迁移前记录；
- `hands` 与旧 `hands.jsonl` 非空行数一致；
- PM2 为 `online`；
- 日志显示正常启动，没有数据库或恢复错误。

### 7.5 生产业务抽查

使用普通账号和管理员账号分别检查：

1. 用户名和邮箱登录；
2. 用户金币、头像、签到状态和消息；
3. 管理员接口；
4. 最近牌谱和生涯统计；
5. 创建一桌短测试局并完成一手；
6. 数据库 `hands` 增加 1；
7. 测试局正常兑出或结束，金币流水正确。

重新检查：

```bash
ssh Hongkong
cd /root/PokerGame/PokerServer
node scripts/verify-sqlite.js /root/PokerGame/data/pokerdojo.sqlite
```

旧 `data.json`、`hands.jsonl`、`feedback.jsonl` 暂时保留，不删除、不再作为事实来源。

## 8. SQLite 上线后的普通发布

第一次迁移成功后，后续发布仍使用：

```bash
bash deploy-test.sh
bash deploy.sh
```

此时部署脚本检测到 SQLite 已存在，会自动：

1. 停止 PM2；
2. 使用 SQLite Online Backup API创建：

   ```text
   /root/PokerGame/backups/pokerdojo-predeploy-YYYYMMDD-HHMMSS.sqlite
   ```

3. 校验备份；
4. 执行新 Schema Migration；
5. 验证数据库完整性；
6. 重启 PM2；
7. 从数据库恢复尚未结束的比赛。

普通发布前仍建议避开关键比赛时段。新版本虽然支持恢复活跃牌局，但版本间状态格式发生重大变化时，维护窗口更容易排障。

## 9. 发布失败怎么处理

### 9.1 脚本在停止 PM2 后失败

先不要手工强制启动服务，也不要设置 `POKER_ALLOW_CREATE_DB=1`。

检查：

```bash
ssh Hongkong
pm2 status poker
cd /root/PokerGame/PokerServer
ls -lh /root/PokerGame/data/
ls -lht /root/PokerGame/backups/ | head
node scripts/verify-sqlite.js /root/PokerGame/data/pokerdojo.sqlite
```

根据部署输出修复明确问题，例如：

- 旧 `data.json` 缺失；
- `hands.jsonl` 有坏 JSON 行；
- 磁盘空间不足；
- `better-sqlite3` 安装失败；
- SQLite 完整性或外键检查失败。

修复后重新运行同一个部署脚本。首次导入失败时可能留下带 `.importing-*` 后缀的诊断文件，但不会替换正式数据库；不要把该临时文件手工改名为正式库。旧文件导入也会记录来源 SHA-256，相同来源在同一导入库内不会重复写入。

### 9.2 新版本无法启动

查看：

```bash
pm2 logs poker --lines 200 --nostream
pm2 describe poker
```

生产模式找不到指定数据库时会报 `DATABASE_NOT_FOUND` 并拒绝创建空库。此时应恢复正确的 `POKER_DB_PATH` 或数据库文件，不能通过允许创建空库来绕过。

### 9.3 数据校验不一致

保持服务停止，保留：

- 当前 SQLite 及 WAL/SHM；
- 部署前 SQLite 备份；
- 首次切换前的 JSON/JSONL 快照；
- 部署日志和 PM2 日志。

不要手工编辑数据库余额或删除重复记录。先比较迁移报告、旧文件行数和数据库计数，再决定重新导入或恢复备份。

## 10. 回滚原则

### 10.1 尚未产生任何 SQLite 新数据

如果首次启动后尚无新注册、金币变化或新牌谱，可以：

1. 停止 PM2；
2. 保留当前 SQLite；
3. 部署合并前的旧代码；
4. 使用首次切换前保存的 JSON/JSONL 快照；
5. 启动旧版本并复核。

### 10.2 SQLite 已经产生新数据

不能直接切回旧文件，否则会丢失切换后的用户、金币和牌谱。

先停服并导出最新 SQLite：

```bash
cd /root/PokerGame/PokerServer
rollback_dir="/root/PokerGame/backups/sqlite-export-$(date +%Y%m%d-%H%M%S)"

node scripts/backup-sqlite.js \
  /root/PokerGame/data/pokerdojo.sqlite \
  "$rollback_dir.sqlite"

node scripts/export-sqlite-to-legacy.js \
  --database /root/PokerGame/data/pokerdojo.sqlite \
  --output "$rollback_dir"
```

核对导出的用户、金币、消息、牌谱和反馈后，才能部署旧代码并替换旧格式数据。该操作属于应急数据回滚，必须全程停服并保留 SQLite 原件。

## 11. 上线后必须调整备份

旧的定时任务如果仍只备份：

```text
data.json
hands.jsonl
feedback.jsonl
```

它已经不能保护上线后的新数据。

必须改为调用：

```bash
cd /root/PokerGame/PokerServer
node scripts/backup-sqlite.js \
  /root/PokerGame/data/pokerdojo.sqlite \
  /root/PokerGame/backups/pokerdojo-manual.sqlite
```

实际 cron 应使用带小时或日期的目标文件名，并配置：

- 本机小时快照；
- 异地每日副本；
- 最近 24 份小时备份；
- 最近 30 份每日备份；
- 定期运行 `verify-sqlite.js`；
- 每月至少一次从备份文件真实恢复演练。

`secret.key` 和 `mail.json` 仍需单独安全迁移，但不能放入 Git 或公开数据库备份。

## 12. 发布完成检查表

测试服：

- [ ] 无活跃牌局时完成首次迁移
- [ ] 数据库完整性和外键检查通过
- [ ] 旧用户、金币、消息和牌谱数量一致
- [ ] 现金桌和 SNG 经济流程通过
- [ ] 中途重启后牌局恢复通过

生产服：

- [ ] 维护窗口已经开始
- [ ] 没有旧版活跃牌局
- [ ] JSON/JSONL 本机快照已保存
- [ ] 异地副本已下载并确认
- [ ] `bash deploy.sh` 成功
- [ ] SQLite 数据计数与旧文件一致
- [ ] PM2 online，日志无数据库错误
- [ ] 普通账号和管理员账号抽查通过
- [ ] 新手牌和金币流水正常写入
- [ ] 旧文件保留但不再写入
- [ ] 定时备份已切换为 SQLite Online Backup
