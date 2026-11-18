'use strict';
// 美术第二轮 ⑤b（2026-11-18）：操作手感三件 —— 按钮轻振动、手机下注滑条、全押跑马慢翻（搓牌）。
// 真实效果（滑条按中间跳到一半、拖到头是全下；转牌盖着落下再从底边揭开）上线前用真浏览器触屏手势逐帧看过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

function actionsEnv({ coarse = true } = {}) {
    const buzz = [], sent = [];
    const el = () => ({ value: '', min: '80', max: '2000', step: '1', style: { display: 'none', setProperty() {} },
        classList: { toggle() {}, remove() {}, add() {}, contains: () => false }, setAttribute() {},
        getBoundingClientRect: () => ({ left: 100, width: 232 }) });
    const els = {};
    const ctx = {
        console, Math, String, parseInt, isNaN, setTimeout: (fn) => fn(), setInterval() {}, requestAnimationFrame: (fn) => fn(),
        window: { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }) },
        document: { getElementById: (id) => (els[id] = els[id] || el()), querySelectorAll: () => [], body: { classList: { toggle() {}, remove() {} } } },
        L: (zh) => zh, t: (k) => k, toast() {}, fmtChips: (n) => String(n), curBB: () => 40, inputLocked: () => false,
        myUserId: 'me', currentRoom: 'R', vibrate: (ms) => buzz.push(ms),
        socket: { emit: (ev, d) => sent.push(d) },
        lastState: { actionOnUserId: 'me', currentBet: 40, players: [{ userId: 'me', currentBet: 0, chips: 2000 }] },
    };
    vm.createContext(ctx);
    vm.runInContext(read('public/js/70-actions.js') + '\n;this.__set = (v) => { sizeCtx = v; };', ctx);
    ctx.__set({ minTo: 80, maxTo: 2000, currentBet: 40, myBet: 0, totalPot: 60 });
    return { ctx, buzz, sent, els };
}

test('触屏上按行动按钮会轻振一下（弃 / 跟 / 下注加注 / 数字键盘）；电脑上不振', () => {
    const a = actionsEnv();
    a.ctx.act('call');
    a.ctx.sendSize(400);
    a.ctx.keypadPress('5');
    assert.deepEqual(a.buzz, [12, 12, 6], '行动 12ms、数字键盘 6ms');
    assert.equal(a.sent.length, 2);
    const pc = actionsEnv({ coarse: false });
    pc.ctx.act('call');
    assert.deepEqual(pc.buzz, []);
});

test('手机滑条：按到哪里就是哪里；最左是最小加注、拖到头一定是全下', () => {
    const { ctx } = actionsEnv();
    const sl = { min: '80', max: '2000', step: '1', getBoundingClientRect: () => ({ left: 100, width: 232 }) };
    // 两端各留半个圆钮（32px）：可用宽度 200px，从 116px 开始
    assert.equal(ctx.sliderValueAt(sl, 50), 80, '按在滑条左边外面 = 最小');
    assert.equal(ctx.sliderValueAt(sl, 116), 80);
    assert.equal(ctx.sliderValueAt(sl, 216), 1040, '正中间 = 一半');
    assert.equal(ctx.sliderValueAt(sl, 316), 2000);
    assert.equal(ctx.sliderValueAt(sl, 999), 2000, '拖出右边 = 全下');
    // 有步长时吸附到步长上，但拖到头仍然是全下额（哪怕全下额不是步长的整数倍）
    // 1970：按步长 40 四舍五入会落到 1960（比全下少 10）—— 所以「拖到头」必须单独判，不能只靠吸附
    const stepped = { min: '80', max: '1970', step: '40', getBoundingClientRect: () => ({ left: 100, width: 232 }) };
    assert.equal((ctx.sliderValueAt(stepped, 200) - 80) % 40, 0);
    assert.equal(ctx.sliderValueAt(stepped, 999), 1970);
});

test('🔴 慢翻只在全押跑马的转牌 / 河牌上出现；「减少动态效果」时不搓', () => {
    const render = read('public/js/80-table-renderer.js');
    assert.match(render, /if \(isNew && allinSpot && i >= 3 && !reducedMotion\(\)\) \{ opts\.squeeze = true;/);
    assert.match(render, /if \(opts\.squeeze\)\s+cls\.push\('squeeze'\)/);
    const css = read('public/css/20-table.css');
    assert.match(css, /\.card\.squeeze::after \{[^}]*background: var\(--card-back-art\)/, '揭开的盖板就是同一张牌背');
    assert.match(css, /body \.card\.back \{\s*background: var\(--card-back-art\)/, '牌背和盖板共用一份图案');
    assert.match(css, /@keyframes squeezePeel/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.card\.squeeze::after \{ display: none; \} \}/);
    // 揭开要在服务端下一街到来之前完成（每街间隔 RUNOUT_DELAY）
    const dur = Number((css.match(/animation: squeezePeel ([\d.]+)s/) || [])[1]) * 1000;
    const { RUNOUT_DELAY } = require('./src/config');
    assert.ok(dur > 0 && dur < RUNOUT_DELAY, `慢翻 ${dur}ms 要短于每街间隔 ${RUNOUT_DELAY}ms`);
});

test('🔴 协商发多次时，每一组的转牌 / 河牌也慢翻（2026-11-18 玩家反馈：多次发牌时最后两张没有慢翻）', () => {
    const room = read('public/js/30-room.js');
    const fn = room.slice(room.indexOf('function runitDealStreet'), room.indexOf('function runitAward'));
    assert.match(fn, /if \(start \+ k >= 3 && !reducedMotion\(\)\) \{ slot\.outerHTML = formatCard\(c, false, k \* 130, \{ squeeze: true \}\)/);
    assert.match(fn, /setTimeout\(\(\) => sndFlip\(0\), 1000\)/);
    // 每组每街之间的停顿要比慢翻长，否则下一张会在这一张还没揭开时就发出来
    const svc = fs.readFileSync(path.join(__dirname, 'src/games/poker/extensions/run-it/run-it-service.js'), 'utf8');
    const street = Number((svc.match(/const RUNIT_STREET_MS = (\d+)/) || [])[1]);
    const css = read('public/css/20-table.css');
    const dur = Number((css.match(/animation: squeezePeel ([\d.]+)s/) || [])[1]) * 1000;
    assert.ok(dur < street, `慢翻 ${dur}ms 要短于多次发牌每街间隔 ${street}ms`);
});

