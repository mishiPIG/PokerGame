// ===== 新手引导（2026-11-17，玩家视角复盘 P1-1）=====
// 游客模式上线后，点邀请链接进来的人里会有不熟规则的。两样东西：
//   ① 牌型大小速查表：任何时候都能打开（桌内菜单 / 点自己的牌型徽章 / 「我的」页）
//   ② 第一次被发到牌时的三步提示：你的牌 / 公共牌 / 轮到你时按钮在哪。
//      只给新来的人看（游客，或刚注册的账号）—— 老玩家更新后突然弹教程只会烦。
//      提示不挡操作（只是一个小气泡 + 目标外圈一道光），随时能跳过，看过一次就不再出现。

// 从大到小。cat 用中文名：和服务端 / handCat() 是同一套 key，英文由 handCat 翻。
const HAND_GUIDE = [
    { cat: '皇家同花顺', cards: ['AS', 'KS', 'QS', 'JS', 'TS'], zh: '同一花色的 A K Q J 10', en: 'A K Q J 10, all one suit' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '同花顺', cards: ['9H', '8H', '7H', '6H', '5H'], zh: '同一花色、点数连续的五张', en: 'Five in a row, all one suit' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '四条', cards: ['QC', 'QD', 'QH', 'QS', '7D'], zh: '四张点数相同', en: 'Four of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '葫芦', cards: ['KH', 'KD', 'KC', '4S', '4H'], zh: '三条 + 一对', en: 'Three of a kind plus a pair' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '同花', cards: ['AD', 'JD', '8D', '5D', '2D'], zh: '五张同一花色（不用连续）', en: 'Five of one suit, any order' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '顺子', cards: ['TC', '9D', '8S', '7H', '6C'], zh: '五张点数连续（花色随意）；A 也能当 1：A-2-3-4-5', en: 'Five in a row, any suits. A can be low: A-2-3-4-5' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '三条', cards: ['7S', '7H', '7D', 'KC', '2S'], zh: '三张点数相同', en: 'Three of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '两对', cards: ['JH', 'JS', '4C', '4D', 'AH'], zh: '两个对子', en: 'Two different pairs' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '一对', cards: ['TH', 'TD', 'KS', '6C', '3H'], zh: '两张点数相同', en: 'Two of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '高牌', cards: ['AC', 'JD', '8H', '5S', '3C'], zh: '什么都没凑成，比最大的那张', en: 'Nothing made — the highest card plays' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
];

function renderHandGuide() {
    document.getElementById('hg-list').innerHTML = HAND_GUIDE.map((h, i) =>
        `<div class="hg-row"><span class="hg-no">${i + 1}</span>`
        + `<div class="hg-main"><div class="hg-name">${handCat(h.cat)}</div><div class="hg-desc">${L(h.zh, h.en)}</div></div>`
        + `<div class="hg-cards">${h.cards.map(c => formatCard(rpParseCard(c))).join('')}</div></div>`).join('');
}
function openHandGuide() {
    renderHandGuide();
    document.getElementById('hand-guide').style.display = 'flex';
}
function closeHandGuide() { document.getElementById('hand-guide').style.display = 'none'; }
onLangChange(() => { if (document.getElementById('hand-guide').style.display !== 'none') renderHandGuide(); });

// ── 第一次被发到牌时的三步提示 ──
const COACH_KEY = 'coachSeen';
let coachStep = -1;
function coachSteps() {
    return [
        { sel: `.seat[data-uid="${myUserId}"] .self-cards`,
          zh: '这是你的两张底牌，只有你自己看得见。', en: 'These are your two hole cards. Only you can see them.' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
        { sel: '#community',
          zh: '中间是公共牌（最多 5 张），所有人共用。用你的两张加上公共牌，凑出最好的五张来比大小。',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
          en: 'These are the community cards (up to 5), shared by everyone. Make your best five cards from your two plus these.' },
        { sel: `.seat[data-uid="${myUserId}"] .avatar-block`,
          zh: '轮到你时，这里会出现按钮：✕ 弃牌、跟注 / 过牌、加注；头像外面那圈是倒计时。不记得牌型大小？点 ☰ 菜单里的「牌型大小」。',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
          en: 'When it’s your turn, buttons appear here: ✕ fold, call / check, raise. The ring around your avatar is your timer. Forgot the hand rankings? Open ☰ → Hand rankings.' },
    ];
}
// 只给新来的人：游客，或者这台设备上刚注册的账号（注册成功时打的标记）
function coachWanted() {
    try {
        if (localStorage.getItem(COACH_KEY)) return false;
        return isGuest || localStorage.getItem('newAccount') === '1';
    } catch { return false; }
}
function maybeStartCoach() {
    if (coachStep >= 0 || !coachWanted() || !mySeated) return;
    // 等发牌动画落定；正轮到他行动就再等等 —— 一边计时一边读提示，新手很可能因此被超时弃牌
    const tryStart = () => {
        if (coachStep >= 0 || !coachWanted() || !mySeated) return;
        if (lastState && lastState.actionOnUserId === myUserId) { setTimeout(tryStart, 1000); return; }
        coachStep = 0; showCoach();
    };
    setTimeout(tryStart, 1600);
}
function showCoach() {
    const steps = coachSteps();
    const s = steps[coachStep];
    const el = s && document.querySelector(s.sel);
    if (!el) { endCoach(); return; }
    const r = el.getBoundingClientRect();
    const ring = document.getElementById('coach-ring');
    ring.style.cssText = `display:block;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
    const box = document.getElementById('coach');
    document.getElementById('coach-text').textContent = L(s.zh, s.en);
    const last = coachStep === steps.length - 1;
    document.getElementById('coach-next').textContent = last ? L('知道了', 'Got it') : L(`下一步 ${coachStep + 1}/${steps.length}`, `Next ${coachStep + 1}/${steps.length}`);
    document.getElementById('coach-skip').style.display = last ? 'none' : '';
    box.style.display = 'block';
    // 气泡放在目标上方，放不下就放下方；左右夹在屏幕里
    const bw = box.offsetWidth, bh = box.offsetHeight;
    const above = r.top - bh - 14 > 8;
    const top = above ? r.top - bh - 14 : r.bottom + 14;
    const left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    box.style.top = Math.min(top, window.innerHeight - bh - 8) + 'px';
    box.style.left = left + 'px';
}
// 提示开着的时候轮到我了（发牌后先出提示、随后轮到自己）：先收起，别挡住行动按钮；行动完再接着显示同一步。
// 2026-11-17 电脑端截图里看到的 —— 只在「开始提示」前等轮到我打完是不够的，提示开着期间同样会轮到我。
let coachPaused = false;
function syncCoachWithTurn() {
    if (coachStep < 0) { coachPaused = false; return; }
    const myTurn = !!(lastState && lastState.actionOnUserId === myUserId);
    if (myTurn && !coachPaused) {
        coachPaused = true;
        document.getElementById('coach').style.display = 'none';
        document.getElementById('coach-ring').style.display = 'none';
    } else if (!myTurn && coachPaused) {
        coachPaused = false;
        setTimeout(() => { if (coachStep >= 0 && !coachPaused) showCoach(); }, 600);   // 等这一下的动画落定
    }
}
function coachNext() {
    coachStep++;
    if (coachStep >= coachSteps().length) endCoach(); else showCoach();
}
function endCoach() {
    coachStep = -1;
    coachPaused = false;
    try { localStorage.setItem(COACH_KEY, '1'); localStorage.removeItem('newAccount'); } catch { /* 存不了就下次再看一遍，无害 */ }
    document.getElementById('coach').style.display = 'none';
    document.getElementById('coach-ring').style.display = 'none';
}
window.addEventListener('resize', () => { if (coachStep >= 0 && !coachPaused) showCoach(); });
