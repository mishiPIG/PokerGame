'use strict';
// 德州黄金样本比对（2026-11-18，短牌 / 奥马哈第 0 期）。生成器与规矩见 holdem-golden.js 开头。
//
// 🔴 这里挂了 = 德州的行为变了。先查是哪一步改出来的，绝不允许「--write 重新生成让它变绿」，
//    除非是有意改变德州行为、而且用户同意了。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const g = require('./holdem-golden');

const fixture = (k) => JSON.parse(fs.readFileSync(g.FILES[k], 'utf8'));

// 离线验算器（tools/verify-hand.js）是给玩家用的命令行工具，没有导出函数，也不改它：
// 把它定义 verify() 的那一段截出来加载（后面是读文件、打印、退出，不要）。
function loadVerify() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'verify-hand.js'), 'utf8');
    const cut = src.indexOf('const hand = readInput();');
    assert.ok(cut > 0, '验算器结构变了：找不到 readInput() 那一行');
    const dir = path.join(__dirname, '..', 'tools');
    const ctx = { require: (m) => require(m.startsWith('.') ? path.join(dir, m) : m), __dirname: dir, __filename: path.join(dir, 'verify-hand.js'), process: { argv: ['node', 'verify'], exit() {} }, console, Buffer };
    vm.createContext(ctx);
    vm.runInContext(src.slice(0, cut) + '\n;this.verify = verify;', ctx);
    return ctx.verify;
}

// 找出第一处不一样的地方，报得具体一点（不然 400KB 的 JSON 只会说「不相等」）
function firstDiff(a, b, p = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], p + '.' + k); if (d) return d; }
    }
    return `${p}: 现在 ${JSON.stringify(a)} ≠ 答案 ${JSON.stringify(b)}`.slice(0, 600);
}

test('G1 判牌：6 万手 7 张牌的分数 / 最强 5 张 / 牌型名和答案一字不差', () => {
    const want = fixture('evaluator');
    const got = g.runEvaluator(want.n);
    if (got.hash !== want.hash) {
        const i = got.sample.findIndex((r, k) => r !== want.sample[k]);
        assert.fail(`判牌结果变了${i >= 0 ? `：第 ${i} 手 现在「${got.sample[i]}」，答案「${want.sample[i]}」` : '（前 200 手相同，差异在后面）'}`);
    }
    assert.deepEqual(got.byCategory, want.byCategory);
});

test('G2 整手牌：真引擎 110 手（全押 / 边池 / 多次发牌 / 链式 straddle / 前注 / Bomb / 7-2）和答案一字不差', () => {
    const want = fixture('engine');
    const got = g.runEngine();
    if (got.hash !== want.hash) {
        const i = got.hands.findIndex((x, k) => JSON.stringify(x) !== JSON.stringify(want.hands[k]));
        assert.fail(`第 ${i + 1} 手不一样（${want.hands[i] && want.hands[i].hand.roomId} 桌）${firstDiff(got.hands[i], want.hands[i])}`);
    }
    assert.deepEqual(got.facts, want.facts);
});

test('G2 答案本身是对的：每一手单手守恒，而且确实覆盖了要钉住的那些路径', () => {
    const { hands, facts } = fixture('engine');
    for (const { hand: h } of hands) {
        const start = h.seats.reduce((a, s) => a + s.startChips, 0), end = h.results.reduce((a, r) => a + r.endChips, 0);
        assert.equal(end, start, `${h.matchId} 第 ${h.handSeq} 手不守恒（答案里存了一个错的结果）`);
    }
    // 覆盖面：这几条一旦变成 0，就说明样本没打到那条路径，钉不住它
    for (const k of ['bomb', 'straddle', 'chainStraddle', 'runIt', 'allInHands', 'showdown', 'sevenDeuce']) assert.ok(facts[k] > 0, `样本里没有 ${k}`);
});

test('G3 离线验算：答案里每一手都能被玩家用的验算器验过（可验证公平没被改坏）', () => {
    const verify = loadVerify();
    const { hands } = fixture('engine');
    for (const { hand: h } of hands) {
        const r = verify(h);
        assert.equal(r.ok, true, `${h.matchId} 第 ${h.handSeq} 手验算不过：` + JSON.stringify(r.out.filter(x => !x[1])));
    }
});

test('G4 胜率：60 个穷举局面的胜率和答案一字不差', () => {
    const want = fixture('equity');
    const got = g.runEquity(want.length);
    for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `第 ${i} 个局面`);
});

test('生成器跑完把全局的计时器 / 时钟 / 随机数原样还回去（不污染同一进程里的其它测试）', () => {
    const st = global.setTimeout, now = Date.now, rnd = Math.random;
    g.runEquity(1);
    g.runEngine.length;   // 不重复跑整局，上面的测试已经跑过
    assert.equal(global.setTimeout, st); assert.equal(Date.now, now); assert.equal(Math.random, rnd);
});

test('G3 的验算器真的会拒绝：改掉一张公共牌就验不过（不是一律放行）', () => {
    const verify = loadVerify();
    const { hands } = fixture('engine');
    const h = JSON.parse(JSON.stringify(hands.find(x => (x.hand.community || []).length === 5).hand));
    const used = new Set([...h.seats.flatMap(s => s.hole), ...h.community]);
    h.community[2] = ['AS', 'KD', '2C', '7H', 'QS', '3D'].find(c => !used.has(c));
    assert.equal(verify(h).ok, false);
});
