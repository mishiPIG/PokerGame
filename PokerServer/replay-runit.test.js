'use strict';
// 牌谱回放：多次发牌（run it N times）要把每一次都放出来（2026-11-18 玩家反馈「只会回放一次」）。
// 原来回放只用 h.community（第 1 次那一组）。vm 加载真实的 42-replay.js，只测帧的生成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
    const ctx = { console, Math, L: (zh) => zh, fmtChips: (n) => String(n), myUserId: 'a' };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js/42-replay.js'), 'utf8') + '\n;this.build = buildReplayFrames;', ctx);
    return ctx.build;
}

// 单挑翻前全押、发两次：第 1 次 A 赢，第 2 次 B 赢，各得 2000
function runitHand() {
    return {
        ts: 1, sb: 20, bb: 40, ante: 0, buttonUserId: 'a',
        seats: [
            { userId: 'a', username: 'Ann', seat: 0, startChips: 2000, hole: ['AS', 'AH'] },
            { userId: 'b', username: 'Bob', seat: 1, startChips: 2000, hole: ['KS', 'KH'] },
        ],
        actions: [
            { userId: 'a', street: 'preflop', action: 'raise', amount: 2000 },
            { userId: 'b', street: 'preflop', action: 'call', amount: 2000 },
        ],
        community: ['2C', '7D', '9H', 'JS', '3C'],
        runIt: {
            n: 2,
            boards: [['2C', '7D', '9H', 'JS', '3C'], ['KD', '4C', '8S', '5H', 'QD']],
            winners: [['a'], ['b']],
            amounts: [2000, 2000],
        },
        results: [{ userId: 'a', won: 2000, endChips: 2000 }, { userId: 'b', won: 2000, endChips: 2000 }],
    };
}

test('🔴 发两次就放两次：每一次各一帧、用那一次的公共牌，最后一帧把两组都摆出来', () => {
    const frames = load()(runitHand());
    const runs = frames.filter(f => f.board);
    assert.equal(runs.length, 2, '每一次各一帧');
    assert.deepEqual(runs[0].board.map(c => c.rank + c.suit[0]), ['2C', '7D', '9H', 'JS', '3C']);
    assert.deepEqual(runs[1].board.map(c => c.rank + c.suit[0]), ['KD', '4C', '8S', '5H', 'QD'], '第 2 次用第 2 组，不是又放一遍第 1 组');
    assert.match(runs[0].caption, /第 1 次 · Ann \+2000/);
    assert.match(runs[1].caption, /第 2 次 · Bob \+2000/);
    const last = frames[frames.length - 1];
    assert.equal(last.boards.length, 2, '最后一帧总览两组');
    assert.match(last.caption, /共发 2 次/);
});

test('筹码跟着每一次走；最后以牌谱记录的结果为准、底池清零；全押后底牌亮出', () => {
    const frames = load()(runitHand());
    const runs = frames.filter(f => f.board);
    const stack = (f, id) => f.players.find(p => p.userId === id).stack;
    assert.equal(stack(runs[0], 'a'), 2000, '第 1 次 A 拿到一半');
    assert.equal(stack(runs[0], 'b'), 0);
    assert.equal(stack(runs[1], 'b'), 2000, '第 2 次 B 拿到另一半');
    const last = frames[frames.length - 1];
    assert.equal(stack(last, 'a'), 2000);
    assert.equal(stack(last, 'b'), 2000);
    assert.equal(last.pot, 0);
    assert.ok(runs[0].players.every(p => p.showCards), '全押后两家的牌都亮着');
});

test('没发多次的牌谱照旧：最后一帧是摊牌、用 h.community', () => {
    const h = runitHand();
    delete h.runIt;
    const frames = load()(h);
    assert.equal(frames.filter(f => f.board || f.boards).length, 0);
    const last = frames[frames.length - 1];
    assert.match(last.caption, /摊牌/);
    assert.equal(last.community, 5);
});

test('🔴 全押没人跟：回放最后一帧要把没人跟的那部分退回给下注的人（2026-11-18 压测抓到：牌谱 2620、回放 40）', () => {
    // 单挑：A 平跟 20，B 全押 2600，A 弃牌。服务端退还 B 没人跟的 2580，B 赢下 40 的底池 → 结束 2620。
    // won 只记争到的底池（40），不含退还 —— 回放自己加 won 就会少一大截。
    const build = load();
    const h = {
        ts: 1, sb: 10, bb: 20, ante: 0, buttonUserId: 'a',
        seats: [
            { userId: 'a', username: 'Ann', seat: 0, startChips: 2000, hole: ['AH', 'TH'] },
            { userId: 'b', username: 'Bob', seat: 1, startChips: 2600, hole: ['7H', 'KS'] },
        ],
        actions: [
            { userId: 'a', street: 'preflop', action: 'call', amount: 20 },
            { userId: 'b', street: 'preflop', action: 'raise', amount: 2600 },
            { userId: 'a', street: 'preflop', action: 'fold', amount: 20 },
        ],
        community: [],
        results: [{ userId: 'a', won: 0, endChips: 1980 }, { userId: 'b', won: 40, endChips: 2620 }],
    };
    const last = build(h).at(-1);
    assert.deepEqual(last.players.map(p => [p.userId, p.stack]), [['a', 1980], ['b', 2620]]);
});

test('7-2 奖励：摊牌那一帧是奖励前的筹码，下一帧才加上（最后一帧 = 牌谱）', () => {
    const build = load();
    const h = {
        ts: 1, sb: 10, bb: 20, ante: 0, buttonUserId: 'a',
        seats: [
            { userId: 'a', username: 'Ann', seat: 0, startChips: 1000, hole: ['7H', '2S'] },
            { userId: 'b', username: 'Bob', seat: 1, startChips: 1000, hole: ['KS', 'KH'] },
        ],
        actions: [
            { userId: 'a', street: 'preflop', action: 'raise', amount: 100 },
            { userId: 'b', street: 'preflop', action: 'fold', amount: 20 },
        ],
        community: [],
        sevenDeuce: { userId: 'a', bounty: 40, total: 40, payers: [{ userId: 'b', paid: 40 }] },
        results: [{ userId: 'a', won: 120, endChips: 1060 }, { userId: 'b', won: 0, endChips: 940 }],
    };
    const fr = build(h);
    const stacks = (f) => f.players.map(p => p.stack);
    assert.deepEqual(stacks(fr.at(-2)), [1020, 980], '摊牌：A 赢了 B 的 20 大盲');
    assert.deepEqual(stacks(fr.at(-1)), [1060, 940], '7-2 奖励：B 再付 40');
});
