# Poker Dojo 开发指南

本文件只保存长期有效、会影响代码修改方式的仓库规则。项目介绍见
`README.md`，版本记录见 `CHANGELOG.md`，历史代理文档见 `docs/archive/`。
不要把工作日志、临时状态、完成清单或未来设想追加到本文件。

## 项目边界

- 产品是好友间使用虚拟金币的德州扑克训练游戏，不涉及真钱下注、提现或奖金。
- `PokerServer/` 中的 Node.js 实现是游戏规则和线上行为的唯一权威来源。
- `PokerLogic/` 中的 C# 代码只是牌力评估算法原型；修改 JS 功能时无需同步 C#。
- 目标客户端包括浏览器、Android/iOS 薄壳和 PC。`mobile/` 是 Capacitor 薄壳，
  游戏功能主要由线上 Web 客户端提供。

## 核心架构

- 服务端权威：洗牌、发牌、行动校验、下注、边池、判牌和结算全部在服务端执行。
- 客户端只负责展示和提交意图。不要把安全校验或经济结算只放在客户端。
- 底牌必须通过定向 socket 消息私发。公共 `game_state` 不得包含任何玩家底牌；
  摊牌只揭示规则允许公开的牌。
- 牌力分数越小越强：1 为最强，7462 为最弱。32 位牌编码运算注意使用无符号语义。
- Socket.IO 事件使用 `snake_case`。房间运行状态保存在内存中的 `roomGames`，
  以房间 ID 为键。

当前服务端已经模块化：

- `PokerServer/server.js`：装配入口，应保持精简，不直接注册具体 socket 事件。
- `PokerServer/src/games/poker/`：牌局规则、手牌流程、边池、摊牌和牌谱。
- `PokerServer/src/games/poker/extensions/`：多次发牌、straddle 等可选规则。
- `PokerServer/src/rooms/`：大厅、成员、座位和房间生命周期。
- `PokerServer/src/matches/`：现金训练赛、SNG 和比赛结算。
- `PokerServer/src/socket/events/`：按领域拆分的 socket 事件。
- `PokerServer/src/http/`：账户、认证和管理员 HTTP 路由。
- `PokerServer/public/js/`、`public/css/`：按加载顺序编号的前端模块。

模块边界的设计依据见 `docs/refactor/`。新增功能应放进相应领域模块，不要重新把
`server.js`、`table-service.js`、`register-socket-handlers.js` 或 `index.html`
堆成单体文件。

## 数据与安全

数据是项目最重要且必须可迁移的资产：

- 用户、经济流水、牌谱和活跃比赛快照：SQLite，由 `POKER_DB_PATH` 指向代码目录外的数据文件。
- `PokerServer/data.json`、`hands.jsonl`、`feedback.jsonl`：仅用于首次迁移和稳定观察期回滚。
- JWT 私章：`PokerServer/secret.key`
- SMTP 凭据：`PokerServer/mail.json`

SQLite 数据库、WAL/SHM、旧数据文件和密钥不得提交、覆盖、清空或打进部署包。
SQLite 备份必须使用 `scripts/backup-sqlite.js` 生成一致性快照，不能只复制 WAL 模式下
的主文件。不要在代码、日志、文档、提交或测试输出中暴露账号、邮箱、底牌、令牌、
服务器密钥或 SMTP 授权码。

- 牌谱必须保持结构化、追加式和有时间顺序，并记录玩家、模式、动作、思考时间、
  底牌、公共牌、下注、底池和结果。
- 影响金币、买入、兑出、奖励、边池或比赛结算的改动属于高风险改动；必须检查重复
  结算、掉线、离场、重连、全押和多边池路径。
- 修改广播数据结构时，必须检查是否可能泄露底牌或其他私有状态。
- `database.js` 是持久化接口边界；迁移 PostgreSQL 时优先保持调用接口稳定。

## 本地开发与验证

在 `PokerServer/` 中运行：

```bash
npm install
npm run dev
npm test
npm run check
```

- `npm run dev` 使用 `LOCAL_DEV=1` 启动本地开发服务器。
- `npm test` 运行 Node 内置测试，包括服务端模块边界和前端组件结构检查。
- `npm run check` 运行 ESLint 和解构依赖交叉检查，也是部署前置检查。
- 修改牌局流程、座位、边池、多次发牌、straddle、掉线或经济逻辑时，应增加或执行
  相应的 socket/领域回归测试，不能只验证页面能打开。
- 修改前端模块时，保持 `index.html` 中 JS/CSS 的依赖顺序，并同步更新结构测试。
- 遵循所改文件的现有 CommonJS、命名、缩进和注释风格，避免无关格式化。

## 部署约束

- `deploy-test.sh` 面向测试服务器；`deploy.sh` 面向生产服务器并可能提交、推送和重启。
- 只有用户明确要求部署时才运行部署脚本；不得把“完成代码修改”理解为获准上线。
- 生产部署前必须通过 `npm run check` 和与改动风险相称的测试。
- 部署包必须包含 `avatars`、`scripts`、`src`、`public`，并继续排除上述运行时数据和密钥。
- SQLite 首次切换前必须确认旧版本没有活跃牌局；后续重启应从持久化快照恢复。
- 私有主机、SSH、备份和生产操作细节属于本地 `OPS.local.md`，不得复制进仓库文档。

## 文档维护

- 已发布的变化写入 `CHANGELOG.md`。
- 具体功能设计写入 `docs/feat-*`；重构设计写入 `docs/refactor/`。
- 尚未确认的想法和长期计划应写入 Issue 或单独的 roadmap 文档，而不是本文件。
- 代码是“当前是否已实现”的最终依据；归档文档只能用于追溯，不能作为当前事实。
- 如果本文件与代码或测试冲突，应先核实代码，再更新本文件使其保持简短和准确。
