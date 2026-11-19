'use strict';
// 美术第二轮 ③（2026-11-17）：手机单手操作的几处「按错 / 挡住」。
//   ① 能免费过牌时点了弃牌 → 先问一句；取消 / 点外面 = 什么都不做
//   ② 新手三步提示开着时轮到自己 → 提示先收起，别挡行动按钮；行动完再接着显示
//   ③ 状态小标签 / 赢额弹字不再压在名字上；手机行动按钮放大到 54px
// 和 bet-keypad.test.js 一样：vm + 最小 DOM 桩加载【真实的】脚本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

function actionsEnv({ toCall = 0, myTurn = true } = {}) {
    const sent = [];
    const asked = [];
    const el = () => ({ value: '', style: { display: 'none', setProperty() {} }, classList: { toggle() {}, remove() {}, add() {}, contains: () => false }, setAttribute() {} });
    const els = {};
    const ctx = {
        console, Math, String, parseInt, isNaN, setTimeout: (fn) => fn(), setInterval() {}, requestAnimationFrame: (fn) => fn(),
        window: { matchMedia: () => ({ matches: false }) },
        document: { getElementById: (id) => (els[id] = els[id] || el()), querySelectorAll: () => [], body: { classList: { toggle() {}, remove() {} } } },
        L: (zh) => zh, t: (k) => k, toast() {}, fmtChips: (n) => String(n), curBB: () => 40, inputLocked: () => false,
        myUserId: 'me', currentRoom: 'R',
        socket: { emit: (ev, d) => sent.push({ ev, d }) },
        uiConfirm: (text, opts) => new Promise(res => asked.push({ text, opts, res })),
    };
    ctx.lastState = { actionOnUserId: myTurn ? 'me' : 'other', currentBet: toCall, players: [{ userId: 'me', currentBet: 0, chips: 3000 }] };
    vm.createContext(ctx);
    vm.runInContext(read('public/js/70-actions.js'), ctx);
    return { ctx, sent, asked };
}
const tick = () => new Promise(r => setImmediate(r));

test('🔴 能过牌时点弃牌：先问，不发弃牌；点「弃牌」才真的弃', async () => {
    const { ctx, sent, asked } = actionsEnv({ toCall: 0 });
    ctx.act('fold');
    assert.equal(sent.length, 0, '还没确认就不能发出去');
    assert.equal(asked.length, 1);
    assert.match(asked[0].text, /免费过牌/);
    assert.equal(asked[0].opts.danger, true, '确认按钮是红色的危险操作');
    asked[0].res(true); await tick();
    assert.deepEqual(sent.map(s => s.d.action), ['fold']);
});

test('取消 / 点外面 = 什么都不做（不弃、也不替他过牌）', async () => {
    const { ctx, sent, asked } = actionsEnv({ toCall: 0 });
    ctx.act('fold');
    asked[0].res(false); await tick();
    assert.equal(sent.length, 0);
});

test('确认框开着时已经轮不到我了（超时 / 别人动了）→ 点了也不发', async () => {
    const { ctx, sent, asked } = actionsEnv({ toCall: 0 });
    ctx.act('fold');
    ctx.lastState.actionOnUserId = 'other';
    asked[0].res(true); await tick();
    assert.equal(sent.length, 0);
});

test('要跟注时弃牌是正常操作：不问，直接弃', () => {
    const { ctx, sent, asked } = actionsEnv({ toCall: 80 });
    ctx.act('fold');
    assert.equal(asked.length, 0);
    assert.deepEqual(sent.map(s => s.d.action), ['fold']);
});

test('预操作「过/弃」在能过牌时走过牌，不会弹确认', () => {
    const { ctx, sent, asked } = actionsEnv({ toCall: 0 });
    ctx.togglePre('checkfold');
    ctx.runPreAction(0);
    assert.equal(asked.length, 0);
    assert.deepEqual(sent.map(s => s.d.action), ['check']);
});

// ───────────── 新手提示 ─────────────
function guideEnv() {
    const els = {};
    const mk = () => ({ style: { display: 'none', cssText: '' }, textContent: '', offsetWidth: 200, offsetHeight: 80,
        getBoundingClientRect: () => ({ left: 100, top: 400, width: 80, height: 60, bottom: 460 }) });
    const timers = [];
    const ctx = {
        console, Math, window: { innerWidth: 390, innerHeight: 844, addEventListener() {} },
        setTimeout: (fn) => timers.push(fn),
        document: { getElementById: (id) => (els[id] = els[id] || mk()), querySelector: () => mk() },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        L: (zh) => zh, myUserId: 'me', isGuest: true, mySeated: true, myHoleCards: ['AS', 'KD'], lastState: { phase: 'flop', actionOnUserId: 'other', players: [{ userId: 'me', folded: false }] },
        handCat: (x) => x, escapeHtml: (x) => String(x), onLangChange() {},
    };
    vm.createContext(ctx);
    vm.runInContext(read('public/js/44-guide.js') + '\n;this.__set = (n) => { coachStep = n; };', ctx);
    return { ctx, els, timers };
}

test('🔴 新手提示开着时轮到我 → 先收起；行动完再接着显示同一步', () => {
    const { ctx, els, timers } = guideEnv();
    ctx.__set(1);
    ctx.showCoach();
    assert.equal(els.coach.style.display, 'block');
    ctx.lastState = { phase: 'flop', actionOnUserId: 'me', players: [{ userId: 'me', folded: false }] };
    ctx.syncCoachWithTurn();
    assert.equal(els.coach.style.display, 'none', '轮到我：提示收起，别挡行动按钮');
    assert.equal(els['coach-ring'].style.display, 'none');
    ctx.syncCoachWithTurn();                      // 同一回合里重画多次，不会反复开关
    assert.equal(timers.length, 0);
    ctx.lastState = { phase: 'flop', actionOnUserId: 'other', players: [{ userId: 'me', folded: false }] };
    ctx.syncCoachWithTurn();
    timers.forEach(fn => fn());
    assert.equal(els.coach.style.display, 'block', '行动完：接着显示');
});

test('🔴 新手提示只在一手进行中出现：已摊牌 / 我已弃牌时不开始，等下一手', () => {
    for (const st of [
        { phase: 'showdown', actionOnUserId: null, players: [{ userId: 'me', folded: false }] },
        { phase: 'turn', actionOnUserId: 'other', players: [{ userId: 'me', folded: true }] },
        { phase: 'waiting', actionOnUserId: null, players: [{ userId: 'me', folded: false }] },
    ]) {
        const { ctx, els, timers } = guideEnv();
        ctx.lastState = st;
        ctx.maybeStartCoach();
        for (let i = 0; i < 3; i++) timers.splice(0).forEach(fn => fn());
        assert.notEqual(els.coach && els.coach.style.display, 'block', st.phase + (st.players[0].folded ? '（已弃牌）' : '') + ' 时不该冒出提示');
        assert.ok(timers.length > 0, '还在等：下一手发牌后再开始');
        ctx.lastState = { phase: 'preflop', actionOnUserId: 'other', players: [{ userId: 'me', folded: false }] };
        timers.splice(0).forEach(fn => fn());
        assert.equal(els.coach.style.display, 'block', '下一手一发牌就出来');
    }
});

test('🔴 提示开着时这一手打完 → 先收起；下一手发牌后接着显示同一步', () => {
    const { ctx, els, timers } = guideEnv();
    ctx.__set(1);
    ctx.showCoach();
    const step2 = els['coach-text'].textContent;
    ctx.lastState = { phase: 'showdown', actionOnUserId: null, players: [{ userId: 'me', folded: false }] };
    ctx.syncCoachWithTurn();
    assert.equal(els.coach.style.display, 'none', '摊牌了：收起');
    ctx.lastState = { phase: 'preflop', actionOnUserId: 'other', players: [{ userId: 'me', folded: false }] };
    ctx.syncCoachWithTurn();
    timers.forEach(fn => fn());
    assert.equal(els.coach.style.display, 'block');
    assert.equal(els['coach-text'].textContent, step2, '还是同一步，不是从头来');
});

// ───────────── 样式 ─────────────
test('状态小标签 / 赢额弹字放在名字旁边，不再压名字；朝桌里那一侧由渲染器给 bub-l', () => {
    const css = read('public/css/20-table.css');
    const rule = (sel) => (css.match(new RegExp(sel.replace(/[.]/g, '\\.') + ' \\{[^}]*\\}')) || [''])[0];
    assert.match(rule('.status-bubble'), /left: calc\(100% - 6px\)/);
    assert.doesNotMatch(rule('.status-bubble'), /top: -10px/);
    assert.doesNotMatch(rule('.ready-badge'), /top: -12px/);
    assert.match(css, /\.ring-seat\.bub-l \.status-bubble, \.ring-seat\.bub-l \.ready-badge \{ left: auto; right:/);
    assert.match(css, /\.ring-seat \.seat > \.win-pop \{[^}]*animation-name: winPopSide/);
    assert.match(css, /\.ring-seat\.bottom \.self-info > \.win-pop \{[^}]*right: calc\(100% - 2px\)[^}]*animation-name: winPopSide/, '自己赢的时候也不压自己的名字');
    assert.match(read('public/js/80-table-renderer.js'), /' bub-l'/);
});

test('手机行动按钮 ≥ 52px（触控下限 44–48px）；电脑横屏不走这条（另有整体放大）', () => {
    const css = read('public/css/20-table.css');
    const m = css.match(/body:not\(\.layout-landscape\) #buttons-row \.action-btn \{ width: (\d+)px; height: (\d+)px/);
    assert.ok(m, '手机竖屏的行动按钮尺寸规则还在');
    assert.ok(Number(m[1]) >= 52 && Number(m[2]) >= 52, `现在是 ${m[1]}×${m[2]}`);
});
