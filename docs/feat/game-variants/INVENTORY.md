# 德州假设清单（2026-11-18 全库排查）

> 配合 `PLAN.md` 使用。行号以排查当天为准，动手前按函数名重新定位。
> **SD** = 短牌，**PLO** = 奥马哈。路径相对 `PokerServer/`。

## 1. 牌堆与洗牌
- `PokerLogic.js` `Deck.reset()`：花色在外、点数 `2..A` 在内建 52 张；**这个顺序就是可验证公平的重算起点**。SD 要 `6..A`（36 张）。
- `src/games/poker/provably-fair.js` `shuffledOrder` / `verifyHand`：对任意长度通用，不用改。
- `src/games/poker/hand-service.js` 开手处 `game.deck.reset(); shuffle(fairRng)`：改成按玩法建牌堆；`deckOrder` 长度会变成 36。
- `tools/verify-hand.js`：写死 52 张的顺序；底牌按 `replay[2*i], [2*i+1]` 取；公共牌起点 `2*人数`。SD 要 36 张，PLO 要 `4*i…4*i+3`、起点 `4*人数`。
- 52 张顺序另外两份：`equity.js` 开头、测试 `provably-fair.test.js` / `verify-hand-cli.test.js`。
- 重启恢复：`src/persistence/game-hydrator.js` 先 `new Deck()` 再覆盖牌 —— 玩法放在 `game.config`，不放在 Deck 上。
- `drawForButton`（高牌定庄）用自己的一副 52 张 + crypto 洗牌，不在可验证公平范围内；SD 照用无妨。

## 2. 发牌与底牌张数
- `hand-service.js` 发底牌：每人连发 `c1, c2`；`hole_cards` 私发 2 张。PLO 改成循环 4 次，`verify-hand.js` 按同一顺序。
- 牌谱 `seats[].hole` 长度通用；牌谱**没有玩法字段**。
- `run-it-service.js` `maxRunsByDeck` 通用（SD 单挑翻前全押最多 4 次，`RUNIT_MAX` 是 5）。
- 兔子牌（看后面的牌）通用；最坏情况 SD 9 人用 26/36、PLO 9 人用 44/52，都够。
- `src/socket/events/poker-card-events.js` 亮牌：`index !== 0 && index !== 1` 直接返回 —— PLO 要 0–3。

## 3. 牌力评估（最危险）
- `PokerLogic.js` `evaluate7Cards`：固定 21 种组合，**只看下标 0–6**。PLO 传 9 张会无声忽略后两张底牌。调用方：`showdown-service.js`、`run-it-service.js`、`equity.js`。
- `bestHand`：同样固定 7 张；`showdown-service.js` 按 `i < 5` 是公共牌、`i >= 5` 是底牌来拆高亮。
- `bestHandFrom`：任选 5 张。调用方：`state-presenter.js`（牌型提示 `my_hand`）、`hand-history-service.js`（牌谱牌型名）、`hand-guide.test.js`。PLO 规则不对。
- Cactus Kev 查表（`Unique5` / `Flushes` 按点数位图索引）：A-6-7-8-9 的位图不是顺子 → SD 会算成高牌 / 普通同花。
- `handCategory`：写死 Kev 的分段阈值和中文名。SD 要自己的档位顺序。
- 牌型名还出现在：`public/js/03-i18n.js` `HAND_CAT_EN`、`public/js/44-guide.js` `HAND_GUIDE`。

## 4. 下注上限
- 服务端 `src/socket/events/poker-action-events.js`：bet 上限 `currentBet + chips`，raise 上限同理；PLO 要加「跟注后的底池」上限，并新增双语拒绝提示。
- 下发给客户端的只有 `minBet` / `minRaiseTo`（`state-presenter.js`），**没有上限字段** —— PLO 要加。
- 客户端：`80-table-renderer.js` `setupSizing` 的 `maxTo`；`70-actions.js` `sizeForQuick`（`'allin'` = `maxTo`；`'pot'` 正好就是 PLO 上限）、`clampSize`、滑条（「拖到头 = 全下」）、数字键盘、下注信息条；`71-hotkeys.js` 快捷键 A 标「全下」。
- 预操作条显示条件里有 `myHoleCards.length === 2`。

## 5. 胜率 `equity.js`
- 写死 52 张牌堆；`holes[id].length === 2` 过滤（PLO 直接返回空 → 没有胜率徽章，多次发牌的「落后方」会默认成第一个人）。
- 评估用 `evaluate7Cards`。
- 性能：PLO 每次评估是 60 次 5 张评估；翻前 4 人蒙特卡洛约 190 万次 5 张评估，同步跑在事件循环上，每条街都会算一次 —— 要降采样或挪出主线程。

## 6. 牌谱与统计
- 牌谱字段见 `hand-service.js` / `hand-history-service.js` / `run-it-service.js`；**无玩法字段**。
- 数据库 `hands.mode` 与 `matches.room_type` 有 `CHECK IN ('cash','sng')` —— 玩法不能塞这两列。
- `stats.js`：模式筛选只认 cash / sng；VPIP 等指标本身与玩法无关，但三种玩法会混成一个数。缓存键也要带玩法。
- 回放 / 分享 / 可见性过滤（`hand-visibility.js`、`public-hand.js`）对底牌张数通用。

## 7. 客户端「2 张底牌」
- `80-table-renderer.js`：`myHoleCards.length === 2`（4 处：自己的牌、亮牌提示、预操作条…）、`[0, 1].map`（对手亮出的牌）、两张 `cardBack()` / `emptySlot()`、对手小牌背 `.opp-backs` 两张、发牌动画 `order.length * 2`、座位 `SEAT_BOX {w:68}`（4 张 30px 的牌约 128px，放不下）。
- CSS：`.opp-backs`（两张、一左一右旋转）、`.opp-cards`（30px）、`.self-cards`（「右边两张牌」）、回放 `.rp-cards`、牌谱 `.hd-hole` / `.hi-mine`。
- `42-replay.js`：被过滤掉的底牌退回 `[null, null]`；标题只写模式；示例牌局 `demoHand` 是 2 张（`guest.test.js` 守着）。
- `44-guide.js`：速查表顺子那行写「A 可以当 1：A-2-3-4-5」；新手提示「你的两张底牌」；`hg.note`「两张底牌 + 五张公共牌」。

## 8. 建房与配置
- `src/socket/events/lobby-events.js`：SNG 和现金桌两处 config 白名单都要加 `variant`；**`rematch_sng` 是逐字段复制 config 的，漏加玩法会在「再来一局」时丢失**。
- `index.html` 建房表单、`public/js/30-room.js` `submitCreate` / 房间卡片 / `renderMatchInfo`。
- `src/rooms/lobby-service.js` 房间列表摘要。
- `membership-events.js` 允许房主中途改 `approveBuyIn` / `allowUtgStraddle` —— 玩法必须**不可改**。

## 9. 测试里写死德州的
- 52 张：`provably-fair.test.js`、`verify-hand-cli.test.js`（发牌顺序 `2*i`、公共牌起点 6）。
- 牌型：`hand-guide.test.js`（10 行、德州顺序）、`showdown-readability.test.js`。
- 2 张底牌 / 5 张公共牌的夹具：`persistence.test.js`、`hand-share.test.js`、`hand-visibility.test.js`、`replay-runit.test.js`、`guest.test.js`（示例牌局）。
- 下注：`bet-pot-pct.test.js`、`bet-keypad.test.js`（`maxTo` = 全下）、`hotkeys.test.js`。
- 用 `new Deck()` 的引擎夹具：`short-blind.test.js`、`table-flow.test.js`、`think-time.test.js`、`fairness-state.test.js`（只在 Deck 构造函数签名变化时受影响）。

## 排查中顺带发现的
- CLAUDE.md 和 `80-table-renderer.js` 注释里多次提到的 `seatfit` 测试**仓库里不存在**（当时是一次性脚本，没入库）。座位几何改动（尤其 PLO 的 4 张牌布局）目前只能靠截图验。
- `PokerLogic/`（C#）里有一份旧的评估器副本，服务端不用。
