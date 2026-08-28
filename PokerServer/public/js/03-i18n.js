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
    },
};
let lang = (() => { try { return localStorage.getItem('lang') || (String(navigator.language || '').toLowerCase().startsWith('en') ? 'en' : 'zh'); } catch { return 'zh'; } })();
function t(key, fallback) { return (I18N[lang] && I18N[lang][key]) || (I18N.zh && I18N.zh[key]) || (fallback != null ? fallback : key); }
function applyLang() {
    try { document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'; } catch {}
    document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.getAttribute('data-i18n'), null); if (v != null) el.textContent = v; });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => { const v = t(el.getAttribute('data-i18n-ph'), null); if (v != null) el.placeholder = v; });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { const v = t(el.getAttribute('data-i18n-title'), null); if (v != null) el.title = v; });
    document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('sel', b.getAttribute('data-lang') === lang));
}
function setLang(l) { lang = (l === 'en' ? 'en' : 'zh'); try { localStorage.setItem('lang', lang); } catch {} applyLang(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLang);
else applyLang();
