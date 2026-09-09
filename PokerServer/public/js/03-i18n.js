// ===== 轻量 i18n（中英）：第一步只覆盖静态 UI（登录/大厅入口/顶栏/设置面板）=====
// HTML 元素用 data-i18n（换 textContent）/ data-i18n-ph（换 placeholder）/ data-i18n-title（换 title）标注；
// applyLang() 在加载时与切换语言时扫一遍。动态渲染的文案（列表/toast/牌桌提示）后续再逐步接入 t()。
const I18N = {
    zh: {
        'brand.tagline': 'Poker Dojo · 好友开房 · 切磋成长',
        'tab.login': '登录', 'tab.register': '注册',
        'ph.loginUser': '用户名 / 邮箱', 'ph.password': '密码',
        'btn.login': '登录', 'link.forgot': '忘记密码？',
        'ph.regUser': '用户名（2-20 字符）', 'ph.email': '邮箱', 'ph.regPass': '密码（至少 6 位）',
        'btn.sendCode': '发送验证码', 'ph.code6': '6 位邮箱验证码', 'btn.finishReg': '完成注册',
        'link.regBack': '返回修改', 'link.resend': '重发验证码', 'hint.bonus': '注册即赠 10,000 金币 🪙',
        'ph.fgEmail': '注册邮箱', 'ph.fgPass': '新密码（至少 6 位）', 'btn.reset': '重置密码', 'link.backLogin': '← 返回登录',
        'title.leave': '退出房间', 'title.dissolve': '解散房间', 'title.sound': '音效', 'title.fullscreen': '全屏',
        'title.settings': '设置', 'title.checkin': '每日签到', 'title.profile': '个人主页', 'title.inbox': '消息',
        'title.feedback': '反馈 Bug / 建议', 'title.admin': '管理面板', 'title.logout': '退出登录',
        'lobby.createTitle': '➕ 创建比赛', 'lobby.createSub': 'SNG 升盲 / 现金桌',
        'lobby.joinTitle': '🎟️ 加入比赛', 'lobby.joinSub': '输入房主分享的四位房间码，输满自动加入；列表里的房间只能观战',
        'settings.title': '桌面设置', 'settings.language': '语言 / Language', 'lang.zh': '中文', 'lang.en': 'English',
        'settings.theme': '桌面风格', 'settings.cardstyle': '扑克风格',
        'cs.four': '四色', 'cs.standard': '标准', 'cs.dark': '黑面', 'cs.big': '大字',
        'settings.layout': '屏幕布局', 'lay.auto': '自动', 'lay.portrait': '竖屏', 'lay.landscape': '横屏',
        'settings.layoutHint': '电脑浏览器/大屏建议「横屏」：牌桌收成合适比例居中，牌面更大、座位更聚拢。',
        'settings.quickPre': '翻前快捷加注（BB 倍数，最多 5 个；最小/All-in 固定）',
        'settings.quickPost': '翻后快捷加注（底池 %，最多 5 个；最小/All-in 固定）',
        'ph.customBB': '自定义 BB', 'ph.customPct': '自定义 %', 'btn.add': '+ 添加',
        'settings.showBB': '显示 BB', 'settings.sound': '游戏音效',
        'settings.hotkeys': '⌨️ 键盘快捷键',
        'settings.hotkeysHint': '点右侧按键可重新绑定。光标在输入框里、或按住 Ctrl/Alt 时不会触发。快捷键只是替你点按钮——按钮不能点时快捷键也不生效。',
        'settings.hotkeysReset': '恢复默认',
        'settings.wheelStep': '🖱️ 滚轮步长',
        // ===== 服务端拒绝提示（结构化 key + 参数）=====
        // 服务端只发 { k, p }，不再发中文原文；翻译全部在这里。
        // 这些都是【私发给单个玩家】的拒绝提示（socket.emit），所以不存在
        // 「一条广播要同时满足两种语言」的问题——每个客户端各自渲染即可。
        'srv.room.gone': '⚠️ 房间不存在或已结束',
        'srv.room.full': '⚠️ 房间已满',
        'srv.room.started': '⚠️ 比赛已开始，无法加入',
        'srv.room.handInProgress': '⚠️ 牌局进行中，请稍后',
        'srv.seat.forcedOut': '⚠️ 房主已把你移到观战席（筹码保留，可点「回到座位」重新入座）',
        'srv.seat.noneToReturn': '⚠️ 暂无空座，无法回座',
        'srv.seat.none': '⚠️ 没有空座位',
        'srv.gold.lowBuyin': '⚠️ 金币不足：买入 {chips} 筹码需 {cost} 金币（当前 {gold}）',
        'srv.gold.lowEntry': '⚠️ 金币不足报名费 {fee}（当前 {gold}）',
        'srv.gold.low': '⚠️ 金币不足',
        'srv.admin.denied': '⚠️ 无管理员权限',
        'srv.admin.roomGone': '⚠️ 房间不存在',
        'srv.admin.dissolvePending': '⚠️ 房间 {room} 已在等本手结束后解散',
        'srv.seat.notNeeded': '⚠️ 该房间无需坐下',
        'srv.seat.already': '⚠️ 你已入座',
        'srv.seat.full': '⚠️ 座位已满',
        'srv.seat.taken': '⚠️ 该座位已被占用',
        'srv.seat.cashOnlyStand': '⚠️ 仅现金桌可站起',
        'srv.seat.cashOnly': '⚠️ 仅现金桌可操作',
        'srv.host.onlyForceStand': '⚠️ 只有房主可强制玩家站起',
        'srv.host.notSelf': '⚠️ 不能强制自己，请用「站起围观」',
        'srv.seat.playerNotSeated': '⚠️ 该玩家不在座',
        'srv.host.onlyPause': '⚠️ 只有房主可暂停发牌',
        'srv.host.onlyStraddle': '⚠️ 只有房主可修改 Straddle 设置',
        'srv.host.onlyResume': '⚠️ 只有房主可继续发牌',
        'srv.table.timeUp': '⚠️ 训练时间已到，请先在比赛设置中调整结束时间',
        'srv.act.notYourTurn': '⚠️ 不是你的回合',
        'srv.act.noActionNeeded': '⚠️ 你已全押/已弃牌，无需再行动',
        'srv.act.cannotCheck': '⚠️ 有未跟注，不能 Check',
        'srv.act.nothingToCall': '⚠️ 无需跟注',
        'srv.act.useRaise': '⚠️ 已有下注，请用 Raise',
        'srv.act.betMin': '⚠️ 下注最少 {min}',
        'srv.act.notEnoughChips': '⚠️ 筹码不足',
        'srv.act.useBet': '⚠️ 无人下注，请用 Bet',
        'srv.act.raiseClosed': '⚠️ 前方是无效加注（全押不足一个完整加注），你只能跟注或弃牌',
        'srv.act.raiseGtCurrent': '⚠️ 加注须大于当前注 {cur}',
        'srv.act.raiseMinTo': '⚠️ 至少加注到 {to}（最小加注增量 {inc}）',
        'srv.runit.deciderOnly': '⚠️ 由落后方选择发牌次数',
        'srv.runit.leaderOnly': '⚠️ 由领先方同意',
        'srv.act.timeCap': '⚠️ 本次行动加时已达上限（2 分钟）',
        'srv.act.noTimeCards': '⚠️ 没有时间卡了',
        'srv.host.onlyDissolve': '⚠️ 只有房主可以解散房间',
        'srv.room.dissolvePending': '⚠️ 已在等本手结束后解散',
        'srv.host.onlyExtend': '⚠️ 只有房主可以加时',
        'srv.host.onlyAdjustEnd': '⚠️ 只有房主可以调整结束时间',
        'srv.table.endInvalid': '⚠️ 结束时间无效（最多可设置到 24 小时后）',
        'srv.seat.buyinCap': '⚠️ 已达带入上限',
        'srv.host.onlyStart': '⚠️ 只有房主可以开始',
        'srv.room.alreadyStarted': '⚠️ 比赛已开始',
        'srv.room.needTwo': '⚠️ 至少 2 名玩家入座才能开始',
        'srv.room.readyLocked': '⚠️ 牌局进行中，无法更改准备状态',
        'srv.seat.notSeated': '⚠️ 你还未入座',
        'srv.sys.restarting': '⚠️ 服务正在安全重启，请稍后重新连接',
        'srv.sys.actionFailed': '⚠️ 本次操作失败，牌桌已安全暂停，请稍后重试或重新连接',

        'a11y.close': '关闭',
        'settings.tab.look': '外观', 'settings.tab.table': '牌桌', 'settings.tab.action': '操作',
        'btn.fullscreen': '⛶ 全屏', 'btn.leaveRoom': '🚪 退出房间', 'btn.dissolve': '🛑 解散房间', 'btn.logout': '⎋ 退出登录',
        'cfg.sngNote': '初始盲注 25/50 每级递增、淘汰制；冠军赢得奖池', 'cfg.name': '比赛名字', 'cfg.namePh': '不服就推',
        'cfg.buyin': '报名费（冠军奖励）', 'cfg.maxPlayers': '开赛人数：', 'cfg.unitPeople': '人', 'cfg.startStack': '初始记分牌：',
        'cfg.levelTime': '级别时间（涨盲间隔）：', 'cfg.unitMin': '分钟',
        'cfg.cashNote': '2–9 人，固定盲注。金币↔筹码买入：110 金币→1000 筹码，离场 1000 筹码→100 金币',
        'cfg.tableName': '牌桌名字', 'cfg.tableNamePh': '欢乐场', 'cfg.blinds': '基础分（盲注）：', 'cfg.ante': 'Ante 前注：',
        'cfg.straddle': '允许 UTG Straddle（固定 2BB）', 'cfg.maxSeats': '单桌最大人数：', 'cfg.minBuyin': '单次最小带入：',
        'cfg.buyinCap': '带入上限：', 'cfg.duration': '训练时长（到点自动结束并结算排名）', 'cfg.confirm': '确定创建', 'cfg.cancel': '取消',
        'lobby.roomList': '房间列表', 'cfg.tabSng': '🏆 SNG 升盲', 'cfg.tabCash': '💵 现金桌',
        'voice.rec': '按住说话', 'voice.hold': '按住说话',
        'tm.settings': '🎨 桌面设置', 'tm.invite': '🔗 邀请朋友', 'tm.rebuy': '💵 补充记分牌', 'tm.reserve': '💺 留座离桌',
        'tm.standup': '🧍 站起围观', 'tm.pause': '⏸️ 暂停发牌', 'tm.matchSettings': '⚙️ 比赛设置', 'tm.leave': '🚪 退出比赛', 'tm.dissolve': '🛑 解散比赛',
        'chat.title': '💬 聊天', 'chat.phrases': '常用语', 'chat.inputPh': '说点什么…', 'chat.send': '发送',
        'inbox.title': '📬 消息', 'checkin.title': '🎁 每日签到', 'common.loading': '加载中…',
        'feedback.title': '🐞 反馈 Bug / 建议', 'feedback.hint': '遇到问题或有建议？直接告诉我们，会尽快改进 🙏',
        'feedback.textPh': '描述你遇到的 Bug 或想法…（越详细越好）', 'feedback.contactPh': '联系方式（选填：邮箱/微信，方便回复）', 'feedback.submit': '提交反馈',
        'act.confirm': '确认', 'act.fold': '弃牌', 'act.bet': '下注…', 'act.raise': '加注…', 'act.check': '过牌', 'act.call': '跟注',
        'act.allinParen': '(全下)', 'act.confirmBet': '确认下注 ', 'act.confirmRaise': '确认加注到 ', 'act.rabbit': '🐰 看后续牌',
        'pa.checkfold': '过/弃', 'pa.call': '跟注', 'tc.menu': '菜单', 'tc.addtime': '加时',
        'reserve.reserving': '💺 留座中', 'reserve.sitback': '🪑 回到座位',
        'bm.titleDefault': '坐下带入', 'bm.chips': '记分牌', 'bm.cost': '消耗 🪙', 'bm.avail': '可用 🪙',
        'bm.auto': '自动补码（耗尽自动补最小带入）', 'bm.cancel': '取消', 'bm.confirm': '确定',
        'stats.title': '当前战绩', 'stats.name': '昵称', 'stats.buyin': '带入', 'stats.hands': '手数', 'stats.net': '战绩', 'hist.title': '本局牌谱',
        'prof.title': '👤 个人主页', 'prof.info': '资料', 'prof.stats': '生涯战绩', 'prof.hands': '牌谱', 'prof.avatar': '头像',
        'filter.all': '全部', 'filter.cash': '现金桌', 'filter.sng': 'SNG',
        'inv.title': '🔗 邀请朋友加入', 'inv.note': '复制后直接发送给朋友；可点链接加入，跨设备时也可输入房间码。', 'inv.loading': '正在获取邀请信息…',
        'inv.label': '邀请信息', 'inv.copy': '一键复制', 'inv.open': '🔓 开放入场', 'inv.reset': '↻ 重置邀请', 'inv.close': '关闭',
        'edge.stats': '战绩', 'edge.hands': '牌谱',
        'compliance': '绿色竞技 · 远离赌博 · 谨防诈骗 · 健康生活',
        'ms.title': '比赛设置', 'ms.close': '关闭', 'ms.end': '🛑 提前结束',
        'rp.title': '牌谱回放', 'rp.prev': '上一步', 'rp.play': '播放/暂停', 'rp.next': '下一步', 'rp.speed': '速度',
        'hd.title': '牌谱详情', 'hd.replay': '▶ 回放', 'ap.sub': '本局数据', 'ap.emo': '发表情',
        'result.title': '比赛结束', 'result.back': '返回大厅',
    },
    en: {
        'brand.tagline': 'Poker Dojo · Play with friends · Grow together',
        'tab.login': 'Log in', 'tab.register': 'Sign up',
        'ph.loginUser': 'Username / Email', 'ph.password': 'Password',
        'btn.login': 'Log in', 'link.forgot': 'Forgot password?',
        'ph.regUser': 'Username (2–20 chars)', 'ph.email': 'Email', 'ph.regPass': 'Password (min 6)',
        'btn.sendCode': 'Send code', 'ph.code6': '6-digit email code', 'btn.finishReg': 'Create account',
        'link.regBack': 'Back', 'link.resend': 'Resend code', 'hint.bonus': 'Get 10,000 coins on sign-up 🪙',
        'ph.fgEmail': 'Registered email', 'ph.fgPass': 'New password (min 6)', 'btn.reset': 'Reset password', 'link.backLogin': '← Back to log in',
        'title.leave': 'Leave room', 'title.dissolve': 'Dissolve room', 'title.sound': 'Sound', 'title.fullscreen': 'Fullscreen',
        'title.settings': 'Settings', 'title.checkin': 'Daily check-in', 'title.profile': 'Profile', 'title.inbox': 'Messages',
        'title.feedback': 'Report a bug / idea', 'title.admin': 'Admin panel', 'title.logout': 'Log out',
        'lobby.createTitle': '➕ Create game', 'lobby.createSub': 'SNG / Cash table',
        'lobby.joinTitle': '🎟️ Join game', 'lobby.joinSub': "Enter the host's 4-digit room code to join; rooms in the list are spectate-only",
        'settings.title': 'Settings', 'settings.language': '语言 / Language', 'lang.zh': '中文', 'lang.en': 'English',
        'settings.theme': 'Table theme', 'settings.cardstyle': 'Card style',
        'cs.four': '4-color', 'cs.standard': 'Standard', 'cs.dark': 'Dark', 'cs.big': 'Big text',
        'settings.layout': 'Screen layout', 'lay.auto': 'Auto', 'lay.portrait': 'Portrait', 'lay.landscape': 'Landscape',
        'settings.layoutHint': 'On desktop/large screens, "Landscape" fits the table to a nicer proportion — bigger cards, tighter seats.',
        'settings.quickPre': 'Preflop quick raises (×BB, up to 5; Min/All-in fixed)',
        'settings.quickPost': 'Postflop quick raises (% pot, up to 5; Min/All-in fixed)',
        'ph.customBB': 'Custom ×BB', 'ph.customPct': 'Custom %', 'btn.add': '+ Add',
        'settings.showBB': 'Show BB', 'settings.sound': 'Sound effects',
        'settings.hotkeys': '⌨️ Keyboard shortcuts',
        'settings.hotkeysHint': 'Click a key to rebind. Never fires while typing in a field, or while Ctrl/Alt is held. A shortcut only clicks the button for you — if the button is unavailable, so is the shortcut.',
        'settings.hotkeysReset': 'Reset to defaults',
        'settings.wheelStep': '🖱️ Wheel step',
        'srv.room.gone': '⚠️ Room not found or already ended',
        'srv.room.full': '⚠️ Room is full',
        'srv.room.started': '⚠️ The game has already started - you cannot join',
        'srv.room.handInProgress': '⚠️ A hand is in progress - please wait',
        'srv.seat.forcedOut': '⚠️ The host moved you to the rail (chips are kept - tap Sit back to return)',
        'srv.seat.noneToReturn': '⚠️ No empty seat available to sit back into',
        'srv.seat.none': '⚠️ No empty seats',
        'srv.gold.lowBuyin': '⚠️ Not enough coins: {chips} chips costs {cost} coins (you have {gold})',
        'srv.gold.lowEntry': '⚠️ Not enough coins for the {fee} entry fee (you have {gold})',
        'srv.gold.low': '⚠️ Not enough coins',
        'srv.admin.denied': '⚠️ Administrator access required',
        'srv.admin.roomGone': '⚠️ Room not found',
        'srv.admin.dissolvePending': '⚠️ Room {room} is already set to dissolve after this hand',
        'srv.seat.notNeeded': '⚠️ No need to sit down in this room',
        'srv.seat.already': '⚠️ You are already seated',
        'srv.seat.full': '⚠️ All seats are taken',
        'srv.seat.taken': '⚠️ That seat is taken',
        'srv.seat.cashOnlyStand': '⚠️ Standing up is only available at cash tables',
        'srv.seat.cashOnly': '⚠️ Cash tables only',
        'srv.host.onlyForceStand': '⚠️ Only the host can move a player to the rail',
        'srv.host.notSelf': '⚠️ You cannot move yourself - use Stand up',
        'srv.seat.playerNotSeated': '⚠️ That player is not seated',
        'srv.host.onlyPause': '⚠️ Only the host can pause dealing',
        'srv.host.onlyStraddle': '⚠️ Only the host can change the straddle setting',
        'srv.host.onlyResume': '⚠️ Only the host can resume dealing',
        'srv.table.timeUp': '⚠️ Session time is up - adjust the end time in game settings first',
        'srv.act.notYourTurn': '⚠️ It is not your turn',
        'srv.act.noActionNeeded': '⚠️ You are already all-in or folded - no action needed',
        'srv.act.cannotCheck': '⚠️ There is a bet to call - you cannot check',
        'srv.act.nothingToCall': '⚠️ There is nothing to call',
        'srv.act.useRaise': '⚠️ There is already a bet - use Raise',
        'srv.act.betMin': '⚠️ Minimum bet is {min}',
        'srv.act.notEnoughChips': '⚠️ Not enough chips',
        'srv.act.useBet': '⚠️ Nobody has bet - use Bet',
        'srv.act.raiseClosed': '⚠️ That was an incomplete raise (all-in under a full raise) - you can only call or fold',
        'srv.act.raiseGtCurrent': '⚠️ Your raise must be more than the current bet of {cur}',
        'srv.act.raiseMinTo': '⚠️ Raise to at least {to} (minimum raise increment {inc})',
        'srv.runit.deciderOnly': '⚠️ The player who is behind chooses how many runs',
        'srv.runit.leaderOnly': '⚠️ The player who is ahead must agree',
        'srv.act.timeCap': '⚠️ You have reached the 2-minute cap for this decision',
        'srv.act.noTimeCards': '⚠️ No time cards left',
        'srv.host.onlyDissolve': '⚠️ Only the host can dissolve the room',
        'srv.room.dissolvePending': '⚠️ Already set to dissolve after this hand',
        'srv.host.onlyExtend': '⚠️ Only the host can extend the time',
        'srv.host.onlyAdjustEnd': '⚠️ Only the host can adjust the end time',
        'srv.table.endInvalid': '⚠️ Invalid end time (at most 24 hours from now)',
        'srv.seat.buyinCap': '⚠️ Buy-in cap reached',
        'srv.host.onlyStart': '⚠️ Only the host can start',
        'srv.room.alreadyStarted': '⚠️ The game has already started',
        'srv.room.needTwo': '⚠️ At least 2 seated players are needed to start',
        'srv.room.readyLocked': '⚠️ A hand is in progress - you cannot change your ready status',
        'srv.seat.notSeated': '⚠️ You are not seated yet',
        'srv.sys.restarting': '⚠️ The server is restarting safely - please reconnect shortly',
        'srv.sys.actionFailed': '⚠️ That action failed. The table is paused safely - retry or reconnect',

        'a11y.close': 'Close',
        'settings.tab.look': 'Look', 'settings.tab.table': 'Table', 'settings.tab.action': 'Controls',
        'btn.fullscreen': '⛶ Fullscreen', 'btn.leaveRoom': '🚪 Leave room', 'btn.dissolve': '🛑 Dissolve room', 'btn.logout': '⎋ Log out',
        'cfg.sngNote': 'Blinds start 25/50 and rise each level; last player standing wins the pool', 'cfg.name': 'Game name', 'cfg.namePh': 'e.g. All-in Club',
        'cfg.buyin': 'Buy-in (winner takes the pool)', 'cfg.maxPlayers': 'Players: ', 'cfg.unitPeople': '', 'cfg.startStack': 'Starting stack: ',
        'cfg.levelTime': 'Level time (blind-up): ', 'cfg.unitMin': 'min',
        'cfg.cashNote': '2–9 players, fixed blinds. Coins↔chips: 110 coins→1000 chips; cash out 1000 chips→100 coins',
        'cfg.tableName': 'Table name', 'cfg.tableNamePh': 'e.g. Fun Room', 'cfg.blinds': 'Blinds: ', 'cfg.ante': 'Ante: ',
        'cfg.straddle': 'Allow UTG straddle (2BB)', 'cfg.maxSeats': 'Max players: ', 'cfg.minBuyin': 'Min buy-in: ',
        'cfg.buyinCap': 'Buy-in cap: ', 'cfg.duration': 'Session length (auto-ends & settles at time)', 'cfg.confirm': 'Create', 'cfg.cancel': 'Cancel',
        'lobby.roomList': 'Rooms', 'cfg.tabSng': '🏆 SNG', 'cfg.tabCash': '💵 Cash',
        'voice.rec': 'Hold to talk', 'voice.hold': 'Hold to talk',
        'tm.settings': '🎨 Settings', 'tm.invite': '🔗 Invite friends', 'tm.rebuy': '💵 Rebuy chips', 'tm.reserve': '💺 Reserve & leave',
        'tm.standup': '🧍 Stand up (watch)', 'tm.pause': '⏸️ Pause dealing', 'tm.matchSettings': '⚙️ Game settings', 'tm.leave': '🚪 Leave game', 'tm.dissolve': '🛑 Dissolve game',
        'chat.title': '💬 Chat', 'chat.phrases': 'Phrases', 'chat.inputPh': 'Say something…', 'chat.send': 'Send',
        'inbox.title': '📬 Messages', 'checkin.title': '🎁 Daily check-in', 'common.loading': 'Loading…',
        'feedback.title': '🐞 Report a bug / idea', 'feedback.hint': "Hit a bug or have an idea? Tell us and we'll improve it 🙏",
        'feedback.textPh': 'Describe the bug or idea… (the more detail the better)', 'feedback.contactPh': 'Contact (optional: email/WeChat, for follow-up)', 'feedback.submit': 'Submit',
        'act.confirm': 'Confirm', 'act.fold': 'Fold', 'act.bet': 'Bet…', 'act.raise': 'Raise…', 'act.check': 'Check', 'act.call': 'Call',
        'act.allinParen': '(all-in)', 'act.confirmBet': 'Confirm bet ', 'act.confirmRaise': 'Confirm raise to ', 'act.rabbit': '🐰 Rabbit hunt',
        'pa.checkfold': 'Check/Fold', 'pa.call': 'Call', 'tc.menu': 'Menu', 'tc.addtime': 'Add time',
        'reserve.reserving': '💺 Seat held', 'reserve.sitback': '🪑 Sit back',
        'bm.titleDefault': 'Buy-in', 'bm.chips': 'chips', 'bm.cost': 'Cost 🪙', 'bm.avail': 'Have 🪙',
        'bm.auto': 'Auto-rebuy (top up to min when out)', 'bm.cancel': 'Cancel', 'bm.confirm': 'OK',
        'stats.title': 'Standings', 'stats.name': 'Name', 'stats.buyin': 'Buy-in', 'stats.hands': 'Hands', 'stats.net': 'P/L', 'hist.title': 'This game',
        'prof.title': '👤 Profile', 'prof.info': 'Info', 'prof.stats': 'Career', 'prof.hands': 'Hands', 'prof.avatar': 'Avatar',
        'filter.all': 'All', 'filter.cash': 'Cash', 'filter.sng': 'SNG',
        'inv.title': '🔗 Invite friends', 'inv.note': 'Copy and send to a friend; they can tap the link, or type the room code across devices.', 'inv.loading': 'Getting invite info…',
        'inv.label': 'Invite', 'inv.copy': 'Copy', 'inv.open': '🔓 Open entry', 'inv.reset': '↻ Reset invite', 'inv.close': 'Close',
        'edge.stats': 'Stats', 'edge.hands': 'Hands',
        'compliance': 'Play for fun · No gambling · Beware of scams · Stay healthy',
        'ms.title': 'Game settings', 'ms.close': 'Close', 'ms.end': '🛑 End early',
        'rp.title': 'Hand replay', 'rp.prev': 'Previous', 'rp.play': 'Play/Pause', 'rp.next': 'Next', 'rp.speed': 'Speed',
        'hd.title': 'Hand detail', 'hd.replay': '▶ Replay', 'ap.sub': 'This hand', 'ap.emo': 'Emote',
        'result.title': 'Game over', 'result.back': 'Back to lobby',
    },
};
let lang = (() => { try { return localStorage.getItem('lang') || (String(navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh'); } catch { return 'zh'; } })();
function t(key, fallback) {
    // ⚠️ 用 `key in dict` 判断而不是 ||：英文译文可能是空串（如单位"人"在英文里去掉），
    // 空串是合法翻译，不能被当成"缺失"回退到中文。
    const d = I18N[lang];
    if (d && key in d) return d[key];
    if (I18N.zh && key in I18N.zh) return I18N.zh[key];
    return fallback != null ? fallback : key;
}
// 动态 JS 文案用这个：翻译直接写在调用处，省去为每条散字符串建 key。lang=en 时取第二个参数。
function L(zh, en) { return (lang === 'en' && en != null) ? en : zh; }
// 牌型名（服务端发的是中文，固定 10 种）→ 英文映射
const HAND_CAT_EN = { '皇家同花顺': 'Royal Flush', '同花顺': 'Straight Flush', '四条': 'Four of a Kind', '葫芦': 'Full House', '同花': 'Flush', '顺子': 'Straight', '三条': 'Three of a Kind', '两对': 'Two Pair', '一对': 'One Pair', '高牌': 'High Card' };
function handCat(c) { return (lang === 'en' && HAND_CAT_EN[c]) ? HAND_CAT_EN[c] : (c || ''); }
// 结算面板的单位（服务端发中文）→ 英文
function unitL(u) { return lang === 'en' ? ({ '筹码': 'chips', '金币': 'coins' }[u] || u) : u; }
// 结算标题里服务端拼的「原因」后缀（房间名在【】内，保持不动）→ 英文（固定小集合）
const MATCH_REASON_EN = {
    '训练时长已到（5 分钟无人处理，自动结算）': 'Session time up (auto-settled after 5 min)',
    '房主提前结束': 'Host ended early', '比赛结束': 'Game over', '管理员解散': 'Dissolved by admin',
    '房间空置已关闭': 'Closed (empty room)', '恢复未完成结算': 'Recovered settlement',
};
function matchTitleL(tt) { if (lang !== 'en' || !tt) return tt; let s = tt; for (const k in MATCH_REASON_EN) s = s.split(k).join(MATCH_REASON_EN[k]); return s; }
// 收件箱结算消息（服务端固定模板拼的整段中文，含历史消息）→ 英文。按行调用，检测靠原文、显示用译文。
function inboxTextL(line) {
    if (lang !== 'en' || !line) return line;
    let s = matchTitleL(line);
    return s
        .replace(/你第 /g, 'You placed #').replace(/ 名，盈亏 /g, ', P/L ').replace(/，共打 /g, ', played ').replace(/ 手/g, ' hands')
        .replace(/—— 本场称号 ——/g, '—— Awards ——').replace(/—— 完整排名 ——/g, '—— Full ranking ——')
        .replace(/🥇 老板：/g, '🥇 Boss: ').replace(/🥈 MVP：/g, '🥈 MVP: ').replace(/🥉 力工：/g, '🥉 Grinder: ')
        .replace(/🥇老板/g, '🥇Boss').replace(/🥉力工/g, '🥉Grinder')
        .replace(/筹码/g, 'chips').replace(/金币/g, 'coins');
}
function applyLang() {
    try { document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'; } catch {}
    document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.getAttribute('data-i18n'), null); if (v != null) el.textContent = v; });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { const v = t(el.getAttribute('data-i18n-ph'), null); if (v != null) el.placeholder = v; });
    // title 顺带镜像一份 aria-label：顶栏那排按钮全是纯 emoji（🔊 ⛶ 🎁 🐞 📬），
    // title 只在【电脑悬停】时出现——手机上看不到、读屏软件也不保证会念。
    // 这样每个已翻译的 title 自动带一个同文案的 aria-label，不用维护第二份。
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const v = t(el.getAttribute('data-i18n-title'), null);
        if (v != null) { el.title = v; el.setAttribute('aria-label', v); }
    });
    document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('sel', b.getAttribute('data-lang') === lang));
}
function setLang(l) {
    lang = (l === 'en' ? 'en' : 'zh');
    try { localStorage.setItem('lang', lang); } catch {}
    applyLang();
    // 牌桌/大厅里有些文案是 JS 写的（过牌/跟注按钮、房间列表卡片等）→ 切语言后重渲染一次立即生效
    try { if (typeof lastState !== 'undefined' && lastState && typeof render === 'function') render(lastState); } catch {}
    try { if (window._lastRooms && typeof renderRoomList === 'function') renderRoomList(window._lastRooms); } catch {}
    try { if (document.getElementById('settings-overlay')?.style.display === 'flex' && typeof buildSettingsPanel === 'function') buildSettingsPanel(); } catch {}
    try { if (typeof buildChatBars === 'function') buildChatBars(); } catch {}   // 快捷聊天语随语言切换
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLang);
else applyLang();

// 把服务端发来的 { k, p } 渲染成当前语言的一句话。
// 向后兼容：老服务端（或还没迁移的调用点）发的是字符串，原样返回。
// 字典缺 key 时返回空串而不是 [object Object]——宁可不显示，也不能显示乱码。
function renderServerMsg(m) {
    if (typeof m === 'string') return m;   // 老服务端 / 尚未迁移的调用点仍发字符串，原样透传
    if (!m || !m.k) return '';
    const key = 'srv.' + m.k;
    // ⚠️ 不能用 t(key, null) 判「有没有这条」——t() 找不到时【返回 key 本身】
    //    （fallback 传 null 也一样，见上面 t 的最后一行）。若照抄那套写法，
    //    缓存了旧 JS 的客户端碰到服务端的新 key，会把 "srv.xxx" 原样弹成一条 toast。
    //    这里显式查字典：查不到就什么都不显示。
    const d = I18N[lang];
    const s = (d && key in d) ? d[key] : ((I18N.zh && key in I18N.zh) ? I18N.zh[key] : null);
    if (s == null) return '';
    return s.replace(/\{(\w+)\}/g, (_, name) => (m.p && m.p[name] != null) ? m.p[name] : '');
}
