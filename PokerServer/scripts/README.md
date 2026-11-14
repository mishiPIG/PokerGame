# SQLite 本机验证与备份

以下命令都在 `PokerServer/` 目录执行。

## 先理解两类数据

- `hands` 表：已经结束并确认写入牌谱的每一手；`hands` 的行数就是已完成手数。
- `matches` / `active_match_states` 表：正在等待、进行中或等待恢复的比赛快照，不计入 `hands`。

因此，查询 `SELECT count(*) FROM hands` 不会把正在进行的一局算进去。

## 1. 查看本机数据库状态

本机默认数据库是 `.local/pokerdojo.sqlite`：

```bash
npm run db:verify
```

输出中应看到：

- `integrity: "ok"`；
- `foreignKeyErrors: []`；
- `counts.hands` 为已完成手数；
- `counts.active_match_states` 为可恢复的活跃牌局快照数。

## 2. 备份与恢复

```bash
npm run db:backup -- <源库> <备份文件>     # SQLite 在线备份：服务运行中也能得到一致的快照
npm run db:verify -- <备份文件>           # 打开备份本身做完整性 / 外键 / 行数检查
```

⚠️ WAL 模式下**不能直接复制主库文件**当备份（会得到损坏或不完整的快照，平时还看不出来）。
生产每天的备份由 `backup-cron.sh` 用同一套脚本完成，并且备份完立刻校验备份文件本身。

## 旧 JSON 数据

`data.json` / `hands.jsonl` 时代的导入、导出脚本已于 2026-11-14 删除：
SQLite 自 2026-08-08 起稳定运行，旧数据早已全部导入，回退到 JSON 的窗口已经关闭。
需要追溯时，到 git 历史里找 `scripts/migrate-json-to-sqlite.js`。
