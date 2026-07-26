# SQLite 持久化与牌局恢复重构设计

## 实施状态

本文档记录“德扑道场 Poker Dojo”从当前文件存储迁移到 SQLite，并使活跃牌局具备崩溃恢复能力的目标设计。

截至 2026-07-26，`refactor/database` 分支已完成代码实现，尚未部署到测试服或生产服：

- 用户、钱包流水、签到、消息、反馈和牌谱已经统一接入 SQLite；
- 活跃比赛按确认操作保存版本化快照，启动时恢复 `runtime.roomGames`；
- Deck、Card、Set、行动计时、涨盲、训练时长、下一手、Run It、Straddle 和留座期限均可恢复；
- 买入、补码、兑出、退款、派奖、签到和管理员调账使用事务与幂等键；
- 已完成牌谱和最终牌局状态在同一 SQLite 事务提交；
- 提供旧 JSON/JSONL 幂等导入、完整性校验、一致性在线备份和回滚导出工具；
- 部署脚本会停写、备份、迁移、校验后再启动；生产缺库时拒绝静默创建空库；
- 自动化测试已覆盖 Repository、旧数据迁移、快照重启恢复、钱包重放、牌谱原子提交以及备份恢复往返；
- 首次测试服和生产服切换仍必须按第 16 节在维护窗口执行，部署后再做真实 PM2 故障注入和长时间运行观察。

本文档同时作为实现约束、部署手册和验收清单。代码完成不等于生产切换完成；未经过维护窗口迁移、备份恢复演练和真实 PM2 重启验收前，不得删除旧文件。

## 1. 背景

### 1.1 当前持久化方式

当前存在三类文件数据：

1. `data.json`
   - 用户账号；
   - 邮箱；
   - 密码哈希；
   - 金币余额；
   - 头像；
   - 管理员标记；
   - 最后签到日期和连续签到天数；
   - 站内消息数组。
2. `hands.jsonl`
   - 每手牌一行 JSON；
   - 包含模式、房间、时间戳、座位、底牌、动作、思考时间、公共牌和结果；
   - 只在一手牌完整结束时追加。
3. `feedback.jsonl`
   - 每条用户反馈一行 JSON。

当前 `database.js` 对 `data.json` 的修改方式是：

```text
读取整个文件
→ JSON.parse
→ 修改内存对象
→ JSON.stringify 整个对象
→ writeFileSync 覆盖整个文件
```

查询只读取，不会自动重写；但修改任意一个用户的金币、头像、密码、邮箱、签到或消息，都会重写整个 `data.json`。

`hands.jsonl` 和 `feedback.jsonl` 写入时只追加，不重写；但查询牌谱和统计时需要同步读取并扫描整个文件。

### 1.2 当前活跃牌局方式

所有活跃比赛都保存在：

```js
runtime.roomGames = {};
```

每个 `roomGames[roomId]` 同时包含：

- 房间配置；
- 玩家和座位；
- 玩家当前筹码；
- 当前阶段；
- 底池和下注；
- 庄位与行动位；
- 底牌与公共牌；
- 剩余牌堆；
- Run It 和 Straddle 状态；
- 升盲、比赛、行动、留座等计时器；
- 当前尚未完成的手牌历史；
- 站起、坐出、离开和比赛排名的临时状态。

这些内容不会在进程启动时从任何持久化介质恢复。

### 1.3 当前故障后果

当 Node 进程崩溃或部署执行 `pm2 restart` 时：

- 已完成并追加到 `hands.jsonl` 的牌谱仍然存在；
- 当前尚未结束的一手牌完全丢失；
- 所有活跃房间和比赛状态丢失；
- 玩家当前桌上筹码丢失；
- 现金桌无法执行正常兑出；
- SNG 无法继续升盲、淘汰和派奖；
- 已从用户余额扣除的买入金币不会因为进程重启自动退还。

最危险的断层是：

```text
买入金币已持久化扣除
但对应桌上筹码只存在内存
```

因此，PM2 只能恢复“服务可访问”，不能恢复“比赛和资产连续”。

## 2. 重构目标

本次重构需要同时实现以下目标。

### 2.1 数据完整性

- 不再通过整文件覆盖保存用户数据；
- 数据库损坏或解析失败时不得静默返回空用户库；
- 用户、金币、消息、签到、反馈和牌谱使用明确的数据约束；
- 所有关键数据可以一致备份、迁移和校验。

### 2.2 金币安全

- 每次金币变化必须有不可变流水；
- 买入、补码、兑出、退款、派奖和签到必须使用数据库事务；
- 同一业务操作重复执行时不能重复扣款或重复发钱；
- 可以查询任意一笔余额为何变化；
- 即使比赛快照损坏，也能找到所有未结算买入并人工或自动处理。

### 2.3 牌局恢复

- 内存仍作为实时游戏工作集，避免每次渲染都从数据库重建；
- SQLite 成为活跃比赛的持久化事实来源；
- 每次关键状态变化后保存可恢复快照；
- 进程启动后可以重建 `roomGames`；
- 玩家重连后可以回到原比赛；
- 计时器根据持久化的绝对截止时间重新建立；
- 完整恢复目标是回到最后一个已确认的操作。

### 2.4 查询性能

- 查询某玩家牌谱不再扫描整个 `hands.jsonl`；
- 支持按玩家、模式、房间和时间倒序查询；
- 保留完整原始牌谱 JSON，满足回放、统计和 AI 训练；
- 同时建立结构化索引，便于后续统计和数据导出。

### 2.5 部署与迁移

- 数据库文件与部署代码分离；
- 普通代码发布不得覆盖生产数据库；
- Schema 迁移可追踪、可重复检查、失败即停止部署；
- 旧 JSON/JSONL 可以一次性、可验证地导入；
- 上线后有明确的备份和回滚方案。

## 3. 非目标

第一版 SQLite 重构不包含：

- 不引入独立 PostgreSQL 服务器；
- 不支持多个 PM2 cluster 实例并发运行同一牌局；
- 不做跨地域高可用；
- 不做读写分离；
- 不把 Redis 作为持久化事实来源；
- 不改变现有 HTTP 路径和 Socket.IO 事件名；
- 不改变德州扑克规则、边池、Run It、Straddle 或判牌算法；
- 不要求首版用 SQL 直接计算全部 VPIP/PFR 等统计；
- 不要求首版把每一个快照字段完全关系化；
- 不长期双写 JSON 和 SQLite；
- 不在数据库中保存 Socket 对象、定时器句柄或其他不可序列化运行时对象。

## 4. 总体架构

目标结构是“内存实时运行 + SQLite 可靠提交 + 启动恢复”：

```text
HTTP / Socket 请求
        │
        ▼
业务校验与状态计算
        │
        ▼
SQLite 事务
├── 用户与金币
├── 比赛参与者与托管
├── 活跃牌局快照
├── 比赛事件
└── 已完成牌谱
        │
        ▼
更新 runtime.roomGames
        │
        ▼
广播客户端
```

进程重启流程：

```text
打开 SQLite
→ 执行 Schema Migration
→ 查询 waiting/running/paused/recovery_needed 比赛
→ 读取最新快照
→ 重建 Deck、Card、Set 和计时器
→ 写入 runtime.roomGames
→ 玩家通过 JWT 重连
→ 按 userId 重新绑定 Socket
→ 私发本人底牌并广播公共状态
```

### 4.1 内存与数据库职责

内存负责：

- 高频游戏计算；
- 行动合法性校验；
- 判牌和边池运算；
- 临时 Socket 连接关系；
- 当前进程内的计时器句柄；
- 广播客户端。

SQLite 负责：

- 用户和金币事实；
- 金币变化流水；
- 比赛身份和生命周期；
- 参与者买入、筹码与结算状态；
- 最新可恢复牌局快照；
- 关键比赛事件审计；
- 已完成牌谱；
- 消息、签到和反馈；
- Schema 版本。

`roomGames` 继续存在，但从“唯一数据源”降级为“可从 SQLite 重建的运行缓存”。

## 5. 技术选型

### 5.1 SQLite

当前系统适合 SQLite，因为：

- 单台服务器、单个 Node 进程；
- 用户和牌谱规模较小；
- 不需要单独购买或维护数据库服务器；
- 支持事务、唯一约束、索引和外键；
- 一个数据库文件便于迁移和备份；
- 当前 `database.js` 使用同步 API，迁移成本较低。

当未来出现以下情况时再评估 PostgreSQL：

- 多个 Node 实例同时处理业务；
- 多台游戏服务器共享用户、金币和比赛；
- 单机写入成为瓶颈；
- 需要数据库级高可用、在线副本或跨机房灾备；
- 后台分析和管理查询显著增加。

### 5.2 Node SQLite 驱动

建议采用提供可靠同步事务 API 的 SQLite 驱动，例如 `better-sqlite3`，原因是当前所有 `db.*` 调用均为同步接口，可以先保持调用形态，避免把认证、Socket 处理器和游戏服务一次性改成异步。

落地前必须在测试服务器确认：

- 生产 Node 版本；
- 驱动与该 Node ABI 的兼容性；
- Ubuntu x86_64 安装是否使用预构建产物；
- `npm install --omit=dev` 是否能稳定完成；
- PM2 启动用户是否有数据库目录读写权限。

### 5.3 SQLite 初始化参数

建议每次打开连接后执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

说明：

- `foreign_keys` 保证关系约束实际生效；
- WAL 提高读写并发和故障恢复能力；
- `synchronous = FULL` 优先保证金币与比赛状态的落盘可靠性；
- `busy_timeout` 防止短暂锁竞争立即失败。

不应通过 PM2 cluster 启动多个共享同一 `roomGames` 和 SQLite 文件的游戏进程。即使 SQLite 能处理一定并发，当前 Socket 房间、计时器和内存状态也不支持多进程一致性。

## 6. 目标目录结构

```text
PokerServer/
├── server.js
├── database.js
├── stats.js
├── package.json
│
├── src/
│   ├── config.js
│   ├── runtime.js
│   │
│   ├── storage/
│   │   ├── sqlite.js
│   │   ├── migrate.js
│   │   ├── user-repository.js
│   │   ├── wallet-repository.js
│   │   ├── message-repository.js
│   │   ├── feedback-repository.js
│   │   ├── hand-repository.js
│   │   ├── match-repository.js
│   │   └── migrations/
│   │       ├── 001-initial.sql
│   │       ├── 002-wallet-ledger.sql
│   │       └── ...
│   │
│   └── persistence/
│       ├── game-serializer.js
│       ├── game-hydrator.js
│       ├── game-persistence-service.js
│       └── recovery-service.js
│
└── scripts/
    ├── migrate-json-to-sqlite.js
    ├── verify-sqlite.js
    ├── backup-sqlite.js
    └── export-sqlite-to-legacy.js
```

`database.js` 暂时保留为兼容门面，继续导出当前方法，内部委托给 repository。这样认证、HTTP 路由和部分非经济调用可以先不修改。

## 7. 数据库文件位置

生产数据库建议放在代码部署目录外：

```text
/root/PokerGame/data/pokerdojo.sqlite
```

测试服建议：

```text
/home/caoy0d/PokerGame/data/pokerdojo.sqlite
```

通过环境变量配置：

```text
POKER_DB_PATH=/root/PokerGame/data/pokerdojo.sqlite
```

原因：

- `deploy.sh` 只覆盖 `PokerServer` 源码，不接触数据库；
- 换服务器时数据目录边界清晰；
- 备份脚本不需要理解代码打包规则；
- 可以单独设置目录权限；
- 避免数据库、WAL 和 SHM 文件被误打包或误提交。

开发环境未配置 `POKER_DB_PATH` 时，可以默认使用：

```text
PokerServer/.local/pokerdojo.sqlite
```

该目录必须加入 `.gitignore`。

## 8. 表结构

时间字段统一使用 Unix epoch 毫秒整数，字段名以 `_at_ms` 结尾。业务主键使用 UUID 文本；SQLite 自增整数只用于纯内部有序事件。

### 8.1 `schema_migrations`

记录已应用的 Schema 版本。

```sql
CREATE TABLE schema_migrations (
    version       INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
);
```

迁移文件必须只执行一次。应用启动可以校验版本，但生产的结构迁移应在部署脚本中显式执行并在失败时中止。

### 8.2 `users`

替代 `data.json.users`。

```sql
CREATE TABLE users (
    id               TEXT PRIMARY KEY,
    username         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email            TEXT COLLATE NOCASE UNIQUE,
    password_hash    TEXT NOT NULL,
    gold             INTEGER NOT NULL DEFAULT 10000 CHECK (gold >= 0),
    avatar           TEXT,
    is_admin         INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    last_checkin     TEXT,
    checkin_streak   INTEGER NOT NULL DEFAULT 0,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    deleted_at_ms    INTEGER
);
```

约束：

- 用户名大小写不敏感唯一；
- 非空邮箱大小写不敏感唯一；
- 金币不得为负；
- 历史用户不物理删除，使用 `deleted_at_ms`；
- 迁移时必须保留原 UUID 和密码哈希，用户无需重设密码。

`users.gold` 保存当前余额，便于快速鉴权和展示；所有余额变化同时写入 `wallet_transactions`。

### 8.3 `wallet_transactions`

记录每一次金币变化，是经济系统的审计事实。

```sql
CREATE TABLE wallet_transactions (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id),
    delta            INTEGER NOT NULL,
    balance_before   INTEGER NOT NULL,
    balance_after    INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    match_id         TEXT,
    hand_id          TEXT,
    operation_key    TEXT NOT NULL UNIQUE,
    metadata_json    TEXT,
    created_at_ms    INTEGER NOT NULL
);

CREATE INDEX idx_wallet_user_time
ON wallet_transactions(user_id, created_at_ms DESC);
```

典型 `transaction_type`：

```text
initial_balance
cash_buyin
cash_rebuy
cash_cashout
sng_entry
sng_refund
sng_prize
checkin_reward
admin_adjust
recovery_refund
```

`operation_key` 是幂等键，示例：

```text
cash-buyin:{matchId}:{userId}:{requestId}
cash-rebuy:{matchId}:{userId}:{requestId}
cash-cashout:{matchId}:{userId}
sng-entry:{matchId}:{userId}
sng-refund:{matchId}:{userId}
sng-prize:{matchId}:{userId}
checkin:{userId}:{yyyy-mm-dd}
admin-adjust:{requestId}
```

同一个业务操作重复到达时，唯一约束必须阻止第二次扣款或发钱。

### 8.4 `daily_checkins`

记录每次签到，而不是只保存用户最后签到日期。

```sql
CREATE TABLE daily_checkins (
    user_id       TEXT NOT NULL REFERENCES users(id),
    checkin_date  TEXT NOT NULL,
    streak        INTEGER NOT NULL,
    reward        INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, checkin_date)
);
```

签到事务必须同时：

1. 插入 `daily_checkins`；
2. 更新 `users.gold`；
3. 更新 `users.last_checkin` 和 `checkin_streak`；
4. 插入 `wallet_transactions`。

重复签到由 `(user_id, checkin_date)` 主键阻止。

### 8.5 `user_messages`

替代用户对象中的 `messages[]`。

```sql
CREATE TABLE user_messages (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    message_type  TEXT NOT NULL,
    text          TEXT NOT NULL,
    is_read       INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_messages_user_read_time
ON user_messages(user_id, is_read, created_at_ms DESC);
```

消息保留策略仍可维持每个用户最近 100 条，但应通过明确清理语句或后台任务完成，不在每次读取时隐式处理。

### 8.6 `feedback`

替代 `feedback.jsonl`。

```sql
CREATE TABLE feedback (
    id            TEXT PRIMARY KEY,
    user_id       TEXT REFERENCES users(id),
    username      TEXT NOT NULL,
    text          TEXT NOT NULL,
    contact       TEXT,
    user_agent    TEXT,
    status        TEXT NOT NULL DEFAULT 'new',
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_feedback_time
ON feedback(created_at_ms DESC);
```

保留用户名快照，避免用户以后改名导致历史反馈失去原始展示值。

### 8.7 `matches`

保存一场训练赛或 SNG 的永久身份和生命周期。

```sql
CREATE TABLE matches (
    id               TEXT PRIMARY KEY,
    room_code        TEXT NOT NULL,
    room_type        TEXT NOT NULL CHECK (room_type IN ('cash', 'sng')),
    status           TEXT NOT NULL,
    owner_user_id    TEXT NOT NULL REFERENCES users(id),
    name             TEXT NOT NULL,
    config_json      TEXT NOT NULL,
    invite_json      TEXT,
    state_version    INTEGER NOT NULL DEFAULT 0,
    started_at_ms    INTEGER,
    scheduled_end_ms INTEGER,
    ended_at_ms      INTEGER,
    created_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL
);

CREATE INDEX idx_matches_status
ON matches(status, updated_at_ms);

CREATE INDEX idx_matches_room_code
ON matches(room_code);
```

不能使用当前六位 `roomId` 作为数据库永久主键，因为房间码只要求在活跃房间中唯一，以后可能重复。`matches.id` 使用 UUID；`room_code` 继续作为玩家看到的邀请码。

建议状态：

```text
waiting
running
paused
finished
cancelled
recovery_needed
```

### 8.8 `match_players`

保存比赛参与者、买入托管、当前筹码和最终结算。

```sql
CREATE TABLE match_players (
    match_id          TEXT NOT NULL REFERENCES matches(id),
    user_id           TEXT NOT NULL REFERENCES users(id),
    username_snapshot TEXT NOT NULL,
    seat               INTEGER,
    player_status      TEXT NOT NULL,
    buyin_gold_total   INTEGER NOT NULL DEFAULT 0,
    buyin_chips_total  INTEGER NOT NULL DEFAULT 0,
    current_chips      INTEGER NOT NULL DEFAULT 0,
    hands_played       INTEGER NOT NULL DEFAULT 0,
    settlement_gold    INTEGER,
    settled_at_ms      INTEGER,
    joined_at_ms       INTEGER NOT NULL,
    left_at_ms         INTEGER,
    PRIMARY KEY (match_id, user_id)
);

CREATE INDEX idx_match_players_unsettled
ON match_players(user_id, settled_at_ms);
```

建议 `player_status`：

```text
seated
vacated
reserved
sitting_out
left
eliminated
settled
```

本表是资金恢复的重要兜底。即使快照无法解析，也能查出：

- 谁为比赛支付过金币；
- 总共支付多少；
- 最后持久化筹码是多少；
- 是否已经结算；
- 是否需要自动退款或人工审计。

### 8.9 `active_match_states`

保存每场活跃比赛最新的完整可恢复快照。

```sql
CREATE TABLE active_match_states (
    match_id      TEXT PRIMARY KEY REFERENCES matches(id),
    state_version INTEGER NOT NULL,
    hand_seq      INTEGER NOT NULL DEFAULT 0,
    phase         TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

保存完整 JSON 是有意的设计：

- 游戏状态字段多且会继续演进；
- 大量字段只用于恢复，不需要单独 SQL 查询；
- 关系表负责身份、资金和常用索引；
- JSON 快照负责精确重建复杂牌局。

快照至少包含：

- `matchId`、`roomId`、房型、状态和配置；
- 玩家、座位、当前筹码、当前下注和累计投入；
- `buttonSeat`、`buttonIdx`、`actionOnIdx`；
- `phase`、`handSeq`、`pot`、`currentBet`；
- 底牌、公共牌、剩余牌堆和 `lastShuffleId`；
- `folded`、`allIn`、`hasActed`、`sittingOut`；
- `vacatedPlayers` 和 `statsHistory`；
- 当前未完成的 `game.hand`；
- 边池相关累计投入；
- Run It、Straddle、暂停、待结束、待涨盲状态；
- 所有需要恢复的绝对截止时间；
- `stateVersion` 和快照格式版本。

### 8.10 `match_events`

记录关键比赛状态变化，供审计和故障定位。

```sql
CREATE TABLE match_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT NOT NULL REFERENCES matches(id),
    state_version INTEGER NOT NULL,
    event_type    TEXT NOT NULL,
    user_id       TEXT,
    payload_json  TEXT,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(match_id, state_version)
);

CREATE INDEX idx_match_events_match
ON match_events(match_id, state_version);
```

事件示例：

```text
match_created
player_seated
cash_buyin
cash_rebuy
hand_started
player_action
community_dealt
hand_settled
player_vacated
player_reconnected
match_finished
match_recovered
```

恢复启动时直接读取 `active_match_states`，不要求从头重放全部事件。`match_events` 的主要作用是审计、调试、比较版本和以后演进为事件溯源。

### 8.11 `hands`

保存已完成手牌的永久主记录。

```sql
CREATE TABLE hands (
    id              TEXT PRIMARY KEY,
    match_id        TEXT NOT NULL REFERENCES matches(id),
    room_code       TEXT NOT NULL,
    hand_seq        INTEGER NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('cash', 'sng')),
    started_at_ms   INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    sb              INTEGER NOT NULL,
    bb              INTEGER NOT NULL,
    ante            INTEGER NOT NULL DEFAULT 0,
    button_user_id  TEXT,
    community_json  TEXT,
    payload_json    TEXT NOT NULL,
    UNIQUE(match_id, hand_seq)
);

CREATE INDEX idx_hands_match_seq
ON hands(match_id, hand_seq);

CREATE INDEX idx_hands_time
ON hands(started_at_ms DESC);
```

`payload_json` 保留当前完整牌谱格式，包括以后增加的 Run It、头像、动作或分析字段，作为回放和 AI 数据的完整原始记录。

### 8.12 `hand_players`

建立“玩家 × 模式 × 时序”的快速关联。

```sql
CREATE TABLE hand_players (
    hand_id           TEXT NOT NULL REFERENCES hands(id),
    user_id           TEXT NOT NULL REFERENCES users(id),
    username_snapshot TEXT NOT NULL,
    seat               INTEGER NOT NULL,
    start_chips        INTEGER NOT NULL,
    end_chips          INTEGER NOT NULL,
    won                INTEGER NOT NULL DEFAULT 0,
    hole_json          TEXT NOT NULL,
    PRIMARY KEY (hand_id, user_id)
);

CREATE INDEX idx_hand_players_user
ON hand_players(user_id, hand_id);
```

查询个人牌谱时改为：

```sql
SELECT h.payload_json
FROM hand_players hp
JOIN hands h ON h.id = hp.hand_id
WHERE hp.user_id = ?
  AND (? IS NULL OR h.mode = ?)
  AND (? IS NULL OR h.room_code = ?)
ORDER BY h.started_at_ms DESC
LIMIT ? OFFSET ?;
```

不再同步读取和扫描整个 `hands.jsonl`。

### 8.13 `hand_actions`

结构化保存每个动作，便于统计和 AI 数据导出。

```sql
CREATE TABLE hand_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id    TEXT NOT NULL REFERENCES hands(id),
    action_seq INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    street     TEXT NOT NULL,
    action     TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    think_ms   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hand_id, action_seq)
);

CREATE INDEX idx_hand_actions_user
ON hand_actions(user_id, hand_id);
```

首版不强制单独建立 `hand_runouts`。多次发牌的完整 boards、winners 和 amounts 继续保留在 `hands.payload_json` 中；未来需要大量 SQL 分析时再增加结构化投影。

## 9. 金币事务设计

### 9.1 基本原则

禁止继续使用：

```text
getUserById().gold
→ JavaScript 加减
→ setGold()
```

所有金币操作必须：

1. 在数据库内检查余额和业务状态；
2. 在同一事务中更新余额；
3. 插入金币流水；
4. 更新比赛参与者或签到状态；
5. 使用唯一业务键保证幂等；
6. 事务提交后才向客户端返回成功。

### 9.2 现金桌买入

事务流程：

```text
BEGIN IMMEDIATE
→ 检查 operation_key 是否已处理
→ 检查用户存在且金币足够
→ 原子扣减 users.gold
→ 插入 wallet_transactions(cash_buyin)
→ 插入或更新 match_players
→ 更新 active_match_states
→ COMMIT
```

提交成功后才：

- 更新内存 `roomGames`；
- 向玩家发 `gold_update`；
- 广播入座状态。

### 9.3 补码

补码必须与买入相同：

- 每次请求有唯一 requestId；
- 金币扣除和 `pendingRebuy` 快照同事务；
- 重复请求不重复扣款；
- 下一手生效时只转移数据库已确认的挂起补码。

### 9.4 现金桌兑出

事务流程：

```text
检查 match_players.settled_at_ms IS NULL
→ 计算兑出金币
→ 增加 users.gold
→ 插入 wallet_transactions(cash_cashout)
→ 写 settlement_gold / settled_at_ms
→ 更新比赛快照或结束比赛
→ 提交
```

`settled_at_ms` 和唯一 `operation_key` 共同保证重复执行安全。

### 9.5 SNG 报名、退款和派奖

- 报名时扣金币并写 `sng_entry`；
- 开赛前退出写 `sng_refund`；
- 结束派奖写 `sng_prize`；
- 房主提前结束、自动结束和延迟清房必须调用同一个幂等结算服务；
- 不允许不同事件处理器各自复制“读余额再 setGold”的逻辑。

### 9.6 签到与管理员调账

签到奖励与 `daily_checkins` 同事务。

管理员设置金币不能直接覆盖而不留痕，应记录：

- 调整前余额；
- 调整后余额；
- `delta`；
- 操作管理员；
- 原因；
- requestId。

## 10. 牌局状态提交模型

### 10.1 最终目标

每个有效命令应遵循：

```text
读取当前状态
→ 校验命令
→ 计算 nextState
→ SQLite 事务写事件、快照和必要关系表
→ 提交
→ 替换内存状态
→ 广播
```

理想接口：

```js
const result = gameService.applyCommand(currentGame, command);
persistence.commit(result.nextGame, result.event, result.economicChanges);
roomGames[roomId] = result.nextGame;
broadcastState(roomId);
```

当前代码大量原地修改 `game` 对象，首批不必一次性改成纯函数，但必须引入统一的 `commitGameState(roomId, event)`，并逐步把“先广播后持久化”的路径消除。

### 10.2 快照时机

必须在以下时机持久化：

- 创建房间；
- 修改比赛设置；
- 玩家授权加入；
- 玩家入座、回座、站起、留座、坐出、离开；
- 买入和补码；
- 比赛开始；
- 一手牌开始并发完底牌；
- 每一个有效玩家行动；
- 每条公共牌发出；
- All-in 亮牌和 Run It 协商；
- Run It 每次 runout 进度；
- 摊牌和边池结算；
- 一手结束；
- 升盲；
- 比赛暂停、继续或加时；
- 比赛结束、兑出、退款和派奖。

### 10.3 版本控制

每场比赛维护递增的 `state_version`。

事务更新时使用乐观条件：

```sql
UPDATE matches
SET state_version = state_version + 1,
    updated_at_ms = ?
WHERE id = ?
  AND state_version = ?;
```

若受影响行数不是 1，说明：

- 重复请求；
- 旧计时器回调；
- 同一动作被并发处理；
- 内存状态落后于数据库。

此时不得继续广播，应重新读取快照或进入 `recovery_needed`。

### 10.4 已完成牌谱与快照原子提交

一手结束时，以下内容必须在同一事务：

- 插入 `hands`；
- 插入 `hand_players`；
- 插入 `hand_actions`；
- 更新每个 `match_players.current_chips`；
- 更新 `active_match_states`；
- 插入 `match_events(hand_settled)`。

`UNIQUE(match_id, hand_seq)` 防止重启或重复回调重复写入同一手。

## 11. 序列化与恢复

### 11.1 不可直接 JSON 化的对象

当前 `game` 中存在：

- `Deck` 和 `Card` 实例；
- `Set`；
- `setTimeout` 返回值；
- Socket ID；
- 可能由模块后续增加的临时对象。

不能直接对整个 `game` 调用 `JSON.stringify` 后期待完整恢复。

### 11.2 Deck 和 Card

为 `PokerLogic.js` 增加明确接口：

```js
deck.toSnapshot()
Deck.fromSnapshot(snapshot)
```

保存：

- 剩余牌顺序；
- `lastShuffleId`。

恢复时重新创建 `Deck` 和 `Card` 实例，不能只使用普通 `{ suit, rank }` 对象，因为现有逻辑会调用 `Card.toString()`。

不得在进程重启后重新洗牌或重发底牌，否则会改变已确认牌局。

### 11.3 Set

序列化：

```text
authorized Set → userId[]
shownCards[userId] Set → number[]
```

恢复时再转换回 `Set`。

### 11.4 Socket 状态

不持久化 Socket 对象。

恢复后所有玩家先设置：

```text
socketId = null
away = true
```

玩家重新连接时：

1. JWT 鉴权得到 `userId`；
2. 查询其未结束的 `match_players`；
3. 找到恢复后的内存比赛；
4. 重新绑定新 `socket.id`；
5. 加入 Socket.IO room；
6. 私发自己的底牌；
7. 广播公共状态；
8. 若轮到该玩家，重新建立行动计时器。

### 11.5 计时器

不保存：

```text
actionTimer
levelTimer
tableTimer
nextHandTimer
runoutTimer
runItTimer
reserveTimer
straddle timer
```

只保存绝对截止时间：

```text
actionDeadline
nextLevelAt
tableEndAt
nextHandAt
runoutDeadline
runItDeadline
reserveDeadline
straddleDeadline
```

启动恢复时：

```js
const delay = Math.max(0, deadline - Date.now());
```

重新创建计时器。

对于恢复时已经过期的截止时间，应由恢复服务统一决定：

- 行动时间到：执行当前规则的自动过牌或弃牌；
- 比赛时间到：标记本手后结束，或在局间直接结算；
- 涨盲时间到：当前手结束后应用；
- Run It/Straddle 协商到期：按默认结果继续；
- 留座到期：执行原有站起逻辑。

不得在加载快照的过程中直接并发触发多个过期回调。应先完成整场恢复，再按确定顺序处理到期事件。

### 11.6 快照格式版本

`snapshot_json` 内必须包含：

```json
{
  "formatVersion": 1,
  "stateVersion": 42
}
```

以后新增字段时：

- 新代码应能为缺失字段提供安全默认值；
- 破坏性变化必须提供快照迁移函数；
- 无法理解的未来版本不得勉强加载，应把比赛标记为 `recovery_needed`。

### 11.7 底牌安全

SQLite 会保存活跃手牌的底牌和剩余牌堆，这是精确恢复所必需的。

安全要求：

- 数据库目录仅服务用户可读写；
- 文件权限至少 `0600`；
- 不通过 Express 静态目录暴露；
- 不写入普通业务日志；
- 备份文件同样限制权限；
- 客户端仍只能通过私发事件获得自己的底牌；
- 数据库管理和备份渠道视为生产敏感权限。

## 12. 启动恢复策略

### 12.1 恢复流程

服务监听端口前：

1. 打开数据库；
2. 校验 Schema 版本；
3. 执行 `PRAGMA integrity_check` 的轻量启动策略或读取最近健康状态；
4. 查询所有活跃比赛；
5. 读取每场最新快照；
6. 校验快照版本和必要字段；
7. Hydrate 为游戏对象；
8. 重建 `roomGames`；
9. 重建未过期计时器；
10. 对已过期事件排队；
11. 完成恢复后开始监听；
12. 玩家重连并重新绑定。

### 12.2 恢复失败

单场比赛恢复失败时：

- 不应阻止其他比赛和用户登录；
- 将该比赛标记为 `recovery_needed`；
- 不自动猜测玩家筹码；
- 保留原快照和事件；
- 根据 `match_players` 和钱包流水提供管理员审计；
- 必要时按明确策略执行 `recovery_refund`。

整个数据库打不开或完整性检查失败时：

- 服务应拒绝进入可写生产状态；
- 不得自动创建空数据库覆盖原库；
- 记录明确错误；
- 从最近一致性备份恢复；
- 禁止静默回退成空用户库。

## 13. Repository 与兼容接口

### 13.1 保留 `database.js`

首批保持当前接口：

```text
createUser
getUserByEmail
getUserByUsername
getUserById
setPassword
setEmail
setAvatar
setAdmin
getAllUsers
addMessage
getMessages
markMessagesRead
applyCheckin
appendFeedback
getFeedback
appendHand
getHandsForUser
```

这些方法内部改为 SQLite 查询。

`setGold` 不应继续作为普通业务服务使用。可以暂时保留用于兼容，但只允许管理员迁移期调用，并最终替换为明确的钱包事务接口。

### 13.2 新增语义化接口

建议：

```js
db.wallet.cashBuyIn(...)
db.wallet.cashRebuy(...)
db.wallet.cashOut(...)
db.wallet.sngEnter(...)
db.wallet.sngRefund(...)
db.wallet.sngPrize(...)
db.wallet.checkinReward(...)
db.wallet.adminAdjust(...)

db.matches.create(...)
db.matches.commitState(...)
db.matches.finish(...)
db.matches.findRecoverable(...)
db.matches.markRecoveryNeeded(...)

db.hands.saveCompletedHand(...)
db.hands.getForUser(...)
```

经济接口不得由调用方自行计算余额后传入最终值；应传入业务增量、业务引用和幂等键，由 repository 在事务内读取并更新。

## 14. 现有代码修改范围

### 14.1 基础启动和存储

- `PokerServer/package.json`
  - 增加 SQLite 驱动；
  - 增加 `db:migrate`、`db:verify`、`db:backup`、`db:import-legacy` 脚本。
- `PokerServer/src/config.js`
  - 增加 `POKER_DB_PATH`；
  - 增加本地默认路径；
  - 校验生产路径和权限。
- `PokerServer/database.js`
  - 改成 SQLite 兼容门面；
  - 移除读取失败返回空用户库；
  - 移除业务层整文件读写。
- `PokerServer/server.js`
  - 监听前初始化数据库；
  - 加载并恢复活跃比赛；
  - 注册优雅关停。
- `PokerServer/src/runtime.js`
  - 允许恢复服务向 `roomGames` 注入已 hydrate 的比赛；
  - 保持其作为运行缓存。

### 14.2 经济流程

必须修改所有“读取金币再 `setGold`”路径：

- `src/rooms/seat-service.js`
  - 现金桌买入；
  - 补码；
  - SNG 报名。
- `src/matches/cash-match-service.js`
  - 兑出；
  - 比赛结束结算。
- `src/matches/sng-match-service.js`
  - 冠军派奖。
- `src/socket/events/membership-events.js`
  - 开赛前退出退款；
  - 离场相关处理。
- `src/socket/events/table-control-events.js`
  - 提前结束；
  - SNG 解散和派奖。
- `src/http/register-account-routes.js`
  - 签到。
- `src/http/register-admin-routes.js`
  - 管理员调账。

所有路径必须收敛到统一钱包服务，不能继续各自复制金币计算。

### 14.3 比赛与快照

- `src/socket/events/lobby-events.js`
  - 创建房间时插入 `matches` 和初始快照。
- `src/rooms/seat-service.js`
  - 入座、站起、回座、坐出、补码和离开后提交状态。
- `src/games/poker/hand-service.js`
  - 开手、发牌、玩家行动、发公共牌后提交状态。
- `src/games/poker/showdown-service.js`
  - 摊牌、边池、牌谱和快照原子提交。
- `src/games/poker/extensions/run-it/run-it-service.js`
  - 协商和每次 runout 进度。
- `src/games/poker/extensions/straddle/straddle-service.js`
  - 决策、接受、拒绝和过期。
- `src/matches/cash-match-service.js`
  - 训练时长、加时、结束。
- `src/matches/sng-match-service.js`
  - 升盲、结束和延迟清房。
- `src/socket/events/disconnect-events.js`
  - 保存 away 状态；
  - 不删除比赛。
- `src/socket/events/connection-events.js`
  - 恢复用户与比赛、Socket 的绑定。

### 14.4 牌谱和统计

- `src/games/poker/hand-history-service.js`
  - `appendHand` 改为事务插入 `hands`、`hand_players`、`hand_actions`。
- `stats.js`
  - 从 SQLite 只查询该玩家相关牌谱；
  - 首版仍可复用现有 JS 聚合；
  - 后续再逐步把常用统计改成增量或 SQL。
- `/api/my-hands`
  - 保持现有请求和响应格式；
  - repository 内改为索引查询。

### 14.5 运维

- `.gitignore`
  - 排除本地 SQLite、WAL、SHM 和备份目录。
- `deploy.sh`、`deploy-test.sh`
  - 增加数据库备份和 Schema Migration；
  - Migration 失败时中止；
  - 不打包数据库文件。
- 生产备份脚本
  - 从复制 JSON/JSONL 改为一致性 SQLite 备份；
  - 保留异地副本。
- 项目说明
  - 更新数据资产、迁移、恢复和部署约定。

## 15. 旧数据迁移

### 15.1 可迁移性

当前旧数据结构规整：

- `data.json` 根节点是 `users`；
- 用户已使用稳定 UUID；
- 密码已经是 bcrypt 哈希，可以原样迁移；
- 消息嵌套在用户对象内，可拆表；
- `hands.jsonl` 每行是一手完整 JSON；
- `feedback.jsonl` 每行是一条反馈。

因此旧数据迁移本身不复杂。主要风险是生产切换时仍有活跃比赛，而不是数据格式。

### 15.2 导入规则

#### 用户

- 原样保留 `id`；
- 原样保留 `password_hash`；
- 原样保留 `gold`；
- `created_at` 转换为 epoch 毫秒；
- `isAdmin` 转换为 0/1；
- 缺失邮箱保持 NULL；
- 缺失签到字段使用安全默认值；
- 用户消息拆入 `user_messages`。

为了让后续钱包流水可核对，每个迁移用户插入一条：

```text
transaction_type = initial_balance
delta = 原余额
balance_before = 0
balance_after = 原余额
operation_key = legacy-initial:{userId}
```

这不是重新发金币，只是为现有余额建立账本起点。

#### 牌谱

逐行解析 `hands.jsonl`：

- 为旧牌谱生成稳定 `hand_id`；
- 生成方式必须确定性，重复导入得到同一 ID；
- 可以使用旧 `roomId + ts + handSeq` 的规范化字符串哈希；
- 导入 `hands.payload_json`；
- 从 `seats` 和 `results` 生成 `hand_players`；
- 从 `actions` 生成 `hand_actions`；
- 保留旧用户名、头像、底牌和 Run It 数据。

旧牌谱没有永久 `match_id` 时，为同一旧房间会话创建 legacy match。若仅凭 `roomId` 无法可靠区分不同时期复用，需结合时间间隔和 `handSeq` 分段；无法确定时宁可建立独立 legacy archive match，也不能错误合并不同比赛。

#### 反馈

- 为每条反馈生成 UUID；
- 保留时间、用户、用户名、文本、联系方式和 UA；
- 无法找到用户时允许 `user_id` 为 NULL，但保留用户名快照。

### 15.3 导入工具

建议命令：

```text
npm run db:import-legacy -- \
  --data /path/to/data.json \
  --hands /path/to/hands.jsonl \
  --feedback /path/to/feedback.jsonl \
  --database /path/to/pokerdojo.sqlite \
  --dry-run
```

工具要求：

- 支持 `--dry-run`；
- 输出计数，不输出邮箱、密码哈希或底牌；
- 使用事务；
- 可重复运行；
- 遇到坏 JSON 行时明确报告行号；
- 默认任何用户或金币错误都中止；
- 对牌谱坏行可以选择中止或显式隔离，不能静默跳过；
- 写入迁移来源文件的大小和 SHA-256；
- 保存迁移报告。

### 15.4 迁移校验

至少比较：

- 用户总数；
- 用户 ID 集合；
- 用户金币逐人一致；
- 全体金币总和；
- 邮箱和管理员数量；
- 消息总数；
- 牌谱总数；
- 每手玩家数；
- 每手动作数；
- 反馈总数；
- 随机抽样牌谱的原 JSON 与 `payload_json`；
- 每个玩家最近牌谱查询结果；
- 登录密码哈希可正常验证；
- `PRAGMA integrity_check`；
- `PRAGMA foreign_key_check`。

校验失败时不得启动生产写入。

## 16. 首次生产切换

第一次从文件切换 SQLite 必须安排维护窗口。

### 16.1 切换前

1. 在测试服用生产数据副本完成导入；
2. 跑完登录、签到、消息、买入、补码、兑出、SNG 报名、退款、派奖、牌谱和统计测试；
3. 完成至少一次“中途杀进程 → PM2 重启 → 玩家重连继续”的演练；
4. 确认生产没有活跃比赛；
5. 通知维护窗口；
6. 停止生产进程，冻结旧文件写入。

首次切换不能在旧版本仍有活跃比赛时直接 `pm2 restart`，因为旧进程内的 `roomGames` 尚未写入 SQLite。

如果业务要求无等待切换，必须先发布一个过渡版本，让旧运行时具备导出活跃比赛快照的能力，再进行第二次切换；否则应选择无活跃玩家窗口。

### 16.2 切换步骤

1. 停止 PM2；
2. 对 `data.json`、`hands.jsonl`、`feedback.jsonl` 做带时间戳本机备份；
3. 下载一份异地备份；
4. 创建生产数据库目录并设置权限；
5. 执行 Schema Migration；
6. 导入旧数据；
7. 执行完整迁移校验；
8. 设置 `POKER_DB_PATH`；
9. 启动新版本；
10. 检查启动恢复日志；
11. 使用普通用户和管理员账号验证；
12. 核对用户金币、签到、消息和最近牌谱；
13. 旧文件改为只读归档，不立即删除。

## 17. 后续部署

普通发布流程调整为：

```text
本地静态检查和测试
→ 上传源码
→ 安装依赖
→ 创建一致性数据库备份
→ 执行待应用 Schema Migration
→ Migration 失败则中止
→ 优雅重启 PM2
→ 从 SQLite 恢复活跃比赛
→ 健康检查
```

`server.js` 启动时应：

- 校验数据库存在；
- 校验 Schema 版本；
- 加载活跃比赛；
- 恢复完成后再监听外部端口。

不允许：

- 找不到数据库时在生产静默创建一个空库；
- Migration 失败后继续运行；
- 部署脚本把数据库打进源码压缩包；
- 通过普通文件复制覆盖运行中的 WAL 数据库。

## 18. 优雅关停

收到 `SIGTERM` 或 `SIGINT` 时：

1. 标记服务为 shutting down；
2. 停止接受新房间和新操作；
3. 等待正在执行的 SQLite 事务完成；
4. 对所有活跃比赛提交最终内存快照；
5. 关闭新的计时器触发；
6. 关闭 Socket.IO/HTTP；
7. 关闭 SQLite；
8. 退出进程。

优雅关停是降低风险的补充，不是持久化替代。`kill -9`、进程崩溃、断电仍必须依赖最后一次已提交快照恢复。

## 19. SQLite 备份

### 19.1 一致性要求

开启 WAL 后，运行中的最新数据可能位于：

```text
pokerdojo.sqlite
pokerdojo.sqlite-wal
pokerdojo.sqlite-shm
```

不能只对主 `.sqlite` 文件执行普通 `cp` 并假设备份一致。

应使用：

- SQLite Online Backup API；
- 或 `VACUUM INTO`；
- 或停服后按 SQLite 规则复制完整数据库状态。

推荐使用应用内备份脚本生成独立一致性快照。

### 19.2 备份计划

建议：

- 每小时生成一份本机快照，保留最近 24 份；
- 每日生成一份异地备份，保留最近 30 份；
- 重要部署前额外生成一份；
- 数据库备份完成后记录 SHA-256；
- 定期在临时目录真实打开备份并运行 `integrity_check`；
- 至少每月做一次完整恢复演练。

备份必须包含：

- SQLite 一致性快照；
- 当前 Schema/应用版本；
- 备份时间；
- 文件校验和；
- 必要时保留 `secret.key` 和 `mail.json` 的独立安全迁移说明，但不能把它们混入公开备份或 Git。

## 20. 回滚

旧 JSON/JSONL 在首次切换后至少保留一个稳定观察期。

但生产切换后如果 SQLite 已产生新用户、金币变化或牌谱，不能直接把应用切回旧 JSON，否则会丢失新数据。

必须提供：

```text
SQLite → data.json / hands.jsonl / feedback.jsonl
```

紧急导出工具。

回滚流程：

1. 停止服务；
2. 备份当前 SQLite；
3. 导出最新 JSON/JSONL；
4. 校验用户、金币、消息、牌谱和反馈；
5. 切换旧存储驱动；
6. 启动旧版本；
7. 保留 SQLite 供后续排查。

不建议生产长期双写 JSON 和 SQLite。双写任意一侧失败都会产生两个相互矛盾的数据源。测试服可以短期做影子校验，但生产切换后 SQLite 应是唯一事实来源。

## 21. 故障处理策略

### 21.1 单次操作失败

- SQLite 事务回滚；
- 不更新内存状态；
- 不广播成功状态；
- 向操作玩家返回明确但不泄露内部信息的错误；
- 日志包含 matchId、stateVersion、operationKey 和错误堆栈。

### 21.2 快照提交失败

- 当前比赛暂停接收后续行动；
- 标记为 `recovery_needed`；
- 不允许只更新内存后继续多手游戏；
- 管理员可以查看最后快照和事件。

### 21.3 未捕获异常

进程级 `uncaughtException` 后继续运行并不适合作为最终可靠策略，因为进程状态可能已经不一致。

目标策略：

1. Socket/HTTP 处理器有事件级错误边界；
2. 未知未捕获异常记录完整上下文；
3. 尽最大努力提交可确认快照；
4. 停止接收新操作；
5. 让 PM2 重启；
6. 从最后已提交版本恢复。

### 21.4 数据库不可写

磁盘满、权限错误或数据库锁长期不释放时：

- 禁止继续接受会改变金币或牌局的操作；
- 服务进入只读或维护状态；
- 不得在内存中“先玩着以后再补写”；
- 发出明确运维告警。

## 22. 测试计划

### 22.1 Repository 测试

- 用户名和邮箱大小写唯一；
- 金币不能为负；
- 每种钱包事务余额前后正确；
- operationKey 重复不重复扣款/发钱；
- 签到同一天只能一次；
- 消息分页和已读；
- 牌谱按玩家、模式、房间分页；
- 外键和删除策略；
- Schema Migration 可从空库连续执行。

### 22.2 旧数据迁移测试

- 用户字段完全一致；
- 密码无需重设即可登录；
- 金币逐人和总和一致；
- 消息数量一致；
- 牌谱数量、玩家和动作一致；
- 坏行处理符合配置；
- 导入工具重复运行不产生重复数据；
- 导出回 JSON 后可被旧代码读取。

### 22.3 经济故障注入

在以下位置强制终止进程：

- 扣金币前；
- 扣金币后、Socket 返回前；
- 补码写入后、生效前；
- 现金桌兑出事务中；
- SNG 结算事务中；
- 发奖后、清房前。

验证：

- 没有重复扣款；
- 没有重复发奖；
- 未完成事务全部回滚；
- 已完成事务可从流水查证；
- 重启后的再次执行幂等。

### 22.4 牌局恢复故障注入

在以下阶段杀进程并让 PM2 重启：

- 房间等待中；
- 发完底牌后；
- Preflop 行动后；
- Flop、Turn、River；
- 多人边池形成后；
- All-in 跑马；
- Run It 协商中；
- 多次发牌中；
- 摊牌写牌谱前后；
- SNG 涨盲前后；
- 现金桌训练时间到点；
- 玩家站起、补码或断线时。

验证：

- 房间恢复；
- 玩家和座位恢复；
- 筹码总量守恒；
- 底池和下注一致；
- 牌堆顺序和底牌不改变；
- 玩家只能看到自己的底牌；
- 计时器恢复；
- 同一手不会重复写牌谱；
- 同一比赛不会重复结算。

### 22.5 长时间测试

- 模拟 6 小时现金桌；
- 持续写入数千手牌；
- 多次部署重启；
- 查询生涯统计；
- 运行备份；
- 监测事件循环延迟、SQLite 写入耗时、WAL 大小和磁盘空间。

## 23. 可观测性

建议增加结构化日志：

```text
[db] migration applied version=...
[wallet] userId=... type=... delta=... operationKey=...
[match] matchId=... version=... event=...
[snapshot] matchId=... version=... durationMs=...
[recovery] matchId=... version=... result=...
[backup] file=... size=... checksum=...
```

禁止记录：

- 密码和密码哈希；
- 邮箱验证码；
- JWT；
- SMTP 授权码；
- 完整底牌和剩余牌堆；
- 数据库文件内容。

建议监控：

- PM2 重启次数；
- 未捕获异常次数；
- SQLite 提交失败次数；
- 平均/最大事务耗时；
- WAL 大小；
- 数据库和磁盘空间；
- `recovery_needed` 比赛数量；
- 未结算 `match_players` 数量；
- 备份最后成功时间。

## 24. 分阶段实施

### 阶段 0：测试与运维基础

- 确认生产 Node 版本和 SQLite 驱动；
- 建立 Schema Migration 框架；
- 建立临时数据库测试工具；
- 建立备份、校验和恢复脚本；
- 补金币与崩溃故障注入测试。

### 阶段 1：静态数据迁移

- 用户；
- 消息；
- 签到；
- 反馈；
- 已完成牌谱；
- 保持现有 `database.js` 接口；
- 测试服完成旧数据导入和查询验证。

此阶段只解决文件数据库问题，还没有完成活跃牌局恢复。

### 阶段 2：金币事务与买入托管

- `wallet_transactions`；
- `match_players`；
- 买入、补码、兑出、退款、派奖；
- operationKey 幂等；
- 管理员调账和签到流水；
- 清除普通业务中的 `setGold`。

完成后，即使牌局不能精确恢复，也可以根据未结算托管可靠退款。

### 阶段 3：局间快照恢复

- 保存比赛、参与者和每手结束后的快照；
- 部署或崩溃后恢复到上一手完成状态；
- 当前未完成手作废并按开手前筹码回滚；
- 玩家重连回房。

这一阶段可以较快降低长比赛的主要风险，但会丢失崩溃时当前一手。

### 阶段 4：逐操作精确恢复

- 每个玩家行动后提交快照；
- 发牌和 Run It 过程提交；
- Deck、Card、Set、计时器 hydrate；
- 最后确认操作级恢复；
- 未捕获异常改为安全退出并由 PM2 重启恢复。

这是最终商业化可靠性目标。

### 阶段 5：性能与数据能力

- 统计查询优化；
- 自动滚动牌谱分页；
- AI 数据导出；
- 钱包与比赛管理后台；
- 数据保留和归档策略；
- 评估何时迁移 PostgreSQL。

## 25. 验收标准

SQLite 重构完成至少满足：

1. 生产不再读写 `data.json`、`hands.jsonl`、`feedback.jsonl`；
2. 用户登录、注册、改密、换邮箱和管理员功能兼容；
3. 旧账号 UUID、密码、金币、邮箱、头像和消息完整迁移；
4. 所有金币变化都有流水；
5. 买入、补码、兑出、退款和派奖重复执行不会重复记账；
6. 查询牌谱不扫描完整文件；
7. 已完成牌谱按玩家、模式和时间可索引；
8. PM2 重启后活跃比赛可以恢复；
9. 当前手牌、牌堆、底池、筹码和行动位恢复一致；
10. 玩家重连后仍只能看到自己的底牌；
11. 部署不会覆盖数据库；
12. 备份是 SQLite 一致性快照；
13. 备份可以真实恢复；
14. 数据库打不开时不会创建空用户库继续运行；
15. 完成现金桌和 SNG 的崩溃注入测试。

## 26. 关键决策总结

1. 当前阶段使用 SQLite，不购买独立数据库服务器；
2. 内存继续承担实时游戏计算，但不再是唯一副本；
3. SQLite 是用户、金币、比赛和牌谱的唯一持久化事实来源；
4. 用户余额采用“当前余额 + 不可变钱包流水”；
5. 买入采用比赛托管和幂等结算；
6. 活跃比赛采用“关系表 + 最新 JSON 快照 + 关键事件”；
7. 已完成牌谱采用“完整 JSON + 玩家/动作结构化投影”；
8. 数据库文件放在代码部署目录外；
9. 首次切换必须在无活跃比赛的维护窗口进行，除非先部署过渡快照版本；
10. 不长期双写 JSON 和 SQLite；
11. WAL 模式下使用 SQLite 一致性备份，不直接复制单个主文件；
12. 最终恢复粒度为最后一个已确认玩家操作。
