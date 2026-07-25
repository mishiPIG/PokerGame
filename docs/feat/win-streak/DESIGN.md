# 现金桌「连胜游戏」扩展设计

> 状态：设计完成，尚未实现
>
> 产品：德扑道场（Poker Dojo）
>
> 适用模式：仅现金桌 / 训练赛
>
> 更新时间：2026-07-25

## 1. 一句话规则

房主开启后，从下一手正式开始一个限时连胜局。某玩家连续独占整手全部有效底池时，
连胜数递增；达到 3、4、5 手及以上时，本手其他所有参赛玩家分别向他支付房主设定
的 BB 奖金。

默认奖励为：

| 本手结算后的连胜数 | 每名其他参赛玩家支付 |
|---:|---:|
| 1～2 | 0 |
| 3 | 5 BB |
| 4 | 10 BB |
| 5 及以上 | 20 BB |

这里的「五连胜封顶」只封顶**单人每手支付档位**，不封顶连胜数字，也不是第五手
只发一次。第 6、7、8……手继续获胜时，每手仍由每名其他参赛玩家支付 20 BB。

连胜奖金使用桌内记分牌，不直接扣用户金币，不计入正常底池，不产生平台抽水。

---

## 2. 房主配置

现金桌创建页和「比赛设置」增加：

```text
连胜游戏                  [关闭 / 开启]
游戏时长                  [15 分钟 / 30 分钟]
三连胜奖励                [5] BB
四连胜奖励                [10] BB
五连胜及以上奖励          [20] BB
```

第一版规则：

- 默认关闭；
- 时长默认 15 分钟，只接受白名单值 `15 / 30`；
- 奖励默认 `5 / 10 / 20 BB`；
- 房主可以修改三个奖励档位，均须为 `1～100` 的整数；
- 必须满足 `reward3BB <= reward4BB <= reward5PlusBB`；
- 只有房主可以修改；
- SNG 不展示，也不接受配置；
- 服务端必须校验和 clamp，不能相信客户端传值；
- 活跃连胜局的时长、奖励和 BB 一经开始即锁定，房主修改只影响下一局。

如产品首版希望减少配置，可只开放默认预设 `5 / 10 / 20`，数据结构仍保留三个字段，
以后无需迁移即可开放自定义。

---

## 3. 什么叫「赢一手」

### 3.1 唯一连胜口径

只有同一名玩家获得本手**全部实际发放的有效底池**，才算赢得这一手并延续连胜。
应复用鱿鱼游戏的结构化 `handOutcome` 和「完整赢池」判定，不根据客户端动画、
`winnerId` 或文案猜测结果。

算赢一手：

- 其他玩家全部弃牌，最后一名未弃牌玩家独得底池；
- 正常摊牌，一名玩家独得全部底池；
- 存在主池和边池，但同一玩家独赢全部池；
- 发多次牌，同一玩家独赢每一次 runout 的全部份额。

不算任何人赢一手，并且会打断已有连胜：

- 平分底池；
- A 赢主池、B 赢边池；
- 多次发牌由不同玩家获胜；
- 任意一个 runout 出现平局；
- 因异常而取消、回滚或无法确认结果的手牌。

未被跟注而退还的筹码不是底池奖金，不参与判断。

### 3.2 连胜状态是单一的

因为每一手只有「独占全部有效底池」的一名赢家才计数，所以牌桌只需要维护一个
当前连胜者：

```js
currentLeaderId
currentCount
```

每手结算：

```text
本手完整赢家 = currentLeaderId  → currentCount += 1
本手完整赢家是其他玩家          → currentLeaderId = 该玩家，currentCount = 1
本手没有完整赢家                → currentLeaderId = null，currentCount = 0
```

连胜游戏开启前的历史胜负不追溯。第一手完整赢家从 1 连胜开始。

### 3.3 不参与的玩家

观众、站起、留座离开、坐出、零筹码或本手未收到牌的玩家：

- 不能在该手获得或延续连胜；
- 不为该手奖金付款；
- 不分享该手奖金。

当前连胜者若下一手未实际收到牌，不论是主动坐出、掉线后超时站起、筹码不足还是
离场，均视为连胜结束。不能暂停个人连胜等回来后继续。

---

## 4. 奖金触发与付款人

### 4.1 触发时机

先完成正常扑克底池结算，再更新连胜数，然后判断奖金档位：

```js
function rewardBBFor(count, config) {
    if (count < 3) return 0;
    if (count === 3) return config.reward3BB;
    if (count === 4) return config.reward4BB;
    return config.reward5PlusBB;
}
```

奖金不会加入当前手底池，也不会改变边池、牌力、下一手按钮位或牌谱中的正常
`netFromPot`。

### 4.2 「其余所有在场玩家」的精确定义

付款人是**该手实际收到两张底牌的所有玩家，排除连胜赢家本人**。

因此：

- 本手中途弃牌者仍须付款；
- 本手全押输光者仍须付款；
- 本手开始后掉线或退出者仍须付款；
- 观众、开手前已坐出者不付款；
- 本手结束后才入座者不补交；
- 加入连胜局中途的新玩家，从其第一次实际收到牌起参与付款和争取连胜。

付款名单必须在发牌时快照为 `handParticipants`，不能在结算时按当前 Socket 在线状态
或座位数组重新推导，否则玩家可通过中途退出逃避。

### 4.3 示例

6 人收到牌，A 的本手胜利使其达到四连胜，四连胜档位为 10 BB：

```text
B、C、D、E、F 各支付 10 BB
A 共收到 50 BB
```

奖金是严格零和转移：

```text
winnerCredit === sum(eachPayerDebit)
```

---

## 5. 每手保证金：确保「每个人都要给」

### 5.1 为什么需要保证金

不能等底池结算后再直接扣款。付款人可能已经在正常牌局中 all-in 并输到 0，
如果允许少付，会违反「每个人都要给」；如果允许负筹码，会破坏下注、兑出和金币
经济模型。

连胜奖金的最大风险可以在每手开始前准确知道，因此采用**按手、按需锁定**，不需要
锁整场的无限风险。

### 5.2 按需锁定算法

只有当前连胜者已经至少二连胜时，下一手才可能触发奖金：

| 开手前连胜数 | 连胜者若再赢 | 每名潜在付款人锁定 |
|---:|---:|---:|
| 0～1 | 最高到二连胜，无奖 | 0 |
| 2 | 达到三连胜 | `reward3BB × sessionStartBB` |
| 3 | 达到四连胜 | `reward4BB × sessionStartBB` |
| 4 及以上 | 达到五连胜或继续 | `reward5PlusBB × sessionStartBB` |

发牌前：

1. 先让本来应在下一手生效的 `pendingRebuy` 正常入账；
2. 计算原本可收到牌的候选玩家；
3. 如果当前连胜者不在候选名单，先结束其连胜，本手无需锁奖金；
4. 如果存在潜在奖金，从除连胜者外的每名候选玩家筹码中锁定相同金额；
5. 锁定后该金额不能下注、兑出或再次作为其他保证金；
6. 正常发牌，并把最终收到牌者和各自锁定额写入本手快照。

本手结束：

- 连胜者获胜：把每名付款人的应付额全部转给赢家；
- 连胜者未获胜或没有完整赢家：原额退回每名付款人；
- 无论结果如何，本手保证金状态清零，下一手重新计算。

潜在赢家本人无需锁奖金，因为他若获胜不会给自己付款；他若未获胜，其他玩家最多
只有 1 连胜，本手不会突然触发奖金。

### 5.3 保证金不足

不允许部分支付。任一候选付款人不足额时：

- 暂不发下一手，状态进入 `pending_funding`；
- 明确显示玩家和所差筹码；
- 玩家可以补码，或主动坐出/站起而退出下一手候选名单；
- 房主不能单方面免除某一名仍要参赛玩家的付款；
- 候选名单变化后重新计算；
- 至少 2 名可玩玩家且所有潜在付款人足额，才恢复发牌。

这意味着玩家可以选择不参加后续手牌来避免新的风险，但不能一边收到牌、一边拒绝
支付本手奖金。

锁定后必须断言：

```text
每名付款人 escrow === upcomingRewardBB × sessionStartBB
escrowTotal === sum(每名付款人 escrow)
每名玩家 playableChips >= 0
```

---

## 6. 计时与加时

### 6.1 开始计时

房主点击开启只创建 `pending_start`，不立刻倒计时：

- 当前正在打牌：该手完全不属于连胜游戏，从下一手发牌时开始；
- 正在局间：从下一手发牌时开始；
- 尚未开赛或人数不足：等第一手真正发出底牌才开始；
- 因保证金不足无法发牌：计时也不开始。

服务端在目标手正式进入 `preflop` 时一次性写入：

```text
startedAt = Date.now()
endAt = startedAt + durationMinutes × 60_000
sessionStartBB = 当时房间正常大盲
```

`sessionStartBB` 整局锁定。Ante、Straddle 和以后可能出现的升盲都不改变本局奖金的
筹码换算；下一局才使用新的 BB。

### 6.2 到点不打断当前手

计时器到点时：

- 若正在一手牌中，只标记 `timeExpired = true`，不打断下注；
- 该手仍完整属于连胜游戏，照常更新连胜、发放可能的奖金；
- 在该手全部正常结算和连胜奖金结算之后，才判断是否结束或进入加时。

用「开手时间早于 `endAt`」判断该手是否属于常规时段。到点后不能再抢开一手新牌。

### 6.3 什么叫「处于连胜阶段」

本设计将其精确定义为：**计时到点后的安全结算点，当前玩家已达到至少二连胜**。

选择二连胜而不是一连胜，是因为每个有唯一赢家的最后一手都会自然产生一连胜；
若一连胜也强制加时，几乎每局都会被延长。选择二连胜也能保护玩家从二连胜冲击
第一个三连胜奖金的机会。

到点后：

```text
currentCount < 2   → 连胜游戏立即结束
currentCount >= 2  → 进入 sudden_death，锁定 protectedLeaderId
```

### 6.4 加时只保护到点时的连胜者

加时不是新的计时段，也没有固定上限：

- 只保护到点瞬间的 `protectedLeaderId`；
- 他继续独占整池，连胜继续，3/4/5+ 奖金照常逐手发放；
- 他输掉、平分、分池、未收到下一手牌或手牌异常取消时，连胜立即断开；
- 断开该连胜的那一手正常完成后，连胜游戏正式结束；
- 加时期间新赢家形成的 1 连胜不继承、不重新启动加时；
- 即使新赢家随后理论上可能连胜，也要等房主下一次开启新的连胜局。

冻结保护对象可防止 A 的连胜结束后由 B 接力，再由 C 接力，导致游戏无限延长。

### 6.5 多人“正在连胜”的问题

按第 3 节完整赢池口径，任一时刻最多只有一名当前连胜者，因此不会出现两个受保护
连胜同时等待结束。未来若产品改成「赢任意边池也算」，必须重新设计多人保护集合，
不能直接复用本规则。

---

## 7. 开启、关闭和重复开启

### 7.1 生命周期

```text
disabled
  → pending_start
  → active
  → time_expired
      ├─ currentCount < 2 → settled
      └─ currentCount >= 2 → sudden_death
                              → protected streak breaks
                              → settled
```

### 7.2 房主中途关闭

房主不能在看到有人二连胜后立即关闭来逃避潜在奖励：

- 当前手照常完成；
- 关闭请求记录为 `stopRequested`；
- 若结算后当前连胜不足 2，立即结束；
- 若结算后已有至少 2 连胜，按 sudden-death 规则等该连胜结束；
- 已锁的本手保证金必须先退款或转账；
- 关闭不追溯已发出的奖金。

### 7.3 再次开启

- 活跃或加时中重复开启是幂等操作，不重置计时和连胜；
- 当前局结束后，房主若保持开关为开启，可在**下一手开始一局全新的 15/30 分钟
  连胜游戏**；
- 新局的连胜从 0 开始，不继承上一局；
- 第一版建议每次结束后自动把开关恢复为关闭，要求房主主动再次开启，避免朋友局
  忘记开关而连续产生高额转账。

---

## 8. 入座、离场、断线和人数变化

### 8.1 中途加入

连胜游戏不像鱿鱼轮那样需要固定全局成员，可以允许玩家中途加入：

- 先作为观众加入；
- 成功坐下后，从下一手开始成为参赛玩家；
- 如果下一手存在潜在奖金，必须先足额锁定对应保证金；
- 不继承任何个人连胜。

### 8.2 中途离场

- 开手前坐出/站起：不进入该手快照，不付款；若是当前连胜者则连胜结束；
- 开手后弃牌、掉线、站起申请或退出房间：仍在该手快照内，保证金已锁，照常付款；
- 本手结束后才真正执行站起/退出；
- 离线不影响本手奖金结算；
- 回来后从新的 1 连胜重新开始。

### 8.3 人数不足

- 新连胜局至少需要 2 名可玩玩家；
- 活跃期间不足 2 人时暂停发牌，常规计时继续流逝；
- 到点时若没有正在进行的手，按当前连胜判断结束或加时；
- sudden-death 中若受保护玩家无法与至少一名其他玩家继续发牌，其连胜视为结束，
  连胜局正式结束；
- 不允许单人通过等待或反复重连无限保留连胜。

### 8.4 掉线重连

- 状态只以服务端为准，不依赖 localStorage；
- 本手中掉线沿用现有行动计时器，不立即弃牌；
- 玩家重连后恢复当前连胜局、保证金和剩余时间展示；
- 重传事件不能重复发奖或重复退款。

---

## 9. 与现有玩法的关系

### 9.1 正常扑克规则

连胜游戏不改变：

- 发牌和随机性；
- 下注额度与最小加注；
- 主池、边池和未跟注退回；
- 摊牌、亮牌隐私；
- 多次发牌协商；
- 按钮、盲注、Ante、Straddle；
- 正常牌谱的扑克输赢。

奖金在底池结算完成后作为独立账本转账。

### 9.2 多次发牌

只有同一玩家独赢所有 runout 才算赢一手。不同 runout 各有赢家或任意 runout 平分，
都会打断当前连胜。连胜奖金不随 runout 次数拆分。

### 9.3 鱿鱼游戏共存

两种扩展可以同时开启，且都复用统一 `handOutcome`：

```text
正常底池结算
  → 生成统一 handOutcome
  → 连胜状态更新及奖金结算
  → 鱿鱼完整赢池资格与主动秀牌窗口
  → 牌谱落库
  → 下一手 / 结束比赛
```

资金口径：

```text
playerTableAssets
  = playableChips
  + pendingRebuy
  + squidEscrow
  + winStreakHandEscrow
```

鱿鱼轮保证金先保持锁定；连胜的按手保证金再从剩余可用筹码中锁定。若不足，进入
`pending_funding`，不能挪用鱿鱼保证金。

### 9.4 训练赛总时长到期或房主结束比赛

如果整场训练赛到期/房主请求结束时，连胜局正处于：

- 普通手牌中：先完成本手；
- `sudden_death`：必须等受保护连胜结束；
- 本手保证金结算中：必须先完成零和转账；
- 无受保护连胜：可以在安全结算点结束整桌。

若鱿鱼轮也在阻止结束，必须等待**所有**扩展解除阻止后再兑出。实现上建议把现有
单一 `pendingEndAfterSquid` 演进为：

```js
game.pendingMatchEnd = {
    requested: true,
    reason: '训练时长已到',
    blockers: ['squid', 'win_streak']
};
```

每个扩展只能移除自己的 blocker，不能直接结束牌桌。集合为空后统一调用
`endCashTable()`，避免两个模块互相抢结算。

### 9.5 房主给整场训练赛加时

训练赛加时与连胜局计时是两个概念：

- `extend_match` 只延长整场训练赛；
- 不修改已开始连胜局的 `endAt`；
- 连胜局是否续时只由 sudden-death 规则决定；
- 若产品以后要支持「连胜局加时」，应新增独立事件，不能复用 `extend_match`。

---

## 10. 服务端数据设计

### 10.1 模块

```text
PokerServer/src/games/poker/extensions/win-streak/
├── win-streak-rules.js
└── win-streak-service.js
```

`win-streak-rules.js` 只放纯函数：

- 从 `handOutcome` 判断完整赢家；
- 计算下一手可能的奖励档位；
- 计算保证金；
- 计算零和转账；
- 校验状态不变量。

`win-streak-service.js` 负责：

- 配置和生命周期；
- 开始/结束计时；
- 发牌前保证金；
- 接收统一 `handOutcome`；
- 更新连胜和派奖；
- 加时保护；
- 广播状态；
- 审计落库；
- 向现金桌生命周期注册结束 blocker。

### 10.2 运行时状态

```js
game.winStreak = {
    config: {
        enabled: false,
        durationMinutes: 15,
        reward3BB: 5,
        reward4BB: 10,
        reward5PlusBB: 20
    },

    lifecycle: 'disabled',
    // disabled | pending_start | active | pending_funding
    // | time_expired | sudden_death | settled

    session: {
        sessionId: 'roomId:win-streak:1',
        sessionNo: 1,
        startedAt: 0,
        endAt: 0,
        durationMinutes: 15,
        sessionStartBB: 40,
        rewards: {
            three: 5,
            four: 10,
            fivePlus: 20
        },

        currentLeaderId: null,
        currentCount: 0,
        protectedLeaderId: null,
        timeExpired: false,
        stopRequested: false,

        handEscrow: null,
        totals: {
            rewardsTriggered: 0,
            chipsTransferred: 0
        }
    },

    timer: null
};
```

每手保证金：

```js
handEscrow: {
    handSeq: 123,
    leaderId: 'userA',
    leaderCountBeforeHand: 3,
    rewardBB: 10,
    unitChips: 400,
    participantIds: ['userA', 'userB', 'userC'],
    payers: [
        { userId: 'userB', escrow: 400 },
        { userId: 'userC', escrow: 400 }
    ],
    escrowTotal: 800,
    status: 'locked' // locked | refunded | transferred
}
```

必须满足：

```text
currentLeaderId === null  ⇔ currentCount === 0
protectedLeaderId !== null ⇒ lifecycle === sudden_death
handEscrow.escrowTotal === sum(handEscrow.payers[].escrow)
同一 handSeq 最多结算一次
总奖励入账 === 总付款扣账
所有玩家 playableChips >= 0
```

### 10.3 公共状态

`game_state` 增加不含底牌的数据：

```js
winStreak: {
    enabled: true,
    lifecycle: 'active',
    startedAt: 0,
    endAt: 0,
    durationMinutes: 15,
    currentLeaderId: 'userA',
    currentCount: 3,
    protectedLeaderId: null,
    rewards: { three: 5, four: 10, fivePlus: 20 },
    sessionStartBB: 40,
    pendingFunding: [
        { userId: 'userB', shortfall: 120 }
    ]
}
```

本手保证金可在对应玩家公开状态中展示锁定总额，但不能混入 `chips`：

```js
winStreakEscrow: 400
```

客户端显示的总桌内资产和战绩必须把它加回来，避免锁款瞬间显示为亏损。

### 10.4 Socket 协议

客户端 → 服务端：

```text
set_win_streak_config {
    enabled,
    durationMinutes,
    reward3BB,
    reward4BB,
    reward5PlusBB
}
```

服务端 → 客户端：

```text
win_streak_pending
win_streak_started
win_streak_changed
win_streak_reward
win_streak_funding_required
win_streak_overtime
win_streak_ended
```

`game_state` 是可恢复的真相；一次性事件只负责动画和提示。重连错过事件后仍能从
完整状态恢复。

---

## 11. 结算顺序、幂等与异常

### 11.1 每手安全顺序

```text
1. 正常扑克底池全部发放
2. 生成结构化 handOutcome
3. 以 handSeq 幂等更新连胜
4. 转移或退回本手连胜保证金
5. 写本手连胜审计
6. 处理鱿鱼领取窗口及结算
7. 保存完整牌谱
8. 检查连胜局到点 / sudden-death
9. 处理站起、补码、下一手或整桌结束
```

不能先清 `game.hand`，也不能先调用 `scheduleNextHand()` 或 `endCashTable()`。

### 11.2 重复事件

服务端按 `(sessionId, handSeq)` 保存终态：

- 同一手重复收到 `onHandSettled` 不重复增加连胜；
- 不重复扣保证金；
- 不重复给赢家入账；
- 不重复写完成审计；
- 客户端重传配置只返回当前状态。

### 11.3 服务器重启

当前牌桌主体仍在内存中，第一版不承诺重启恢复进行中的现金桌，但必须保证：

- 已完成的每手奖金和 session 总结写入 JSONL；
- 同一 `sessionId + handSeq` 有唯一幂等键；
- 审计文件不被 deploy 覆盖，并进入每日及异地备份；
- 未来牌桌支持断点恢复时，必须连同 `handEscrow` 一起原子恢复；
- 不能只恢复连胜数字，却丢失已扣保证金。

若运行中出现无法继续的致命异常，优先原额退还仍处于 `locked` 的本手保证金，再
执行现金桌灾难结束；不得根据一个未完成的手牌发奖金。

---

## 12. 审计和牌谱

新增：

```text
PokerServer/win-streak-sessions.jsonl
```

每局结束追加一行，至少记录：

```js
{
    sessionId,
    roomId,
    startedAt,
    scheduledEndAt,
    endedAt,
    durationMinutes,
    sessionStartBB,
    rewards,
    endReason, // timer | protected_streak_broken | host_stop | match_end | cancelled
    overtime: {
        entered: true,
        protectedLeaderId,
        startedAt,
        endedAt
    },
    hands: [
        {
            handSeq,
            completedAt,
            participantIds,
            fullWinnerId,
            leaderBefore,
            countBefore,
            leaderAfter,
            countAfter,
            rewardBB,
            unitChips,
            payers,
            winnerCredit,
            escrowStatus
        }
    ],
    totals,
    status // completed | cancelled
}
```

考虑一局 30 分钟可能包含很多手，正式实现时也可采用：

- `win-streak-hands.jsonl`：每手一行；
- `win-streak-sessions.jsonl`：每局摘要一行。

两份都应纳入 `backup.sh`、deploy 排除列表和服务器迁移清单。普通
`hands.jsonl` 中增加扩展字段，方便回放：

```js
extensions: {
    winStreak: {
        leaderBefore,
        countBefore,
        leaderAfter,
        countAfter,
        rewardTransfers
    }
}
```

连胜奖金应和正常底池输赢分栏，统计总盈亏时相加，分析 VPIP/PFR 等扑克指标时忽略
扩展奖金。

---

## 13. 前端表现

### 13.1 比赛设置

- 房主可开启、选择 15/30 分钟和三个 BB 奖励；
- 非房主只读；
- 明示「第 5 胜后每次继续获胜仍触发最高档」；
- 开启后显示「从下一手开始计时」；
- 活跃局修改配置显示「下一局生效」；
- 保证金不足显示具体玩家和差额。

### 13.2 牌桌

- 顶部或底池旁显示：`🔥 连胜游戏 12:34`；
- 当前连胜者头像显示火焰和 `×3`；
- 达标派奖显示：`A 四连胜！B/C/D 各支付 10BB，A +30BB`；
- 保证金锁定用小锁标记，和可下注筹码分开；
- 到点进入加时显示：`🔥 加时：等待 A 的 4 连胜结束`；
- protected 玩家输掉后显示结果，再关闭扩展 UI；
- 奖金筹码动画应区别于正常收池动画，避免玩家误以为底池算错。

### 13.3 回放

牌谱回放在正常收池动画后增加一帧「连胜奖励」：

- 连胜数变化；
- 各付款人扣款；
- 赢家总入账；
- 若无完整赢家，显示「连胜中断」；
- 不把奖金加入公共牌桌底池数字。

---

## 14. 必测场景

### 14.1 基础连胜

1. A 连赢 1、2 手：无奖金；
2. A 第 3 手获胜：其他每人付 5 BB；
3. A 第 4 手获胜：其他每人付 10 BB；
4. A 第 5、6、7 手获胜：每手其他每人付 20 BB；
5. A 输给 B：A 连胜归零，B 从 1 开始；
6. 平分、分池、runout 不同赢家：所有连胜归零。

### 14.2 付款和资产

1. 弃牌玩家仍付款；
2. 全押输光玩家仍从已锁保证金足额付款；
3. 观众、坐出者不付款；
4. 开手后退出不能逃避；
5. 保证金不足阻止发牌，补码后恢复；
6. 玩家坐出后重新计算名单和金额；
7. 付款总额与赢家入账严格相等；
8. 排名、兑出前后总资产守恒。

### 14.3 时间

1. 点击开启后等待很久才开手：等待时间不计入；
2. 到点时正在打牌：完整打完并可能派奖；
3. 到点后连胜为 0/1：立即结束；
4. 到点后为 2 连胜：保护至该玩家输掉；
5. 加时中连续赢到 6：依次发 5/10/20/20 BB；
6. 加时中 B 打断 A：B 的新 1 连胜不继续延长；
7. protected 玩家坐出、离场或无法凑够两人：结束；
8. 到点、房主结束比赛和鱿鱼 blocker 同时发生：全部结算一次后才兑出。

### 14.4 幂等和异常

1. 重复 `onHandSettled` 不重复发奖；
2. Socket 重连不重置连胜；
3. 同一配置事件重传不重开计时；
4. 结算中异常时保证金可原额恢复；
5. JSONL 写入失败报警，但不能因此把同一奖金发两次；
6. 服务端状态不向客户端泄露未公开底牌。

---

## 15. 推荐实现顺序

1. 先把三条现有结算路径统一稳定输出 `handOutcome`；
2. 实现 `win-streak-rules.js` 纯函数和资产守恒测试；
3. 实现 session 生命周期与计时；
4. 接入按手保证金、补码和离场流程；
5. 把现金桌结束条件改为通用 blocker 集合；
6. 接入公共状态、Socket 配置与前端；
7. 写 JSONL 审计和备份规则；
8. 最后做与鱿鱼、多次发牌、训练赛到点同时发生的 E2E。

实现时最重要的三个不变量是：

```text
连胜只由服务端结构化底池结果决定
任何奖金发放前，所有付款人的钱已经足额锁定
到点加时只保护到点时那一名至少二连胜的玩家
```
