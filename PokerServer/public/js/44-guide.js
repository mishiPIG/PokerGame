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

// 短牌（36 张，没有 2–5）：同花 > 葫芦，A-6-7-8-9 是最小的顺子；其余和德州一样（顺子 > 三条，按官方规则）。示例牌一张 2–5 都不能有
const HAND_GUIDE_SD = [
    { cat: '皇家同花顺', cards: ['AS', 'KS', 'QS', 'JS', 'TS'], zh: '同一花色的 A K Q J 10', en: 'A K Q J 10, all one suit' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '同花顺', diff: true, cards: ['AH', '9H', '8H', '7H', '6H'], zh: '同一花色、点数连续；A-6-7-8-9 也算（最小的）', en: 'Five in a row, one suit. A-6-7-8-9 counts (the lowest)' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '四条', cards: ['QC', 'QD', 'QH', 'QS', '7D'], zh: '四张点数相同', en: 'Four of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '同花', diff: true, cards: ['AD', 'JD', '9D', '7D', '6D'], zh: '五张同一花色 —— 短牌里比葫芦大', en: 'Five of one suit — beats a full house in short deck' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '葫芦', cards: ['KH', 'KD', 'KC', '6S', '6H'], zh: '三条 + 一对', en: 'Three of a kind plus a pair' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '顺子', diff: true, cards: ['9C', '8D', '7S', '6H', 'AC'], zh: '五张点数连续；A-6-7-8-9 是最小的顺子', en: 'Five in a row. A-6-7-8-9 is the lowest straight' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '三条', cards: ['7S', '7H', '7D', 'KC', '9S'], zh: '三张点数相同', en: 'Three of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '两对', cards: ['JH', 'JS', '8C', '8D', 'AH'], zh: '两个对子', en: 'Two different pairs' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '一对', cards: ['TH', 'TD', 'KS', '7C', '6H'], zh: '两张点数相同', en: 'Two of the same rank' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { cat: '高牌', cards: ['AC', 'JD', '9H', '7S', '6C'], zh: '什么都没凑成，比最大的那张', en: 'Nothing made — the highest card plays' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
];
// 奥马哈「常见误判」：按德州的习惯（9 张里随便挑 5 张）看着像 looks，按奥马哈规则（正好 2 张底牌 + 3 张公共牌）其实只是 is。
// 新手在奥马哈里最常犯的就是这几种。hand-guide.test.js 用真评估器核对这两个牌型都没写错。
const PLO_MISREADS = [
    { hole: ['AH', 'QS', 'QD', '7C'], board: ['KH', '9H', '6H', '2H', 'JC'], looks: '同花', is: '一对',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
      zh: '公共牌四张红心，可你手里只有一张红心：同花至少要两张底牌是红心', en: 'Four hearts on the board, but only one in your hand: a flush needs two hole cards of that suit' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { hole: ['AS', 'AD', 'KC', 'KH'], board: ['5S', '6D', '7C', '8H', '9S'], looks: '顺子', is: '一对',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
      zh: '公共牌自己就是顺子，但你不能直接用公共牌：必须带上两张底牌（AA + 9 8 7）', en: 'The board is a straight, but you can’t just play the board: two hole cards must play (AA + 9 8 7)' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
    { hole: ['AS', 'AD', 'AC', 'KH'], board: ['AH', '8C', '5D', '3S', '2C'], looks: '四条', is: '三条',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
      zh: '手里三张 A 只能用两张，加上公共牌那张 A 是三条', en: 'Only two of your three aces can play, so with the A on the board it’s trips' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
];
// 速查表顶上三个玩法分页。默认：在牌桌里 = 这一桌的玩法；在大厅 / 「我的」页 = 德州（2026-11-19：原来只能看到当前牌桌那一种，在大厅永远是德州）
const GUIDE_VARIANTS = ['nlhe', 'shortdeck', 'plo'];
let guideVariant = 'nlhe';
function guideRows(v) { return (v || guideVariant) === 'shortdeck' ? HAND_GUIDE_SD : HAND_GUIDE; }
function tableVariantNow() {
    const inRoom = typeof document !== 'undefined' && document.body && document.body.classList.contains('in-room');
    const v = inRoom && typeof lastState !== 'undefined' && lastState && lastState.variant;
    return GUIDE_VARIANTS.includes(v) ? v : 'nlhe';
}
const cardsHtml = (cs) => cs.map(c => formatCard(rpParseCard(c))).join('');
function renderHandGuide() {
    const v = guideVariant, sd = v === 'shortdeck', plo = v === 'plo';
    document.getElementById('hg-tabs').innerHTML = GUIDE_VARIANTS.map(k =>
        `<button type="button" class="hg-tab v-${k}${k === v ? ' sel' : ''}" onclick="setGuideVariant('${k}')">${variantIcon(k)}<span>${variantName(k)}</span></button>`).join('');
    const box = document.querySelector('#hand-guide .hg-box');
    if (box) GUIDE_VARIANTS.forEach(k => box.classList.toggle('v-' + k, k === v));   // 弹窗的强调色跟着分页走
    const intro = sd ? L('去掉 2–5，只用 36 张。和德州不一样的地方标了出来：同花大于葫芦；A-6-7-8-9 是最小的顺子。', 'Deuces to fives removed, 36 cards. Rows that differ from Hold\'em are marked: a flush beats a full house, and A-6-7-8-9 is the lowest straight.')
        : plo ? L('每人 4 张底牌。牌型大小和德州一样，但必须正好用 2 张底牌 + 3 张公共牌来组牌，不多不少。', 'Four hole cards each. Same rankings as Hold\'em, but your hand must use exactly two hole cards plus three from the board, no more, no less.')
        : '';
    let html = intro ? `<div class="hg-variant">${intro}</div>` : '';
    if (plo) {
        html += `<div class="hg-sec">${L('最容易看错的三种情况', 'Three common misreads')}</div>`
            + PLO_MISREADS.map(m => `<div class="hg-mis">`
                + `<div class="hg-mis-cards"><span class="hg-lbl">${L('手牌', 'Hand')}</span><span class="hg-cards">${cardsHtml(m.hole)}</span>`
                + `<span class="hg-lbl">${L('公共牌', 'Board')}</span><span class="hg-cards">${cardsHtml(m.board)}</span></div>`
                + `<div class="hg-mis-verdict"><s>${handCat(m.looks)}</s> → <b>${handCat(m.is)}</b></div>`
                + `<div class="hg-desc">${L(m.zh, m.en)}</div></div>`).join('')
            + `<div class="hg-sec">${L('牌型大小（和德州一样）', 'Hand rankings (same as Hold\'em)')}</div>`;
    }
    html += guideRows(v).map((h, i) =>
        `<div class="hg-row${h.diff ? ' diff' : ''}"><span class="hg-no">${i + 1}</span>`
        + `<div class="hg-main"><div class="hg-name">${handCat(h.cat)}${h.diff ? `<span class="hg-diff">${L('和德州不同', 'Differs from Hold\'em')}</span>` : ''}</div><div class="hg-desc">${L(h.zh, h.en)}</div></div>`
        + `<div class="hg-cards">${cardsHtml(h.cards)}</div></div>`).join('');
    document.getElementById('hg-list').innerHTML = html;
    // 底部那句「两张底牌 + 五张公共牌」在奥马哈里是错的：换成奥马哈那句。
    // data-i18n 一起换，切语言时 applyLang() 才会按新的那条重写
    const note = document.querySelector('#hand-guide .hg-note');
    if (note) {
        note.setAttribute('data-i18n', plo ? 'hg.notePlo' : 'hg.note');
        note.textContent = plo ? t('hg.notePlo') : t('hg.note');
    }
}
function setGuideVariant(v) {
    if (!GUIDE_VARIANTS.includes(v)) return;
    guideVariant = v;
    renderHandGuide();
    const list = document.getElementById('hg-list');
    if (list && list.closest('.modal-box')) list.closest('.modal-box').scrollTop = 0;
}
function openHandGuide(v) {
    guideVariant = GUIDE_VARIANTS.includes(v) ? v : tableVariantNow();
    renderHandGuide();
    document.getElementById('hand-guide').style.display = 'flex';
    // 弹窗是同一个元素反复开：不归零的话会停在上次滚到的位置，顶上的玩法分页被藏住
    const box = document.querySelector('#hand-guide .hg-box');
    if (box) box.scrollTop = 0;
}
function closeHandGuide() { document.getElementById('hand-guide').style.display = 'none'; }
onLangChange(() => { if (document.getElementById('hand-guide').style.display !== 'none') renderHandGuide(); });

// ── 第一次坐到短牌 / 奥马哈桌上：一张规则小卡（2026-11-19）──
// 三步新手提示一台设备只出一次，而且只给新来的人；德州老手第一次进短牌 / 奥马哈桌，没有任何东西告诉他规则变了。
// 所以这张卡给【所有人】，每种玩法每台设备一次；不挡操作（贴在顶上），点「知道了」或「牌型大小」才算看过。
const VARIANT_INTRO = {
    shortdeck: { title: { zh: '这是一张短牌桌', en: 'This is a short deck table' }, zh: '去掉了 2–5，只用 36 张牌。和德州不一样的两处：同花比葫芦大；A-6-7-8-9 是最小的顺子。',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
                 en: 'Deuces to fives are removed (36 cards). Two differences from Hold\'em: a flush beats a full house, and A-6-7-8-9 is the lowest straight.' },   // i18n-ok: 成对的 zh/en 数据
    plo:       { title: { zh: '这是一张奥马哈桌', en: 'This is an Omaha table' }, zh: '每人 4 张底牌，必须正好用其中 2 张 + 3 张公共牌来组牌（手里四张同花不算同花）。底池限注：最多加到跟注后的底池。',   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
                 en: 'Four hole cards each. You must use exactly two of them plus three from the board (four suited cards in your hand is not a flush). Pot limit: the most you can raise to is the pot after calling.' },   // i18n-ok: 成对的 zh/en 数据
};
const INTRO_KEY = (v) => 'variantIntro.' + v;
let introVariant = null;
function introSeen(v) { try { return !!localStorage.getItem(INTRO_KEY(v)); } catch { return true; } }   // 存不了就别反复弹
function maybeShowVariantIntro(state) {
    const v = state && state.variant;
    if (!Object.hasOwn(VARIANT_INTRO, v) || introVariant === v || introSeen(v)) return;
    introVariant = v;
    const el = document.getElementById('variant-intro');
    el.className = 'variant-intro v-' + v;
    el.innerHTML = `<div class="rc-vtile" aria-hidden="true">${ic(VARIANT_ICON[v])}<b>${L(variantName(v), VARIANT_CODE[v])}</b></div>`
        + `<div class="vi-main"><div class="vi-title">${L(VARIANT_INTRO[v].title.zh, VARIANT_INTRO[v].title.en)}</div>`
        + `<div class="vi-text">${L(VARIANT_INTRO[v].zh, VARIANT_INTRO[v].en)}</div>`
        + `<div class="vi-btns"><button type="button" onclick="closeVariantIntro(true);openHandGuide('${v}')">${ic('book')}<span>${L('牌型大小', 'Hand rankings')}</span></button>`
        + `<button type="button" class="confirm" onclick="closeVariantIntro(true)">${L('知道了', 'Got it')}</button></div></div>`;
    el.style.display = 'flex';
}
// seen=false：没看就离开了牌桌（回大厅），下次进这种桌还会出现
function closeVariantIntro(seen) {
    const el = document.getElementById('variant-intro');
    if (!el || el.style.display === 'none') { introVariant = null; return; }
    el.style.display = 'none';
    if (seen && introVariant) { try { localStorage.setItem(INTRO_KEY(introVariant), '1'); } catch { /* 存不了就下次再看一遍，无害 */ } }
    introVariant = null;
}
const variantIntroOpen = () => { const el = document.getElementById('variant-intro'); return !!(el && el.style.display !== 'none'); };
onLangChange(() => { if (variantIntroOpen() && introVariant) { const v = introVariant; introVariant = null; maybeShowVariantIntro({ variant: v }); } });

// ── 第一次被发到牌时的三步提示 ──
const COACH_KEY = 'coachSeen';
let coachStep = -1;
function coachSteps() {
    return [
        // 奥马哈是 4 张底牌，而且必须正好用其中 2 张 —— 新手最容易不知道的就是这一条
        (typeof lastState !== 'undefined' && lastState && lastState.holeCount === 4)
            ? { sel: `.seat[data-uid="${myUserId}"] .self-cards`,
                zh: '这是你的四张底牌，只有你自己看得见。奥马哈必须正好用其中两张、再加三张公共牌来组牌。', en: 'These are your four hole cards. Only you can see them. In Omaha you must use exactly two of them plus three from the board.' }   // i18n-ok: 成对的 zh/en 数据
            : { sel: `.seat[data-uid="${myUserId}"] .self-cards`,
                zh: '这是你的两张底牌，只有你自己看得见。', en: 'These are your two hole cards. Only you can see them.' },   // i18n-ok: 成对的 zh/en 数据（牌型名由 handCat 翻）
        (typeof lastState !== 'undefined' && lastState && lastState.holeCount === 4)
            ? { sel: '#community',
                zh: '中间是公共牌（最多 5 张），所有人共用。从你的四张里挑两张、公共牌里挑三张，凑出最好的五张来比大小。',   // i18n-ok: 成对的 zh/en 数据
                en: 'These are the community cards (up to 5), shared by everyone. Pick two of your four plus three of these to make your best five.' }
            : { sel: '#community',
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
        if (variantIntroOpen()) { setTimeout(tryStart, 1000); return; }   // 先让人读完那张玩法规则卡，两样别同时冒出来
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
