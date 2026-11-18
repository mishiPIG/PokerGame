'use strict';
// 手机数字键盘（2026-11-17 玩家视角复盘 P5）。
// 和 hotkeys.test.js 一样：不引 jsdom，用 vm + 最小 DOM 桩加载【真实的】70-actions.js。
//
// 守的几件事：
//   ① 触屏上金额框只读（不弹系统软键盘 —— 软键盘会把整个牌桌顶起来、座位重排）；电脑上照旧能打字
//   ② 键盘刚弹出时按第一个数字是【替换】预填金额，不是接在后面（预填 80，按 5 → 5，不是 805）
//   ③ 滑条跟着输入走；确认按钮显示的是【实际会下的】数（夹在最小加注 ~ 全下之间）
//   ④ 下注发出去后键盘收起
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'public/js/70-actions.js'), 'utf8');

function el(extra = {}) {
    const classes = new Set();
    return {
        value: '', readOnly: false, textContent: '', innerHTML: '', min: '0', max: '0',
        style: { display: 'none', setProperty() {} },
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
        ...extra,
    };
}

function makeEnv({ coarse }) {
    const els = {
        raiseAmount: el(), betSlider: el({ min: '80', max: '3000' }), 'bet-keypad': el(),
        'sizing-row': el(), btnConfirmBet: el(), 'bet-info': el(),
    };
    const sent = [];
    const ctx = {
        console, Math, String, parseInt, isNaN,
        setInterval() {}, requestAnimationFrame: (fn) => fn(),
        window: { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }) },
        document: { getElementById: (id) => els[id] || null, body: { classList: { toggle() {}, remove() {} } } },
        L: (zh) => zh, t: (k) => k, toast() {}, fmtChips: (n) => String(n), curBB: () => 40,
        inputLocked: () => false, lastState: { players: [{ userId: 'me', chips: 3000 }] }, myUserId: 'me',
        socket: { emit: (ev, data) => sent.push({ ev, data }) }, currentRoom: 'R',
    };
    vm.createContext(ctx);
    vm.runInContext(SOURCE + '\n;this.__set = (v) => { sizeCtx = v; };', ctx);
    ctx.__set({ minTo: 80, maxTo: 3000, currentBet: 40, myBet: 0, totalPot: 60 });
    return { ctx, els, sent };
}

test('触屏：金额框只读、不弹系统键盘；点它弹出自带键盘', () => {
    const { ctx, els } = makeEnv({ coarse: true });
    ctx.openSizing();
    assert.equal(els.raiseAmount.readOnly, true);
    assert.equal(els.raiseAmount.attrs.inputmode, 'none');
    assert.equal(els['bet-keypad'].style.display, 'none', '刚展开面板时键盘不弹，点了金额框才弹');
    ctx.toggleKeypad();
    assert.equal(els['bet-keypad'].style.display, '');
});

test('键盘开着时面板挂 kp-open（压扁 + 半透明，不挡公共牌）；收起 / 重开面板都会摘掉', () => {
    const { ctx, els } = makeEnv({ coarse: true });
    ctx.openSizing();
    assert.equal(els['sizing-row'].classList.contains('kp-open'), false);
    ctx.toggleKeypad();
    assert.equal(els['sizing-row'].classList.contains('kp-open'), true);
    ctx.toggleKeypad();
    assert.equal(els['sizing-row'].classList.contains('kp-open'), false, '再点一下金额框收起');
    ctx.toggleKeypad();
    ctx.hideKeypad();
    assert.equal(els['sizing-row'].classList.contains('kp-open'), false, '下注发出 / 面板收起时一起摘掉');
    // CSS 那头：键盘排成 6 列、开着时底板半透明
    const css = fs.readFileSync(path.join(__dirname, 'public/css/20-table.css'), 'utf8');
    const shell = fs.readFileSync(path.join(__dirname, 'public/css/00-shell.css'), 'utf8');
    assert.match(css, /\.bet-keypad \{[^}]*repeat\(6, 1fr\)/);
    assert.match(shell, /#sizing-row\.kp-open \{ background: rgba\([^)]*0\.\d+\)/);
});

test('电脑：照旧能在框里打字，点框不弹自带键盘', () => {
    const { ctx, els } = makeEnv({ coarse: false });
    ctx.openSizing();
    assert.equal(els.raiseAmount.readOnly, false);
    ctx.toggleKeypad();
    assert.equal(els['bet-keypad'].style.display, 'none');
});

test('第一个数字替换预填金额；之后接着输入；退格删一位', () => {
    const { ctx, els } = makeEnv({ coarse: true });
    ctx.openSizing();
    assert.equal(els.raiseAmount.value, 80, '预填最小加注');
    ctx.toggleKeypad();
    ctx.keypadPress('5');
    assert.equal(els.raiseAmount.value, '5', '不是 805');
    ctx.keypadPress('00');
    assert.equal(els.raiseAmount.value, '500');
    ctx.keypadPress('del');
    assert.equal(els.raiseAmount.value, '50');
});

test('滑条跟着走；确认按钮显示夹过之后真正会下的数', () => {
    const { ctx, els, sent } = makeEnv({ coarse: true });
    ctx.openSizing(); ctx.toggleKeypad();
    ctx.keypadPress('1'); ctx.keypadPress('2'); ctx.keypadPress('00');
    assert.equal(Number(els.betSlider.value), 1200);
    assert.match(els.btnConfirmBet.textContent, /1200$/);
    ctx.keypadPress('00');   // 120000 → 超过全下额
    assert.match(els.btnConfirmBet.textContent, /3000$/, '超过全下额就按全下显示');
    ctx.confirmBet();
    assert.equal(sent[0].data.amount, 3000);
    assert.equal(els['bet-keypad'].style.display, 'none', '下注发出去后键盘收起');
});

test('删光了再确认：什么都不发（不会发出 0 或 NaN）', () => {
    const { ctx, els, sent } = makeEnv({ coarse: true });
    ctx.openSizing(); ctx.toggleKeypad();
    ctx.keypadPress('7'); ctx.keypadPress('del');
    assert.equal(els.raiseAmount.value, '');
    ctx.confirmBet();
    assert.equal(sent.length, 0);
});
