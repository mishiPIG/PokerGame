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
function applyLang() {
    try { document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'; } catch {}
    document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.getAttribute('data-i18n'), null); if (v != null) el.textContent = v; });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { const v = t(el.getAttribute('data-i18n-ph'), null); if (v != null) el.placeholder = v; });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { const v = t(el.getAttribute('data-i18n-title'), null); if (v != null) el.title = v; });
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
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLang);
else applyLang();
