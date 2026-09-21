# Changelog

All notable changes to Poker Dojo. This project loosely follows
[Keep a Changelog](https://keepachangelog.com/). Dates are UTC+8.

## [1.8.1] — 2026-09-17

> 修一个**早就存在、但 1.8.0 又给它多开了一扇门**的隐私漏洞。

### 修复
- 🔴 **`/api/my-hands` 不再把同桌每个人的底牌发给你**。
  之前它直接返回整份牌谱，客户端 UI 会把弃牌者的牌盖上，但**网络响应里是有的** ——
  按一下 F12 就全看见了。危害是【竞技公平】而不是实时作弊（牌谱只在这手打完后才落库，
  查不到进行中的那一手），但「你弃牌从没亮过，对手事后能查出你拿的什么」等于一个免费 HUD。
  现在按查看者过滤，规则与客户端同源（是我自己 / 或者没弃牌且走到了摄牌），
  牌型名一并过滤（它是从底牌算出来的，留着等于泄露一半）。
- 🔒 **可验证公平的揭示时机：每手 → 整桌结束后**。
  1.8.0 是每手打完就公布种子 —— 而**公开种子等于公开整副牌**，
  连弃牌者从未亮过的底牌一起公开，恰好把上面那条过滤绕过去了。
  改成整桌结束后统一揭示：【不损害可验证性】，因为承诺在发牌前就公开了，只是晚点验。
  牌桌菜单的公平性面板与 README（中英）都改了措辞。

### 内部
- 新增 `src/games/poker/hand-visibility.js`，10 条单测 + **六条反向对照全咬住**；
  端到端跑真服务器 10 项（含「散桌后导出的牌谱仍能通过离线验算」）。
- `fairness-state.test.js` 里有一条契约被**故意反转**：原来断言「揭示要广播」，
  现在断言「一条都不许广播」。
## [1.8.0] — 2026-09-17

> 一条主线：**把「只能选择相信我」的地方，换成「你可以自己查」**。
>
> 三件事看上去不相干，其实是同一件：洗牌公不公平、服务坏了有没人知道、
> 这东西到底有没有人在用 —— 之前的答案都是「相信我」或者「我也不知道」。

### 新增
- **🔒 可验证公平（provably fair）**。洗牌一直是无偏的，但玩家**无法验证这一点**。
  现在每一手都在**发牌之前**公布 `SHA256(serverSeed)`，打完后公布种子，
  任何人能离线重算整副牌。桶内菜单 ☰ → 「🔒 公平性验证」；
  牌谱详情 → 「🔒 验证数据」导出，用 `tools/verify-hand.js` 自己跑。
  步骤写在 README（中英两份）。
  - 它证明的是：**服务器没法在看到任何人的牌之后改变牌序**。
  - 它没证明的是：服务器不能在承诺**之前**反复试种子（grinding）。钩子留好了，
    但玩家自选 clientSeed 的入口还没做。**写清楚比含糊过去重要。**
- **账号注销（App 内）+ 牌谱匿名化**。上架硬性要求，但难点是定策略：
  **抹掉身份、不删记录** —— 一手牌是好几个人共同的记录，
  删了它，同桌另外几个人的牌谱也一起没了。邮箱/密码/显示名/头像/牌友号/
  好友关系/站内信/反馈里的联系方式全部销毁，牌局记录原样留下、名字换成**随机**代号。
  金币作废、邮箱释放（可用同一邮箱重新注册）。
  三道闸：不在牌局里（含站起围观）/ 重输密码 / 不是最后一个管理员。
- **📈 运营指标面板**（管理面板）。DAU / 日手数 / 新注册 / 留存，
  日界线**显式 UTC+8**（不跟服务器时区走）。另加两个更该先看的数：
  **注册了却一手都没打过**、**只玩过一天**。
- **🐞 客户端报错上报**。前端 JS 报错原本只在玩家自己的 console 里，
  服务端一无所知（表现就是「点了没反应」）。每条带前端构建号，
  一眼分得出真 bug 还是缓存了旧 JS。
- **存活监控 + 崩溃告警**。服务半夜挂了/崩过，现在会有人被通知。
  崩溃告警的要点：**不让濒死的进程发邮件**（`process.exit()` 会在邮件发出前
  结束进程，告警会是哑的），改成崩时同步写盘、下一个健康进程发出去。
- **CI**（GitHub Actions）。Node 20 + 22 双矩阵跑 `npm run check` 与全部测试。

### 修复
- 管理面板右上角补上关闭按钮（之前面板一长，顶栏的 ⚙️ 已滚出视野，等于没有出口）。
- `.gitignore` 两处真问题：`ops/` 没错根，会吐掉**任意深度**的同名目录；
  另两条规则粘成一行导致**用户库备份文件没被忽略**（本仓库是 public）。
- 修正 README 一处**过度声称**：原来的 「Provably fair shuffle」当时只是 CSPRNG 无偏洗牌 ——
  公平，但**并不可验证**。现在才名副其实。

### 内部
- 洗牌算法**一个字没改**，只把随机源换成种子流；种子流用**拒绝采样**避免模偏。
  重跑发牌随机性自检（60000 副 × 52 个位置），与原 `crypto` 洗牌同一量级。
- 无数据库迁移。
## [1.7.0] — 2026-09-16

> 两条主线：**让「发现」页里的房间真的进得去**，以及**把牌友从一个名单变成约局的起点**。
>
> 「发现」页原来列着一堆谁也进不去的房间——2026-07-18 那批「防陌生人捣乱」
> 把所有房间都做成了事实上的私密桌。那个判断是对的，但它和后来做的发现页撞了：
> **看得见摸不着，比空着更糟；空着只是冷清。**

### 新增
- **公开桌 / 私密桌**。创建时二选一，**默认私密**——默认值决定 90% 的结果，
  把「陌生人能坐进我的局」设成默认，一旦出事就是信任事故。
  - 公开桌：从「发现」点进去**直接能坐下**。
  - 私密桌：**行为一行没改**——只能观战，下场仍需房主私发的四位码。
  - 两种进去之后都进「我的牌局」。老房间没有该字段 → 按私密处理。
- **房主「请出房间」**（公开桌的前提）。现有的「移到观战席」只腾座位、人还在房里；
  公开桌上房主遇到捣乱的唯一选择不能是解散重开。被请出的人**连门都进不来**，
  四位码也不行。筹码留在原处、结束照常兑回金币——**踢人不吞钱**。
- **大厅「N 位牌友在线」**。约局的第一步永远是「有没有人」，而这条信息原来只藏在
  「我的」→ 牌友里。⚠️ 前提是补了**在线状态推送**：服务端原来从不在牌友上下线时推送，
  直接渲染的话这行字就是过期快照——**一个不可信的状态指示比没有更糟，因为它还在骗人。**
- **拉黑 / 解除**。解除关系 + 他再也发不进来申请。
  🔴 对被拉黑的人是**静默的**：他发申请会看到「已发出」，但服务端什么都没写。
  一旦让他看出来，要么换号再来、要么把事情闹大。
  ⚠️ 但不用「只写他那一行」把戏做全套——那会留下单边关系，违反成对写入那条铁律。
- **牌友之间的对战战绩**（全时段 · 只算现金桌）：「同桌 668 手 · 我 +9,553 · TA −6,800」。
  给的是**双方各自的净**，不是「我从他身上赢了多少」——多人桌上那个数这张表算不出来。
  净额公式与生涯战绩完全一致；SNG 不算（锦标赛记分牌和现金筹码不是一个东西）。

### 修复
- **弹窗内容一多就点不到按钮**：`.modal-box` 既没有高度上限也不能滚，而遮罩是
  `position:fixed` + 居中 → 内容超过视口就上下各溢出一截、滚不到。
  **买入 / 补码 / 备注 / 确认 / 邀请所有弹窗一起受益。**
- **确认框被头像弹层盖住**：`#avatar-popup` 是 `z-index 205`，`.modal-mask` 是 200 ——
  点「请出房间」后得先手动关掉弹层才看得见自己刚触发的确认。
- **确认框里名字是空的**：读的是 `p.name`，而 state 下发的是 `username`/`displayName`。
  恒为 undefined，静默变成空，不报任何错。
- **牌友行到处重叠**：把一长串对战数据塞进了为「一行短状态」设计的位置，
  而按钮那侧不收缩 → 名字被压成「ad⋯」、文字从按钮底下穿过去。行改成三层。

### 关卡（每条都做了反向对照）
- 确认框必须盖在所有全屏浮层之上。
- 桌内确认框不许读 `p.name`，且必须先关弹层再弹确认。
- 弹窗必须被视口限住且可滚（且用 `dvh`），长度不受控的列表必须自己封顶。
- i18n 字典里不许有重复 key——JS 对象字面量允许重复键、后者静默覆盖前者。
- 一键邀请的 9 条全部从**攻击者视角**写：不是「功能能用吗」，是「绕得过去吗」。
- 公开/私密桌 8 条守住那条分界线：**一个 bug 让陌生人坐进朋友局，比冷启动严重得多。**

## [1.6.0] — 2026-09-14

> 这一版的主线是**牌友**：产品名叫「好友开房」，可在此之前连好友都没有——
> 想一起玩只能「房主复制房间码 → 切到微信发 → 对方切回来输码」，每局重来一遍。
> 现在房主可以在桌内直接把在线牌友叫进来。
>
> 顺带修掉一类看不见的问题：**服务端哪些话该出现在玩家屏幕上，以前是靠 emoji 前缀猜的**，
> 猜错了两次（一次漏掉该显示的，一次把没翻译的中文漏了出去）。现在改成看消息形态，
> 裸中文在结构上就不可能漏到屏幕上。

### 新增
- **牌友号**：注册时发一个 8 位随机数字，永不可改；存量用户开库时补发。
  搜索加牌友**只认精确匹配**（完整牌友号或完全一致的用户名）——
  刻意不做模糊/前缀搜索，那等于开放一个把整个用户库枚举出来的接口。
  随机而不是递增：递增号会公开「你是第几个注册的」，还能顺着号猜相邻账号。
- **一键邀请**：房主在桌内邀请在线牌友 → 对方弹窗同意 → 直接拿到下场资格。
  **不替代复制房间码**，两条路并存（跨设备 / 发微信还是得靠码）。
  - 只邀请**在大厅**的牌友：不该把人从一手牌里拽走，也绕开了一整类跨房间切换的 bug。
  - 房主自己锁了入场就不绕过，提示先解锁——替玩家做主不如把话说清楚。
  - 只能邀请已经是牌友的人，否则这就是个骚扰任意用户的接口。
  - **两道闸**：`invite_friend` 校验房主；`invite_respond` 必须在服务端找得到待办记录
    （用完即删、3 分钟过期）。没有后者，任何人知道房间号就能自己发一个「我同意」进来。
  - **邀请事件里绝不带房间码**。全库只有一处发房间码，且第一行就是房主校验。
- **19 条房主/管理员/比赛节奏的广播**从「只进 console」提升为上屏幕并双语：
  结束比赛、加时、调整结束时间、暂停/继续发牌、Straddle 开关、锁定/开放入场、
  解散、涨盲、升盲、夺冠、训练时长到点、管理员结束/解散。
  挑这一组的标准是**它们改变全桌规则或直接终止比赛，而牌桌上没有等价显示**；
  每手牌的动作播报一条不放——牌桌本身就在演。

### 变更
- **「上不上屏幕」改成看消息形态**：结构化 `{k, p}` = 服务端明确要给玩家看 → 一定弹，
  且必然有中英两份；裸字符串 = 只进 console。不再按 emoji 前缀匹配。
- **发给全桌的播报说时长，不说钟点**：广播是共享语境，同桌两人不在一个时区就各看各的表，
  谁也没法拿那个数跟别人对话。绝对钟点只留给「我自己规划」的地方（比赛设置面板）。
- 服务端**不再有任何时间格式化**：时间戳下发、客户端按自己的时区和语言渲染。

### 修复
- **点「牌友号」没复制也没提示**（手机电脑都是）：`navigator.clipboard` 只在安全上下文里存在，
  而测试服是 http —— 它是 `undefined`，`?.` 让整句静默失效：没复制上、不报错、连提示都没有。
  三个复制入口统一走带 `execCommand` 降级的 `copyText()`，**成败都给一句提示**。
- **备注太长把名字挤没**（实拍「admin1 s⋯」）：两段长度不受控的文本共用一条截断行，
  必然互相吃掉对方。备注改为单占一行。同类问题在牌谱回放里也有一处（位置标签被长名字吃掉）。
- **英文界面冒出中文提示**：`/^[⚠✅👥]/` 里 `👥` 是代理对，字符类在没有 `u` 标志时按码元拆，
  整条正则退化成「以 `\uD83D` 开头就匹配」，把从没翻译过的广播全弹到了屏幕上。
- **补码失败的提示一直是中文**（金币不足 / 补码失败）：它写成跨行三元，
  而双语关卡是按单行匹配的，两道网一起视而不见。
- **弹窗内容一多就点不到按钮**：`.modal-box` 既没有高度上限也不能滚，而遮罩是
  `position:fixed` + 居中 → 内容超过视口就上下各溢出一截、而且滚不到。
  买入/补码/备注/确认/邀请所有弹窗一起受益。
- 牌友面板被排成一条条竖字（`display` 写了 `flex`，而 `.side-panel` 默认是 block）。
- 点空白处会开一个新面板而不是关掉当前这个。
- 填备注用的是浏览器 `prompt()`：手机 WebView 里会被限制甚至不弹，还顶着一行
  「来自网页的提示」，观感像钓鱼弹窗。改成自家弹窗。

### 关卡（每条都做了反向对照）
- 正则字符类里不许出现 emoji（除非带 `u`/`v` 标志）。
- `navigator.clipboard` 只许出现在 `copyText()` 一处。
- 截断行里只许放一段内容。
- 服务端「本该给玩家看」的裸字符串 → **按整个 `emit` 调用**扫，不再按行；
  前缀清单从客户端读，不写第二份。
- 字典里的每个 `{占位符}`，服务端都必须真的发出来（对不上会**静默**渲染出一个空洞）。
- 弹窗必须被视口限住且可滚（且用 `dvh`），长度不受控的列表必须自己封顶。
- `friend-invite.test.js` 9 条全部从**攻击者视角**写：不是「功能能用吗」，是「绕得过去吗」。

### 顺带
- `npm test` 原来要跑 **5 分钟以上**：`cash-match-time.test.js` 调了 `onTableTimeUp`
  却没拆掉它武装的 5 分钟兜底定时器，`node --test` 抱着 timer 干等。
  断言全是对的，错的是没拆弹。补上之后全套 **0.84s**。

## [1.5.0] — 2026-09-13

> 大厅从「所有东西摊在一页」改成三页。起因是看德扑之星的分栏截图，
> 但最值钱的一条不是「分页」本身，而是它背后的二分：
> **【我和朋友的局】和【别人的局】是两件事**。
> 他们的「约赛」页是空的、产品却一点不显得死，因为隔壁「发现」挂着 100 场比赛——
> 空态的杀伤力取决于旁边有没有一个热闹的地方。我们原来只有一个列表，它一空，
> 整个产品看起来就是死的。

### 新增
- **大厅三页**：约局 / 发现 / 我的。
  - **约局** = 我和朋友的局：创建、输四位房间码加入、我参与的房间。
  - **发现** = 别人的局：带 全部/现金桌/SNG 筛选，房间数显示在导航角标上
    （「这里有没有人」最便宜的信号）。将来公开桌、机器人练习房也放这里。
  - **我的** = 全部个人向入口：消息、签到、生涯战绩、牌谱回顾、资料头像、
    设置、反馈、管理面板、退出登录、版本行。原来这些被压成顶栏上一排纯 emoji，
    连明眼新用户都猜不出是干嘛的。
  - 窄屏底部 tab / 宽屏左侧竖栏，同一套 DOM 纯 CSS 切换。牌桌内整条隐藏。
  - **本步不动后端**：`room_list` 本来就下发 `isMember`，前端过滤即可。
- **浮层统一「点空白处关闭」+ Esc 关最上面一层**，覆盖 14 个面板。
  原来只有 4 个写了内联判断，战绩/牌谱/收件箱/设置/回放等都只能点 ✕。
- 三页统一入场动效（原来只有约局那两张卡有）。

### 修复
- 「发现」页有角标却列不出房间：`#room-count` 元素已被移除，代码还在写它 →
  抛异常，函数在设完角标之后、渲染列表之前中断。
- 「我的」页被挤成窄条、且宽度随语言变：`#lobby-view` 是纵向 flex 的子项又写了
  `margin: 0 auto`，而**交叉轴上只要有一侧 margin 是 auto，flex 的 stretch 就不生效**，
  它退化成按内容最宽处算宽度。
- 大厅底部版本行永远显示占位符「前端 …」：那个元素的文本由 JS 填，
  却又挂着 `data-i18n`，`applyLang()` 会把它覆盖回字典值。
  同类问题一共 16 处，全部改成**文本只有一个所有者**。
- 版本行没贴在页底（1.1.2 修过一次，搬进「我的」页后又破了）。
- 手机不全屏时「我的」页的行被裁掉：页改成纵向 flex 后子项默认会被压缩，
  而卡片带 `overflow: hidden` → 直接把行裁没。高度不够应该让页面滚动。
- 全屏按钮切到 English 后仍显示中文（切语言没人重画它）。

### 关卡
- `check-i18n.js` 新增「文本由 JS 写的元素不许挂 `data-i18n`」，
  并把原有的 HTML 规则与之统一在同一个不变量上：**一个元素只有一个文本所有者**。
- 新增 `lobby-nav.test.js`（19 例）：分页行为、房间列表按 `isMember` 分流、
  角标不受筛选影响、切视图必须切外壳、导航项与页面一一对应、
  浮层登记表里的 id/关闭函数必须真实存在、版本行贴底那条链、入场动效三页通用等。
- 🔴 **`deploy.sh` 顺序 bug**：它「先把 `__BUILD__` 换成真实 SHA → 再 `git add . / commit`」，
  把打包用的临时构建号提交进了仓库。后果不是难看——下次部署 `sed` 匹配不到占位符会
  **静默不替换**，前端构建号从此冻死在旧 SHA，而它唯一的用途就是判断玩家是不是
  缓存了旧前端。已改成提交在前、盖号在后，并加占位符存在性检查 + 测试守顺序。

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
