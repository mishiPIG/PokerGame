# 前端模块化重构设计

## 1. 背景

当前前端全部集中在 `PokerServer/index.html`：

- 文件总计约 4,686 行；
- 约 1,060 行内联 CSS；
- 约 3,100 行内联 JavaScript；
- HTML 结构、页面状态、Socket.IO 事件、牌桌渲染、音效、语音、牌谱回放等职责混杂；
- 多项功能共享全局变量，并通过 HTML 内联 `onclick` 调用全局函数。

这种结构来自项目从早期原型持续增加功能的演进过程，目前仍可运行，但已经显著增加阅读、修改、代码审查和多人并行开发的成本。

本次重构在 `refactor/frontend-componentize` 分支进行，目标是以保守方式建立前端文件边界，为后续维护提供基础。

## 实施状态

第一阶段前端模块化已于 2026-07-25 按本设计完成：

- `index.html` 已缩减为仅包含页面 DOM 和资源引用；
- 原内联 CSS 已按原始顺序拆分为 6 个样式文件；
- 原内联 JavaScript 已按原始顺序拆分为 12 个经典脚本；
- 服务端仅对 `PokerServer/public` 提供静态资源；
- 拆分后的 CSS/JavaScript 按加载顺序拼接，与重构前内容逐字等价；
- 所有 JavaScript 文件语法检查通过；
- 现有 Node.js 测试全部通过；
- 本地浏览器加载无控制台错误，内联事件跨文件调用正常；
- 390×844 移动端视口无横向溢出，登录页样式无可观察变化；
- 首页、CSS、JavaScript 和头像资源均返回 HTTP 200。

第二阶段的状态管理和依赖边界治理不属于本次保守拆分范围，仍按第 13 节作为后续工作。

## 2. 目标

本次重构的目标：

1. 将内联 CSS 和 JavaScript 从 `index.html` 中拆出；
2. 按现有业务职责建立清晰的文件结构；
3. 保持当前页面结构、视觉效果、交互方式和网络协议不变；
4. 保持现有代码执行顺序及全局函数兼容性；
5. 将每次变更控制在可独立验证、可独立回滚的范围内；
6. 为后续真正的状态管理、模块依赖治理和测试建设提供落点。

预期完成第一阶段后，`index.html` 将缩减至约 500 行，主要保留页面 DOM 结构。

## 3. 非目标

本次重构不包含：

- 不引入 React、Vue 或其他前端框架；
- 不引入 TypeScript；
- 不引入打包器或新的构建流程；
- 不使用 `type="module"`；
- 不修改 Socket.IO 事件名称或数据结构；
- 不修改 DOM ID、CSS class 或 HTML 内联事件；
- 不重新设计页面或调整样式；
- 不修改游戏规则、金币结算或服务端数据格式；
- 不在同一批次迁移数据库；
- 不主动合并重复代码或优化业务逻辑；
- 不拆分 HTML 模板或通过异步请求加载 HTML fragment。

本次工作的核心原则是：**第一阶段只建立文件边界，不同时重写代码。**

## 4. 风险原则

### 4.1 保持原始代码顺序

CSS 的层叠顺序和 JavaScript 的执行顺序都可能影响实际行为。拆分过程中应保持代码块在原文件中的相对顺序。

### 4.2 使用经典脚本

第一阶段继续使用普通 `<script>`，脚本统一放在 `</body>` 前，不增加 `defer`、`async` 或 `type="module"`。

这样可以继续支持：

- 多个脚本之间访问现有顶层状态；
- HTML 中的 `onclick="functionName()"`；
- 现有初始化执行时机；
- 当前 Socket 和 DOM 的依赖关系。

### 4.3 不顺手清理

机械搬迁时不应顺便：

- 重命名变量或函数；
- 调整函数位置；
- 改写条件判断；
- 改用不同 DOM API；
- 合并 CSS 选择器；
- 删除看似未使用的代码；
- 格式化整个文件。

这类优化应在拆分完成并验证稳定后单独提交。

## 5. 目标目录

```text
PokerServer/
├── index.html
├── public/
│   ├── css/
│   │   ├── 00-shell.css
│   │   ├── 10-auth-user.css
│   │   ├── 20-table.css
│   │   ├── 30-lobby.css
│   │   ├── 40-panels.css
│   │   └── 50-effects.css
│   └── js/
│       ├── 00-state.js
│       ├── 10-auth.js
│       ├── 20-socket.js
│       ├── 30-room.js
│       ├── 40-profile-history.js
│       ├── 50-audio-settings.js
│       ├── 60-chat.js
│       ├── 61-voice.js
│       ├── 70-actions.js
│       ├── 80-table-renderer.js
│       ├── 90-admin.js
│       └── 99-bootstrap.js
└── server.js
```

文件名前缀用于明确加载顺序，避免维护者误以为这些文件可以任意排序。

## 6. 静态资源服务

服务端目前只显式提供首页和头像资源。需要增加一个范围严格限定在 `public` 目录的静态资源入口：

```js
app.use(express.static(path.join(__dirname, 'public')));
```

不得使用：

```js
app.use(express.static(__dirname));
```

后者可能意外暴露以下生产数据或敏感文件：

- `data.json`
- `hands.jsonl`
- `feedback.jsonl`
- `secret.key`
- `mail.json`

首页路由仍保留：

```js
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});
```

## 7. CSS 拆分

### 7.1 第一批：完整提取

先将整个 `<style>` 内容原样搬至：

```text
PokerServer/public/css/app.css
```

在 `index.html` 中替换为：

```html
<link rel="stylesheet" href="/css/app.css">
```

这一批只改变资源位置，不进行任何样式分类或整理。

### 7.2 第二批：按现有顺序分类

完整提取并验证后，再按现有注释区块拆分：

| 文件 | 职责 |
|---|---|
| `00-shell.css` | reset、页面尺寸、整体布局、底部控制栏、基础响应式 |
| `10-auth-user.css` | 登录注册、用户顶栏、准备按钮 |
| `20-table.css` | 牌桌、座位、头像、扑克牌、底池、行动栏 |
| `30-lobby.css` | 管理员面板、大厅、创建房间、牌桌顶栏、比赛结算 |
| `40-panels.css` | 设置、聊天、语音、通用弹窗、个人主页、牌谱面板 |
| `50-effects.css` | 多次发牌、高牌定庄、飞币、表情和其他动画 |

引用顺序必须与原 CSS 的先后顺序一致：

```html
<link rel="stylesheet" href="/css/00-shell.css">
<link rel="stylesheet" href="/css/10-auth-user.css">
<link rel="stylesheet" href="/css/20-table.css">
<link rel="stylesheet" href="/css/30-lobby.css">
<link rel="stylesheet" href="/css/40-panels.css">
<link rel="stylesheet" href="/css/50-effects.css">
```

第一阶段不使用 CSS Layers，不修改选择器优先级，也不清理 HTML 内联样式。

## 8. JavaScript 拆分

脚本按照下面的顺序在 `</body>` 前加载：

```html
<script src="/js/00-state.js"></script>
<script src="/js/10-auth.js"></script>
<script src="/js/20-socket.js"></script>
<script src="/js/30-room.js"></script>
<script src="/js/40-profile-history.js"></script>
<script src="/js/50-audio-settings.js"></script>
<script src="/js/60-chat.js"></script>
<script src="/js/61-voice.js"></script>
<script src="/js/70-actions.js"></script>
<script src="/js/80-table-renderer.js"></script>
<script src="/js/90-admin.js"></script>
<script src="/js/99-bootstrap.js"></script>
```

### 8.1 `00-state.js`

保存共享状态和基础工具：

- Socket、用户、房间和牌局状态；
- `lastState`；
- `revealedCards`；
- `runitState`；
- `equityMap`；
- 邀请链接状态；
- 输入锁定状态；
- 筹码/BB 显示状态；
- `fmtChips` 等基础格式化函数。

第一阶段保留当前全局变量形式，不改为 class、store 或事件总线。

### 8.2 `10-auth.js`

保存：

- 登录；
- 邮箱注册验证码；
- 忘记密码；
- `authPost`；
- `onAuthSuccess`；
- `doLogout`。

### 8.3 `20-socket.js`

保存：

- `connectSocket`；
- 所有 `socket.on(...)` 注册；
- 重连处理；
- `game_state`；
- 发牌、摊牌、聊天、语音、胜率、多次发牌等服务端事件接收。

第一阶段允许它继续调用其他文件中的全局 UI 函数。第二阶段再逐步减少 Socket 层直接操作 DOM 的行为。

### 8.4 `30-room.js`

保存：

- 大厅与牌桌切换；
- 创建、加入、退出和解散房间；
- 房间邀请码；
- 坐下、站起和留座；
- 买入和补码；
- 比赛设置；
- 当前战绩面板。

### 8.5 `40-profile-history.js`

保存：

- 收件箱；
- 每日签到；
- Bug/建议反馈；
- 个人主页；
- 邮箱绑定；
- 生涯统计；
- 盈亏曲线；
- 牌谱列表；
- 牌谱详情；
- 牌谱回放。

如果该文件拆分后仍然过长，可在后续独立提交中继续拆为：

```text
profile.js
history.js
replay.js
```

### 8.6 `50-audio-settings.js`

保存：

- Web Audio 初始化；
- 发牌、行动、弃牌、获胜等提示音；
- 飞币、赢额和振动效果；
- 主题；
- 牌面设置；
- 快捷下注设置；
- 全屏切换；
- 头像资源常量。

### 8.7 `60-chat.js`

保存：

- 快捷短语；
- Emoji；
- 聊天面板；
- 头像弹层；
- 弹幕；
- 座位聊天和表情气泡。

### 8.8 `61-voice.js`

保存整个临时语音子系统：

- 录音状态；
- MIME 检测；
- 开始、结束和取消录音；
- 上传；
- 临时语音气泡；
- 语音播放和终止；
- 页面退出时的资源清理。

语音逻辑相对独立且状态较多，应单独成文件。

### 8.9 `70-actions.js`

保存玩家操作：

- Fold、Check、Call、Bet、Raise；
- 预操作；
- 快捷下注；
- 加注滑条；
- 精确下注；
- 主动亮牌；
- 行动加时。

### 8.10 `80-table-renderer.js`

保存所有牌桌渲染逻辑：

- `formatCard`；
- `cardBack`；
- `ringPos`；
- `renderSeats`；
- `buildSeat`；
- `render`；
- 底池和公共牌；
- 行动栏定位；
- 倒计时刷新；
- 筹码数字动画；
- 摊牌高亮。

第一阶段可以接受该文件仍然较长。后续可再拆为：

```text
cards.js
seats.js
board.js
action-bar.js
table-renderer.js
```

### 8.11 `90-admin.js`

保存：

- 管理员面板；
- 用户列表；
- 修改金币。

### 8.12 `99-bootstrap.js`

只保存页面初始化：

- 初始化按钮状态；
- 应用本地设置；
- 初始化语音录制；
- 注册全局页面事件；
- 检查本地 token；
- 自动登录；
- 连接 Socket；
- 页面退出时清理资源。

该脚本必须最后加载，确保其依赖的状态和函数已经定义。

## 9. 暂不拆分 HTML

移除内联 CSS 和 JavaScript 后，HTML 本体预计只有约 500 行，已经处于可维护范围。

浏览器原生没有适合当前项目的同步 HTML include。现在引入异步 fragment 会增加以下风险：

- DOM 尚未加载时执行初始化；
- `getElementById` 返回 `null`；
- 弹窗和按钮事件绑定时序变化；
- 页面加载闪烁；
- Capacitor WebView 与普通浏览器行为差异。

因此第一阶段继续保留单一 `index.html`。只有在未来正式引入构建工具后，才考虑将登录页、大厅、牌桌和弹窗拆成模板组件。

## 10. 实施批次

建议按以下提交推进：

1. `refactor(frontend): serve scoped public assets`
2. `refactor(frontend): extract stylesheet without visual changes`
3. `refactor(frontend): split stylesheet by existing sections`
4. `refactor(frontend): extract shared state and auth scripts`
5. `refactor(frontend): extract socket event handling`
6. `refactor(frontend): extract lobby and room UI`
7. `refactor(frontend): extract profile and hand history UI`
8. `refactor(frontend): extract chat voice and audio`
9. `refactor(frontend): extract game actions and table renderer`
10. `refactor(frontend): isolate bootstrap and admin code`

每个提交都必须能够独立运行和回滚。不要将所有文件拆分压缩到一个提交中。

## 11. 自动校验

### 11.1 内容等价校验

机械拆分阶段应校验：

```text
旧 index.html 中的 style 内容
=
新 CSS 文件按加载顺序拼接后的内容
```

以及：

```text
旧 index.html 中的 script 内容
=
新 JavaScript 文件按加载顺序拼接后的内容
```

允许忽略文件首尾空白，但不应存在其他内容差异。

### 11.2 语法与资源校验

每批至少检查：

- 所有 JavaScript 文件通过语法检查；
- 所有 CSS/JS URL 返回 200；
- 浏览器控制台没有语法错误、重复声明或 404；
- 页面加载时没有明显无样式闪烁；
- `npm test` 继续通过。

### 11.3 固定视觉基线

建议对以下视口保存重构前截图：

- `390 × 844`
- `430 × 932`
- `720 × 900`

至少覆盖：

- 登录页；
- 大厅；
- 创建比赛弹窗；
- 双人牌桌；
- 多人牌桌；
- 轮到自己行动；
- 加注面板展开；
- 摊牌；
- 牌谱回放；
- 设置、聊天、个人主页等主要弹窗。

机械拆分前后应进行截图对比，目标是没有可观察的视觉差异。

## 12. 功能回归清单

每个批次至少确认：

- 登录、注册、找回密码和自动登录正常；
- 大厅和房间列表正常；
- 创建、邀请码加入和退出房间正常；
- 坐下、站起、补码和留座正常；
- 开局、发牌、下注、弃牌和摊牌正常；
- 多次发牌和全押胜率正常；
- 断线重连不会闪回大厅；
- 聊天、表情和语音正常；
- 设置保存和恢复正常；
- 个人主页、统计、签到、反馈和收件箱正常；
- 牌谱列表、详情和回放正常；
- 管理员面板正常；
- Android Capacitor 薄壳可以正常加载线上资源。

## 13. 第二阶段方向

完成本设计中的机械拆分并稳定一段时间后，再考虑真正的依赖边界治理：

1. 使用单一 `state` 对象替代散落的全局变量；
2. 让 Socket 层只负责事件转发，不直接操作 DOM；
3. 将纯格式化和牌桌计算函数改为可单元测试模块；
4. 逐步移除 HTML 内联 `onclick`；
5. 为模块建立明确的导入导出关系；
6. 再评估 ES Modules、TypeScript 或构建工具；
7. 最后评估是否需要前端框架。

第二阶段不应与第一阶段混合提交。

## 14. 完成标准

第一阶段满足以下条件时视为完成：

- `index.html` 只保留页面结构和资源引用；
- 内联 `<style>` 已完全移除；
- 大段内联 `<script>` 已完全移除；
- CSS 和 JavaScript 按本设计完成职责拆分；
- 没有修改现有 DOM ID、CSS class 和 Socket 协议；
- 固定视口的前后截图没有可观察差异；
- 功能回归清单通过；
- 服务端数据文件和敏感文件未被静态暴露；
- 每个迁移提交都可以独立回滚。

本次重构的最终原则是：

> 第一阶段建立文件边界，第二阶段建立依赖边界；先保证行为不变，再改善内部设计。
