# Changelog

All notable changes to Poker Dojo. This project loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are UTC+8.

## [1.4.0] — 2026-09-11

> 这一批的主题是**打磨**，不是加玩法：「几个好朋友能玩」的目标已经达到，
> 下一步是成熟的商业化作品，所以把已有的东西逐项做精细。
> ⚠️ 1.3.0 / 1.3.1 / 1.3.2 当时只涨了版本号、没在这里补节，暂缺。

### 新增
- **键盘快捷键**（F 弃 / C 过跟 / R 加注 / A 全下 / Enter 确认 / 空格准备），
  支持自己改绑定、冲突检测、恢复默认；加注面板可用**鼠标滚轮**调额
  （步长 0.5/1/2/5 BB 可设，按住 Shift ×10）。
- **设置面板分页**：8 个区块拆成 外观 / 牌桌 / 操作 三页，切页时整框高度不再跳动。
- **双语关卡** `tools/check-i18n.js`（已接入 `npm run check`）：玩家能看到的中文
  必须有英文版，否则不让发版。

### 调整
- **全站配色统一到道场绿**：原本道场绿牌桌 / 深蓝面板 / 黑登录页三套并存，
  切一次界面断裂一次。现在是一套。
- **金色收敛**到「钱 / 赢 / 我 / 奖励 / 品牌」，75 处降到 61 处 —— 都金等于没有重点。
- **节奏统一**：动效 33 种时长收敛成 4 档，圆角 16 种收敛成 4 档。
- **牌桌视觉层级**：行动者放大一点 + 其余座位同时压暗，「轮到谁」一眼可见；
  底池与公共牌垫一层向外淡出的暗影，把桌心抠出来；
  straddle 小旗不再永久闪烁（它是常驻元素，一直闪会和「轮到谁」抢注意力）。
- **无障碍最小集**：11 个纯 emoji 图标按钮补文字标签（明眼新用户也猜不出那排图标
  是干嘛的，不只是读屏问题），桌面播报区加 `aria-live`。

### 修复
- **英文界面下大量中文漏网**：服务端拒绝提示、牌桌「XX 想看河牌」、房间码报错、
  登录/注册/找回密码/绑邮箱/语音/改名的全部报错、牌谱回放、语音模块、
  下注信息条、index.html 十余处静态文案 —— 逐条补齐。
- 切语言后**快捷键面板不跟着变**：`setLang` 里维护着一张手写的重渲染清单，
  后加的面板永远会被漏掉。改成各模块自己登记。
- 5 处写死的 `toLocaleString('zh-CN')` —— 英文用户看到的仍是中式日期。
- 牌谱回放里牌的数字/花色撑爆牌面（缩小牌面只改了 `width` 没改 `--card-w`）。
- 比赛设置里「UTG Straddle」「比赛加时」两行标签深蓝落在深绿底上看不清。
- **全下快捷键按了没反应**（调用的函数名写错，而测试按同样的错名字打了桩，所以一路全绿）。
- **点开聊天框、没点输入框时按 F 会把牌弃掉**：判可见用了 `offsetParent`，
  而浮层是 `position: fixed`，它的 `offsetParent` 恒为 null。

## [1.2.1] — 2026-08-11

### 调整
- 开场画面太快：入场动画约 1.0s 才结束，而 450ms 就开始淡出，动画没做完就走了。
  最短展示 450→1150ms，入场动效整体放缓，淡出 .32→.42s。

## [1.2.0] — 2026-08-11

### 新增
- **开场画面**：进入游戏不再是直接蹦出功能主界面。深绿底 + 鸟居扑克 logo
  的入场动效，与原生启动图同色衔接。
  - 关键样式内联在 `<head>`，外链 CSS 到达前就是深绿底（否则先闪一下白）。
  - 约束（薄壳每次启动都会看到它）：最多 800ms、点一下可跳过、与加载并行、
    网络卡住也一定会撤、撤场后不挡点击。
- **原生启动图**（`@capacitor/splash-screen`）：APK 启动的白屏段补上同色启动图；
  网页首屏画好后主动调 `SplashScreen.hide()` 交接，不用干等。**需重新出 APK 才生效。**

## [1.1.2] — 2026-08-11

### 修复
- 版本行没有真正贴在页面底部：房间列表为空时它跟在列表后面浮在半空中。
  `#lobby-view` 改纵向 flex + `.lobby-version { margin-top: auto }` 顶到底部。

## [1.1.1] — 2026-08-11

### 修复
- 版本信息从设置面板底部（`max-height:90dvh` + 滚动，手机上要滑到底才看得到）
  移到**大厅底部**，落地即可见。

## [1.1.0] — 2026-08-11

版本号规则：只在**上生产**时递增（测试服部署不涨号）。判定按**玩家视角**，
不是 semver 的 API 兼容性 —— 主 = 大改版 / 次 = 新功能 / 修订 = 修 bug。
线上实际跑的版本可用 `GET /api/version` 查，设置面板底部也会显示。

### 修复（经济正确性，都是真实发生过的）
- **多次发牌绕过边池**：短码全押者只对主池有资格，却能按总底池分到边池的钱。
  改为逐池均分成 N 份，每份只在该池有资格者中比大小。
- **链式 straddle 同一人被问两档**：中途有人入座会让预测位置整体挪一位，
  上一档刚接受的人又被算成下一档候选 → 重复扣款且差额没进底池。
  改为按本手真实阵容校验位置 + 同一人不重复问 + 差额扣款。
- **补码幂等键复用**：序号存在内存座位对象上，站起/回座会归零 → 同键复用；
  金额相同时钱包不扣金币却照给筹码。改为按钱包账本条数推导，并把
  `applied:false` 当失败回滚。
- **改名后旧名字残留**：全库 20+ 处面向玩家的文案用的是账号名而非显示名。
- **牌局快照序列化失败**：新增的定时器字段未排除，Timeout 的循环引用让整个
  活跃牌局快照写不进去（重启恢复会失效）。

### 新增
- 现金桌训练时长到点**不再自动结算**：本手打完暂停发牌、等房主加时；
  **5 分钟无人处理则自动结算收桌**（房主掉线时筹码不会被永久锁住）。
- Straddle 邀请改成牌桌边缘的小标志（随时可点、点完消失、新一手自动收）。
- 版本信息：`GET /api/version` + 设置面板显示前端/服务端两个版本，
  不一致会提示玩家前端是缓存的旧版。

### 体验
- 手机端布局铺开：房间信息水印移回桌心（可被公共牌覆盖）、座位半径按实际
  角度精确反解、修正座位块高度少算的 15px。
- 横屏公共牌放大到 1.7 倍（原来比自己的手牌还小）。
- 手机端行动提示音（iOS Safari 回前台 AudioContext 被挂起）。
- 进行中牌局的实时盈亏（已下注筹码被算成了亏损）。

### 工程
- 部署关卡新增 `check-timers`（定时器字段必须排除出快照）。
- 发版后自动检查错误日志（只看重启之后新增的部分）。
- 部署后自动核对线上版本，取代过去 grep 关键字的土办法。

## [Unreleased]
- AI opponents (trained on per-player hand histories)
- Avatar upload, richer admin tools
- Per-action sound effects; flop dealt one card at a time
- Host-initiated blind change (requires all seated players to agree)

### Changed
- Cash training tables no longer settle and dissolve automatically when their scheduled time expires.
  They finish the current hand, pause dealing, and wait for the host to extend or shorten the schedule,
  end the match, or leave it paused.

## 2026-08-08 — SQLite persistence + crash recovery
### Changed
- **Storage moved from JSON files to SQLite** (`better-sqlite3`, WAL). Users, gold, wallet
  transactions, hand histories, feedback and **active-match snapshots** now live in one database
  outside the code directory (`POKER_DB_PATH`). Legacy `data.json` / `hands.jsonl` /
  `feedback.jsonl` are imported automatically on the first deploy and then kept read-only as a
  rollback path. Migration verified against real production data: users, gold totals, messages,
  feedback and all 10,090 hands matched **byte-for-byte**, and the reverse export (SQLite → legacy
  JSON) round-trips losslessly.
- Deploy scripts now stop the process, snapshot the database (SQLite Online Backup), run schema
  migrations, verify integrity/foreign keys, and only then restart — aborting on any failure
  rather than starting with uncertain data.
### Added
- **Crash/restart recovery** — an in-progress hand survives a restart: seats, chips, pot, board and
  action position are restored and players simply reconnect.
- **Wallet ledger** — every gold change is recorded (amount, type, related match, idempotency key),
  making balances auditable after the fact.
- **Chip-conservation audit** (`tools/audit-chips.js`) — poker is zero-sum, so within a hand the sum
  of ending stacks must equal the sum of starting stacks; any mismatch means chips appeared or
  vanished. Runs on demand, from the admin panel, or nightly with email alerts. It found the one
  real defect below among 10,090 hands.
- **Admin panel** — room overview, per-player wallet ledger, hand-history lookup, in-browser audit,
  compensation/deduction with a mandatory note (idempotent, fully logged), and inbox broadcasts.
- **Settlement podium** — playful per-match titles (biggest loser / biggest winner / most hands) plus
  a much more detailed inbox summary.
- **Portrait/landscape switch** — desktop browsers can use the full window instead of a phone-width
  column; card faces scale with height.
- New avatar set (27 poker/dojo icons); editable display names; four-digit room codes that submit
  automatically.
### Fixed
- **All-in players losing their claim to the pot** — leaving, standing up or being moved to the
  spectator seat mid-hand marked an all-in player as folded, which also made the uncalled-bet
  return misfire and created chips out of thin air (one live incident: 16,508 chips). All-in players
  can no longer be folded, and after the all-in reveal nobody holds the action.
- Run-it negotiation window was too tight (25s → 45s, with a fresh window for the leader and a
  visible countdown), which had silently degraded agreed multi-run hands into winner-take-all.
- Incomplete raises no longer reopen the betting round; players who already acted can only call or fold.
- Busted SNG players stay as spectators instead of being kicked to the lobby.
- Dissolving a room now waits for the current hand to finish.
- Seat layout: every player (name, stack, badges) is guaranteed on-screen for 2–9 players across
  portrait/landscape and a range of screen sizes, verified by an automated geometry test.

## 2026-07-24
### Added
- **Run it N times** — two-player all-in negotiation (underdog picks 1–5, leader agrees); pot split into N shares, dealt street-by-street on the table with per-run pot-to-winner animation; hand history records every runout.
- **Host controls** — pause/resume dealing (holds after the current hand), and force a player to the spectator seat.
- Public docs: bilingual README, LICENSE (PolyForm Noncommercial 1.0.0), CONTRIBUTING, SECURITY.
### Fixed
- **Side pots** — merge adjacent pots with identical eligibility and return uncalled bets, removing spurious "side pot 1/2/3…" and fixing run-it settlement with unequal stacks.
- **Action flow** — hand freeze when everyone is all-in from the blinds; a folded player standing up mid-hand stalling the table; already-called players being asked to act again; uncalled all-in players wrongly timed out.
- 9-max seat layout overlap; avatar-popup net now matches the stats panel.

## 2026-07 (earlier)
### Added
- Domain `pokerdojo.space` + TLS/HTTPS/WSS (Caddy); email accounts (verification codes, password reset); daily check-in, feedback inbox, data backups.
- Android build via Capacitor (GitHub Actions, thin shell pointing at the live site).
- Career stats (VPIP/PFR/3-bet/C-bet/AF/WTSD/net + curve); in-table chat, emotes, push-to-talk voice; hand-history replay UI.
- Anti-grief: lobby list = spectate-only, playing requires an invite link / room code.

## 2026-06
### Added
- **Multiplayer engine** (3–9 players): real action order, button rotation, true side pots; cash "training" tables and SNG tournaments; hand histories (JSONL).
- Server-authoritative rewrite hardening: **CSPRNG shuffle** (crypto, unbiased, unpredictable); **JWT signing key** per-server (no public default).
- Lobby + room creation/join, reconnect, invite codes.

## Earlier
- C# hand-evaluator prototype (Cactus Kev + Senzee perfect hash) → JS port.
- Socket.IO multi-room heads-up engine, staged betting, user accounts (JWT, gold economy), table UX v1–v2, production deployment.

_For legacy development notes, see [`docs/archive/`](./docs/archive/)._
