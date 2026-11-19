'use strict';
// 「玩法」层（2026-11-19，短牌 / 奥马哈）。德州的行为由 golden/holdem-golden.test.js 钉死；这里守结构：
//   ① 牌局代码只能经过玩法层去评估 / 建牌堆 / 发牌 —— 有人绕过去直接调 HandEvaluator，奥马哈会【悄悄算错】
//     （evaluate7Cards 只看前 7 张：奥马哈 9 张牌会无声忽略后两张底牌），短牌会认不出 A-6-7-8-9
//   ② 玩法建房时定、之后不可改；没写 = 德州
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { variantOf, variantById, normalizeVariant } = require('./src/games/poker/variants');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
function walk(dir) {
    return fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('🔴 牌局代码不许绕过玩法层直接评估（只有 variants/ 里可以碰 HandEvaluator 的评估函数）', () => {
    const bad = [];
    for (const f of walk('src')) {
        if (f.split(path.sep).includes('variants')) continue;
        const code = codeOf(read(f));
        if (/HandEvaluator\.(evaluate7Cards|evaluate5Cards|bestHand|bestHandFrom|handCategory)\b/.test(code)) bad.push(f);
    }
    assert.deepEqual(bad, [], '这些文件直接调了 HandEvaluator：要改成 variantOf(game).score / best / bestPartial / category');
    // 胜率在 src 外面：不传玩法时才退回德州的原写法
    assert.match(read('equity.js'), /variant \? variant\.score\(board, holes\[id\]\) : HandEvaluator\.evaluate7Cards/);
});

test('🔴 发牌和建牌堆走玩法：底牌张数、牌堆点数都从玩法来', () => {
    const hs = codeOf(read('src/games/poker/hand-service.js'));
    assert.match(hs, /game\.deck\.reset\(variant\.ranks\)/);
    assert.match(hs, /for \(let k = 0; k < variant\.holeCount; k\+\+\) hole\.push\(game\.deck\.drawCard\(\)\)/);
    assert.doesNotMatch(hs, /const c1 = game\.deck\.drawCard\(\)/, '不许再写死「发两张」');
    assert.match(read('src/socket/events/poker-card-events.js'), /index >= 0 && index < hole\.length/, '亮牌的张数也按底牌张数');
});

test('没写玩法 = 德州；不认识的玩法也当德州（老房间、老牌谱、乱传的参数）', () => {
    assert.equal(variantOf({}).id, 'nlhe');
    assert.equal(variantOf({ config: {} }).id, 'nlhe');
    assert.equal(variantOf({ config: { variant: 'nonsense' } }).id, 'nlhe');
    assert.equal(variantById(undefined).id, 'nlhe');
    assert.equal(normalizeVariant('nonsense'), 'nlhe');
    assert.equal(normalizeVariant(undefined), 'nlhe');
});

test('德州的牌谱不写玩法字段（没写 = 德州：历史牌谱和黄金样本都不受影响）', () => {
    assert.match(read('src/games/poker/hand-service.js'), /\.\.\.\(variant\.id !== 'nlhe' \? \{ variant: variant\.id \} : \{\}\)/);
});

test('玩法建房时定、之后不可改：建房两处都收，「再来一局」带过去；任何房主操作都不改它', () => {
    const lobby = read('src/socket/events/lobby-events.js');
    assert.equal((lobby.match(/variant: normalizeVariant\(cfg\.variant\)/g) || []).length, 2, 'SNG 和现金桌两处建房都要收玩法');
    assert.match(lobby, /variant: c\.variant \}\)/, '「再来一局」要把玩法带过去（它是逐字段复制 config 的）');
    const all = walk('src/socket/events').map(f => codeOf(read(f))).join('\n');
    assert.doesNotMatch(all, /config\.variant\s*=/, '建房之后谁都不许改玩法');
});

// ───────── 2026-11-19 对抗测试抓出来的 ─────────
test('🔴 对象自带的名字（constructor / __proto__ / toString…）不能被当成玩法', () => {
    const v = require('./src/games/poker/variants');
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'PLO', ' plo', '', null, undefined, 5, {}, []]) {
        assert.equal(v.normalizeVariant(bad), 'nlhe', `「${String(bad)}」应当回落成德州`);
        assert.equal(v.variantById(bad).id, 'nlhe');
        assert.equal(v.variantOf({ config: { variant: bad } }).holeCount, 2);
    }
    for (const ok of ['nlhe', 'shortdeck', 'plo']) assert.equal(v.normalizeVariant(ok), ok);
    // 桌规投票的种类同一个坑
    const rv = require('./src/rooms/rule-vote');
    const game = { roomType: 'cash', ownerUserId: 'h', config: {}, players: [{ userId: 'h' }, { userId: 'a' }] };
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        assert.equal(rv.propose(game, 'h', bad, {}).reason, 'bad', `投票种类「${bad}」应当被拒`);
    }
});

test('🔴 上一手没结算完就开新一手：底池按投入退回，不凭空消失', () => {
    const { createPokerService } = require('./src/games/poker/poker-service');
    const { Deck, HandEvaluator } = require('./PokerLogic');
    const config = require('./src/config');
    const equity = require('./equity');
    const roomGames = {}, noop = () => {};
    const sink = { emit() {} };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const svc = createPokerService({ io, db: { raw: { transaction: (f) => f }, appendHand: noop, matches: { markRecoveryNeeded: noop } }, equity, Deck, HandEvaluator, config, runtime: { roomGames },
        hooks: { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop }, persistence: { commit: noop } });
    // 结算时抛错留下的样子：两人各投入 220（已收进底池），一人桌上还有 100 没收
    const game = { roomType: 'cash', status: 'running', phase: 'river', matchId: 'm', config: { sb: 10, bb: 20, ante: 0, maxPlayers: 2 }, deck: new Deck(),
        players: [0, 1].map(i => ({ userId: 'u' + i, username: 'p' + i, seat: i, socketId: 's' + i, chips: 1680, buyIn: 2000, currentBet: i === 0 ? 100 : 0, committed: 220, folded: false, allIn: false, hasActed: true })),
        buttonSeat: 1, handSeq: 7, holeCards: {}, communityCards: [], pot: 440, currentBet: 100, actionOnIdx: -1 };
    roomGames.R = game;
    const before = game.players.reduce((s, p) => s + p.chips + p.currentBet + p.committed, 0);
    const err = console.error; console.error = noop;
    try { svc.startHand('R'); } finally { console.error = err; clearTimeout(game.actionTimer); }
    const after = game.players.reduce((s, p) => s + p.chips + p.currentBet + p.committed, 0);
    assert.equal(game.handSeq, 8, '新一手照常开了');
    assert.equal(after, before, '新一手开始后桌上筹码总数不变（上一手的底池退回去了）');
});
