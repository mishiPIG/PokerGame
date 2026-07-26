# SQLite 本机验证与旧牌谱导入

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

## 2. 先演练旧文件导入（不改任何文件）

旧文件名是 `data.json` 和 `hands.jsonl`，不是 `hands.json`。先跑干运行：

```bash
npm run db:import-legacy -- --dry-run \
  --data data.json \
  --hands hands.jsonl \
  --feedback feedback.jsonl
```

它会输出旧数据将导入的用户、消息、牌谱、参与者和动作数量，以及 SQLite 完整性检查结果；`--dry-run` 使用临时内存数据库，不会修改 `.local` 的数据库。

## 3. 正式导入到单独的本机测试库

确认第 2 步的数量无误后，先导入一个新的、单独的数据库文件：

```bash
mkdir -p .local/import-tests

npm run db:import-legacy -- \
  --database .local/import-tests/from-json-20260726.sqlite \
  --data data.json \
  --hands hands.jsonl \
  --feedback feedback.jsonl

npm run db:verify -- .local/import-tests/from-json-20260726.sqlite
```

导入会同时导入用户、消息、牌谱和反馈，且是幂等的：同一份未改变的源文件再次运行会显示 `alreadyImported: true`，不会重复增加手数或重复扣/发金币。

不要把旧文件直接导入一个已经有用户的新库，例如正在使用的 `.local/pokerdojo.sqlite`。用户 UUID 或用户名重复时，工具会中止，以免把两个不同时点的数据混在一起。要测试导入请使用新的空文件；首次正式切换也应使用尚未创建的生产数据库路径。

不要在旧版服务仍运行、还会继续写 `data.json`/`hands.jsonl` 时做“最终生产导入”。生产首次切换应使用根目录 `deploy.sh` 的维护窗口流程：它会先停写、备份、导入、校验，再启动新版本。
