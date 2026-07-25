# 服务端第一阶段模块拆分设计

## 实施状态

第一阶段已于 2026-07-25 按本设计完成：

- `server.js` 已缩减为 86 行组装入口；
- 配置、共享运行时状态和鉴权已迁移至 `src/config.js`、`src/runtime.js`、`src/auth.js`；
- 管理员、账号数据和认证 HTTP 路由已迁移至 `src/http/`；
- 临时语音子系统已迁移至 `src/voice/voice-module.js`；
- 牌局、房间、大厅和比赛生命周期已整体迁移至 `src/table/table-service.js`；
- Socket.IO connection handlers 已迁移至 `src/socket/register-socket-handlers.js`；
- 原有 HTTP/Socket 协议、牌谱和用户数据格式未修改；
- 所有 JavaScript 语法检查和 Node.js 测试通过；
- 新增结构测试，防止业务实现重新堆回入口文件。

## 1. 背景

当前服务端主要逻辑集中在 `PokerServer/server.js`：

- 文件总计约 3,028 行；
- 包含约 102 个具名函数；
- 注册 21 个 HTTP 接口；
- 注册 37 个 Socket.IO 事件；
- 同时负责进程启动、HTTP、鉴权、语音、房间大厅、牌局状态机、计时器、金币结算和牌谱落库。

这种结构来自项目从早期双人原型持续增加多人桌、现金桌、SNG、邮箱账号、语音、Run It、Straddle 等功能的自然演进。当前代码仍可运行，但阅读、定位问题和继续增加功能的成本已经明显上升。

第一阶段只解决“所有代码堆在一个文件里”的问题，以保守方式建立文件边界。此阶段不是服务端架构重写，也不要求一次性解决现有代码中的全部耦合问题。

## 2. 第一阶段原则

本阶段的核心原则是：

> 只做等价的文件模块拆分，不做功能逻辑上的大重构。

具体要求：

1. 保持现有功能和运行结果不变；
2. 保持现有代码执行顺序不变；
3. 保持现有函数内部逻辑和条件分支不变；
4. 保持 HTTP 和 Socket.IO 协议完全兼容；
5. 保持所有持久化数据格式和文件路径不变；
6. 只增加模块拆分所必需的 `require`、`module.exports`、注册函数和依赖传入；
7. 每一批拆分后都必须能够独立启动、测试和回滚；
8. 不为追求理想目录结构而强行拆开当前高度耦合的调用链。

第一阶段允许某些模块仍然较大。先把 3,000 行单文件拆成若干职责清晰、可以继续演进的粗粒度模块，比同时重写牌局引擎更安全。

## 3. 非目标

第一阶段不包含：

- 不修改游戏规则；
- 不修改行动顺序、最小加注、边池、摊牌或 Run It 算法；
- 不修改 Straddle 的候选人、展示时机或超时语义；
- 不修改行动、局间、升盲、比赛结束、留座和清房计时；
- 不修改金币买入、补码、兑出、抽水或 SNG 奖励；
- 不修改断线、重连、坐出、站起、离桌或淘汰行为；
- 不修改任何 HTTP 路径、请求字段、响应字段或状态码；
- 不修改任何 Socket.IO 事件名、入参或广播 payload；
- 不修改 `game_state`、`hole_cards`、`showdown_reveal` 等数据结构；
- 不修改底牌私发和公共状态广播的隐私边界；
- 不修改 `data.json`、`hands.jsonl`、`feedback.jsonl` 的结构、路径或写入方式；
- 不迁移 SQLite、PostgreSQL 或其他数据库；
- 不引入 TypeScript、ES Modules、框架、容器或新的构建流程；
- 不统一重命名函数、变量、事件或字段；
- 不合并重复代码；
- 不改写同步文件操作、计时器或全局状态模型；
- 不把现有逻辑重写为 class、事件总线、状态机框架或纯函数架构；
- 不顺手修复与模块拆分无关的功能问题；
- 不在本阶段部署生产服务器。

如果拆分过程中发现现有功能问题，应单独记录，在文件拆分完成并验证稳定后另开变更处理。

## 4. 为什么采用粗粒度拆分

当前 `server.js` 中，牌局引擎、房间生命周期和比赛结算存在大量直接互调，例如：

```text
advanceStage
├── broadcastState
├── offerRunIt
├── doShowdown
├── applyPendingLevelUp
├── maybeEndSNG
└── scheduleNextHand
```

房间结束、玩家离座和下一手清理又会调用：

```text
cashOut
removeBustedPlayers
endCashTable
recordLeft
buildRanking
broadcastRoomList
```

第一阶段若立即把这些函数细分到十几个文件，会产生大量双向依赖、回调重接和调用顺序调整，实际已经属于逻辑重构。

因此第一阶段把“牌局规则 + 房间生命周期”暂时保留在同一个较大的 `table-service.js` 中。等文件边界稳定、回归测试补齐后，再讨论第二阶段内部拆分。

## 5. 第一阶段目标目录

```text
PokerServer/
├── server.js
├── database.js
├── stats.js
├── equity.js
├── mailer.js
├── PokerLogic.js
├── LookupTables.js
│
├── src/
│   ├── config.js
│   ├── runtime.js
│   ├── auth.js
│   │
│   ├── http/
│   │   ├── register-admin-routes.js
│   │   ├── register-auth-routes.js
│   │   └── register-account-routes.js
│   │
│   ├── voice/
│   │   └── voice-module.js
│   │
│   ├── table/
│   │   └── table-service.js
│   │
│   └── socket/
│       └── register-socket-handlers.js
│
├── public/
├── avatars/
└── *.test.js
```

现有 `database.js`、`stats.js`、`equity.js`、`mailer.js`、`PokerLogic.js` 和 `LookupTables.js` 第一阶段不移动，避免扩大改动范围或影响现有相对路径。

## 6. 各文件职责

### 6.1 `server.js`

`server.js` 作为唯一启动入口，负责：

- 加载依赖；
- 创建 Express、HTTP Server 和 Socket.IO；
- 按原顺序安装中间件；
- 注册静态资源和首页；
- 创建共享运行时状态；
- 注册 HTTP 路由；
- 初始化临时语音模块；
- 注册 Socket.IO 鉴权和事件；
- 在 `require.main === module` 时监听端口；
- 继续导出当前测试需要的 `_test` 接口。

第一阶段不要求把启动过程改造成完全无副作用的 `createServer()` 工厂。当前 `require('./server')` 的加载行为先保持兼容，避免同时改变测试和进程生命周期。

拆分完成后，`server.js` 目标约为 100～200 行。它应只做模块组装，不再保存具体业务实现。

### 6.2 `src/config.js`

保存当前顶层配置和常量：

- `LOCAL_DEV`；
- `PHASES`；
- 默认盲注；
- 标准 SNG 盲注级别；
- 行动和加时时间；
- Run It、Straddle 和局间时间；
- SNG 报名费档位；
- 金币与筹码汇率；
- 签到奖励；
- 公开域名配置；
- JWT 私章加载和首次生成逻辑。

JWT 私章的优先级、`secret.key` 路径、权限、日志和失败回退行为必须与拆分前完全一致。

本地开发测试账号的创建逻辑可以继续由 `server.js` 调用，也可以提取为 `config.js` 导出的初始化函数，但不得改变触发条件：

```text
仅当 LOCAL_DEV === true 时执行
```

### 6.3 `src/runtime.js`

只创建并返回当前进程内共享状态：

```js
{
    roomGames,
    lobbySockets,
    inviteCodeFailuresByUser,
    inviteCodeFailuresByIp
}
```

这些对象在整个进程生命周期中必须保持同一引用。第一阶段不把 `roomGames` 改为 class、Map、Repository 或持久化存储，也不改变服务器重启后房间状态丢失的现状。

验证码等待状态可以继续放在对应 HTTP 模块内部：

- `pendingRegs`
- `pendingResets`
- `pendingBinds`

语音等待状态继续由语音模块内部持有。

### 6.4 `src/auth.js`

保存共享鉴权能力：

- `signToken`；
- `userPayload`；
- HTTP `requireAuth`；
- HTTP `requireAdmin`；
- Socket.IO 鉴权中间件注册。

该模块通过参数接收 `db`、`jwt` 和 `JWT_SECRET`，不得改变：

- JWT payload；
- JWT 有效期；
- Bearer Token 解析方式；
- HTTP 错误状态码和错误文字；
- Socket 鉴权错误文字；
- 每次鉴权后重新从数据库读取用户的行为。

### 6.5 `src/http/register-admin-routes.js`

保存当前最先注册的管理员 HTTP 路由：

- `/api/admin/users`
- `/api/admin/set-gold`

管理员反馈列表 `/api/admin/feedback` 仍可与反馈功能一起保留在 `register-account-routes.js`，以保持它在原有反馈路由之后的注册位置。

### 6.6 `src/http/register-auth-routes.js`

保存账号相关 HTTP 路由：

- `/api/register/send-code`
- `/api/register/verify`
- `/api/login`
- `/api/forgot/send-code`
- `/api/forgot/reset`
- `/api/bind-email/send-code`
- `/api/bind-email/verify`

验证码生成、有效期、发送间隔、密码哈希参数和错误响应全部原样保留。

### 6.7 `src/http/register-account-routes.js`

保存除语音和账号流程之外的 HTTP 路由：

- 当前账号信息；
- 我的牌谱；
- 生涯统计；
- 站内消息及已读；
- 每日签到；
- Bug/建议反馈；
- 管理员反馈列表。

第一阶段允许该文件继续直接调用 `db`、`stats` 和 `mailer`。不在本阶段新增 service 层。

### 6.8 `src/voice/voice-module.js`

整体搬迁当前临时语音子系统：

- 临时目录初始化；
- 语音元数据和内存索引；
- 上传频率与并发限制；
- 音频真实时长解析；
- 过期文件清理；
- `/api/voice` 上传；
- `/api/voice/:id` 播放；
- `voice_sync` 所需的同步函数。

该模块接收：

```js
{
    app,
    io,
    db,
    roomGames,
    requireAuth
}
```

第一阶段必须保持以下行为：

- 服务启动时清空 `voice_tmp`；
- 文件仍然只用于当前牌桌临时互动；
- 文件不进入聊天历史、数据库和备份；
- MIME、大小、时长、频率和并发限制不变；
- 过期时间和清理间隔不变；
- 只有当前房间成员可以上传和播放；
- 模块提供清理计时器，并继续调用 `unref()`；
- Socket handler 仍可调用 `syncRecentVoices()`。

### 6.9 `src/table/table-service.js`

这是第一阶段最大的模块，整体保存当前牌桌和房间业务：

- 盲注、Ante 和时间卡计算；
- Straddle 位置和选择；
- 下注轮判断；
- 收注、未跟注退还、主池和边池；
- `game_state` 构建和广播；
- 底牌提示私发；
- 行动计时器；
- 街道推进；
- 全押胜率；
- Run It 多次发牌；
- 摊牌和分池结算；
- 开局、洗牌、发底牌和高牌定庄；
- 牌谱行动记录和落库；
- 房间编号和邀请码；
- 大厅房间列表；
- SNG 升盲和比赛结束；
- 现金桌时长和结束结算；
- 空房清理和下一手；
- 入座、站起、回座、补码、兑出和淘汰。

该模块通过一个明确的依赖对象接收现有全局依赖：

```js
createTableService({
    io,
    db,
    stats,
    equity,
    Deck,
    HandEvaluator,
    config,
    runtime
});
```

第一阶段允许模块内部函数继续互相直接调用，也允许它直接发送 Socket.IO 事件和调用数据库。此处只改变代码所在文件，不改变牌局架构。

该模块对 Socket 注册层暴露当前事件处理所需的操作和查询，例如：

```js
{
    getRoom,
    listRooms,
    broadcastRoomList,
    broadcastState,
    createSngRoom,
    createCashRoom,
    handleJoinRoom,
    seatPlayer,
    standUpPlayer,
    restoreVacatedPlayer,
    startHand,
    beginPlay,
    tryStartHand,
    scheduleNextHand,
    endCashTable,
    extendTable,
    chargeRebuy,
    performPlayerAction,
    resolveRunIt,
    syncRoomAfterDisconnect
}
```

实际导出集合以搬迁时的调用需要为准。只导出跨模块调用的函数，纯内部辅助函数保持私有。

为减少第一阶段改动，`performPlayerAction` 等函数不必立即重新设计返回值。Socket 层也可以继续保留少量直接状态操作；只要逻辑从原文件等价搬迁且职责归属明确即可。

### 6.10 `src/socket/register-socket-handlers.js`

保存：

- `io.on('connection')`；
- 当前所有 `socket.on(...)` 注册；
- 用户上线初始化；
- 头像；
- 大厅；
- 创建、加入和邀请；
- 坐下、站起、留座、离开和解散；
- 暂停、继续、Straddle 和加时；
- 补码和开赛；
- 亮牌和看后续牌；
- 聊天、表情、统计和语音同步；
- 玩家行动；
- Run It 协商；
- 行动加时；
- 断线处理。

第一阶段以“原事件块原样搬迁”为主。每个事件的：

- 注册顺序；
- 入参解构方式；
- 校验顺序；
- 错误消息；
- 广播目标；
- 状态修改时机；
- 调用顺序；

都应保持不变。

如果某段 Socket handler 与牌桌内部函数高度耦合，可以先继续保留在 Socket 模块内，不要求本阶段强行变成一行 service 调用。

## 7. 模块组装方式

第一阶段使用 CommonJS 和显式依赖传入，不增加全局单例容器。

建议的组装顺序：

```js
const config = require('./src/config');
const runtime = createRuntime();
const auth = createAuth({ db, jwt, jwtSecret: config.JWT_SECRET });

const tableService = createTableService({
    io, db, stats, equity, Deck, HandEvaluator, config, runtime
});

registerAdminRoutes({ app, db, auth });

const voiceModule = registerVoiceModule({
    app, io, db, runtime, requireAuth: auth.requireAuth
});

registerAccountRoutes({ app, db, stats, mailer, auth, config });
registerAuthRoutes({ app, db, bcrypt, mailer, auth, config });

auth.registerSocketAuth(io);
registerSocketHandlers({
    io, db, stats, runtime, tableService, voiceModule, config
});
```

这里只说明依赖关系，不要求实现时逐字采用以上变量名。

禁止通过以下方式绕过依赖边界：

- 把所有变量挂到 `global`；
- 使用运行时字符串路径动态加载模块；
- 让子模块重新创建第二份 `roomGames`；
- 让子模块重新创建 Express、HTTP Server 或 Socket.IO；
- 用复制状态代替共享同一对象引用。

## 8. 必须保持的初始化顺序

模块拆分后，以下顺序应与当前行为一致：

1. 加载基础依赖；
2. 创建 Express、HTTP Server 和 Socket.IO；
3. 计算 `LOCAL_DEV`；
4. 安装 `express.json()`；
5. 注册 `/avatars` 静态目录；
6. 注册 `public` 静态目录；
7. 注册首页 `/`；
8. 加载或生成 JWT 私章；
9. 仅在本地开发模式准备测试账号；
10. 创建 HTTP 鉴权中间件；
11. 注册管理员用户和金币接口；
12. 初始化临时语音目录、注册语音接口并启动清理计时器；
13. 注册牌谱、账号信息、统计、消息、签到和反馈接口；
14. 注册账号注册、登录、找回密码和绑定邮箱接口；
15. 注册 Socket.IO 鉴权；
16. 注册 Socket.IO connection handlers；
17. 仅在入口直接运行时监听端口。

不得因为文件拆分而提前监听端口，或让路由/事件被重复注册。

## 9. 协议与数据不变约束

### 9.1 HTTP

所有现有 HTTP 接口必须保持：

- URL 不变；
- HTTP method 不变；
- 鉴权方式不变；
- body/query/header 字段不变；
- 成功响应结构不变；
- 错误状态码和错误文本不变。

### 9.2 Socket.IO

所有现有客户端和服务端事件必须保持：

- 事件名不变；
- payload 字段不变；
- 私发、房间广播和全大厅广播范围不变；
- 同一操作中的事件发送顺序不变；
- 重连后的恢复事件不变。

特别保护：

- `hole_cards` 和 `my_hand` 继续只私发给本人；
- `game_state` 继续不包含任何底牌字段；
- `showdown_reveal` 只揭示规则允许公开的牌；
- `allin_reveal`、`equity` 和 Run It 事件结构不变。

### 9.3 持久化数据

以下数据资产不允许因本次拆分变化：

```text
PokerServer/data.json
PokerServer/hands.jsonl
PokerServer/feedback.jsonl
PokerServer/secret.key
PokerServer/mail.json
```

要求：

- 文件名和路径不变；
- JSON/JSONL 字段不变；
- 写入时机不变；
- 牌谱中的玩家、模式、时间戳、行动、思考时间、底牌和公共牌不变；
- deploy 和备份行为不变；
- 不使用测试清理命令删除或覆盖生产数据副本。

## 10. 机械拆分规则

搬迁代码时遵循：

1. 优先整段移动，不逐行重写；
2. 保持函数体内容和函数相对顺序；
3. 不运行全文件格式化；
4. 不修改注释含义；
5. 不改成箭头函数或 class；
6. 不修改 `const`、`let`、`var` 的使用方式，除非模块导出所必需；
7. 不调整 `setTimeout`、`clearTimeout` 或广播的先后顺序；
8. 不改变同步与异步函数边界；
9. 不删除看似未使用的字段或兼容分支；
10. 不把多个提交压缩成一次大搬迁。

模块化所必需的适配代码应尽量放在：

- 模块工厂参数；
- 模块返回对象；
- `module.exports`；
- `server.js` 组装处。

不要把适配逻辑散布到具体牌局条件分支中。

## 11. 实施批次

建议按以下可独立回滚的批次实施。

### 批次 0：固定基线

- 确认工作区变更范围；
- 运行全部现有测试；
- 对 `server.js` 执行语法检查；
- 记录 HTTP 和 Socket.IO 事件清单；
- 对关键数据结构增加必要的结构测试；
- 不修改业务实现。

### 批次 1：提取配置、运行时和鉴权

- 新增 `src/config.js`；
- 新增 `src/runtime.js`；
- 新增 `src/auth.js`；
- `server.js` 继续负责组装；
- 保持 `_test` 导出兼容。

这一批不移动牌局和 Socket handlers。

### 批次 2：提取 HTTP 路由

- 移动账号、管理员、签到、反馈、牌谱、统计和消息路由；
- 保持 Express 注册顺序；
- 不修改路由内部实现。

### 批次 3：提取临时语音

- 整体搬迁语音常量、状态、辅助函数和两个 HTTP 路由；
- 向 Socket 模块暴露 `syncRecentVoices`；
- 确认启动清空、上传、播放和过期清理不变。

### 批次 4：提取牌桌与房间服务

- 把 Game helpers、牌局推进、房间大厅和座位生命周期整体移入 `table-service.js`；
- 暂不进一步拆分内部函数；
- 通过显式依赖对象共享 `io`、`db` 和 `runtime`。

这是风险最高的一批，应单独提交和完整回归。

### 批次 5：提取 Socket handlers

- 整体搬迁 Socket.IO 鉴权后的 connection handlers；
- 保持事件注册顺序；
- 使用 `tableService` 和 `voiceModule`；
- `server.js` 最终只保留启动和组装。

每个批次完成后立即验证，不在失败状态上继续下一批。

## 12. 自动校验

每个批次至少执行：

```bash
node --check server.js
```

并对所有新增 JavaScript 文件执行 `node --check`。

然后执行：

```bash
npm test
```

建议增加服务端结构测试，约束：

- `server.js` 不再重新出现大段业务实现；
- 所有模块都能被 `require`；
- HTTP 路由只注册一次；
- Socket handlers 只注册一次；
- `_test.projectedPositions` 等现有测试入口仍然可用；
- 新旧 HTTP 路径集合一致；
- 新旧 Socket 事件集合一致。

结构测试不能替代功能回归，但可以防止后续又把逻辑堆回 `server.js`。

## 13. 功能回归清单

第一阶段完成后，至少验证以下行为。

### 13.1 启动和账号

- 普通模式和 `LOCAL_DEV=1` 均能启动；
- `secret.key` 读取和首次生成正常；
- 注册验证码、注册、用户名/邮箱登录正常；
- 忘记密码和绑定/更换邮箱正常；
- JWT 过期和无效 Token 错误不变；
- 管理员接口权限正常。

### 13.2 数据接口

- `/api/me` 正常；
- 牌谱列表和筛选正常；
- 生涯统计正常；
- 站内消息读取和标记已读正常；
- 签到状态和领取正常；
- 反馈写入和管理员读取正常。

### 13.3 房间和座位

- 创建 SNG 和现金桌正常；
- 四位房间码和邀请链接加入正常；
- 房主锁定和重置邀请正常；
- 观战、入座、站起、回座、留座和离开正常；
- 房主强制站起、暂停、继续和解散正常；
- 断线重连保留座位、筹码和底牌；
- 空房宽限和清理行为不变。

### 13.4 牌局

- 双人和多人开局正常；
- 高牌定庄、按钮、SB、BB、UTG 顺序不变；
- Ante 和 Straddle 正常；
- Fold、Check、Call、Bet、Raise 和 All-in 正常；
- 行动超时和加时正常；
- Flop、Turn、River 和 Showdown 正常；
- 未跟注退还、主池、边池和平分正常；
- 全押亮牌、胜率和 Run It 1～5 次正常；
- 主动亮牌和看后续牌正常；
- 下一手、升盲和比赛结束正常。

### 13.5 经济和数据资产

- SNG 报名扣费、奖池和奖励不变；
- 现金桌买入、补码、自动补码和兑出不变；
- 房间结束排名和站内消息不变；
- 新牌谱内容与拆分前字段一致；
- `data.json`、`hands.jsonl`、`feedback.jsonl` 没有被覆盖或重建。

### 13.6 互动

- 文字聊天和 Emoji 正常；
- 语音上传、广播、播放、同步和过期正常；
- 点头像查看本局统计正常。

## 14. 第一阶段完成标准

满足以下条件时，第一阶段视为完成：

- `server.js` 只保留启动、依赖加载和模块组装；
- HTTP、语音、牌桌和 Socket handlers 已按本设计移出；
- `server.js` 缩减到约 100～200 行；
- 没有修改 HTTP 和 Socket.IO 协议；
- 没有修改游戏规则和计时语义；
- 没有修改数据文件和牌谱格式；
- 没有改变底牌隐私边界；
- 所有 JavaScript 文件语法检查通过；
- 所有现有测试通过；
- 服务端结构测试通过；
- 关键功能回归清单通过；
- 每个拆分提交都可以独立回滚；
- 第一阶段变更未直接部署生产环境。

第一阶段完成后，才讨论第二阶段是否继续拆分：

```text
table-service.js
├── game-engine
├── room-service
├── tournament-service
├── cash-service
├── game-presenter
└── timer-lifecycle
```

第二阶段可能涉及更深的依赖治理和测试建设，不属于本设计的实施范围。

本次设计的最终原则是：

> 第一步先把文件边界拆出来并保证服务可运行；现有耦合可以保留，功能逻辑留到后续独立重构。
