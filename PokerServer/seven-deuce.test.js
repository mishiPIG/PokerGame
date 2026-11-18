'use strict';
// 7-2 奖励（2026-11-18，家庭局玩法）。动钱的功能，守三件事：
//   ① 钱只在这一手发到牌的人之间转：单手筹码守恒（Σ结束 = Σ开始），牌谱结束筹码含奖励，审计不误报
//   ② 只有「这一手只有他一个人赢到筹码」才给：平分、各赢一份都不给
//   ③ 奖励额开手时定死：房主中途改设置只影响下一手
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Deck, Card, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');
const sd = require('./src/games/poker/extensions/seven-deuce');

const C = (rank, suit) => ({ rank, suit });

function makeTable(stacks, { sevenDeuceBB = 2, sb = 10, bb = 20, buttonSeat = null } = {}) {
    const roomGames = {};
    const emitted = [];
    const sink = { emit(ev, d) { emitted.push([ev, d]); } };
    const io = { in: () => sink, to: () => ({ emit() {} }), sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const saved = [];
    const noop = () => {};
    const db = { raw: { transaction: (fn) => fn }, appendHand: (h) => saved.push(h), matches: { markRecoveryNeeded: noop } };
    const hooks = { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop };
    const svc = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime: { roomGames }, hooks, persistence: { commit: noop } });
    const game = {
        roomType: 'cash', status: 'running', phase: config.PHASES.WAITING, matchId: 'm1',
        config: { sb, bb, ante: 0, maxPlayers: stacks.length, sevenDeuceBB },
        deck: new Deck(), players: stacks.map((chips, i) => ({
            userId: 'u' + i, username: 'p' + i, displayName: 'P' + i, seat: i, chips, buyIn: chips,
            currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false
        })),
        buttonSeat, handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0
    };
    roomGames.R = game;
    return { svc, game, saved, emitted };
}
const stopTimers = (g) => { clearTimeout(g.actionTimer); clearTimeout(g.runoutTimer); clearTimeout(g.nextHandTimer); };
// 让除 winner 之外的所有人都弃牌（照引擎测试的老办法：改状态再 afterAction）
function foldAllBut(svc, game, winnerId) {
    for (const p of game.players) if (p.userId !== winnerId && !p.folded) { p.folded = true; p.hasActed = true; }
    svc.afterAction('R');
}

test('🔴 真引擎：别人都弃牌、他拿着 7-2 —— 其余每人付 2BB，筹码守恒，牌谱结束筹码含奖励', (t) => {
    const { svc, game, saved, emitted } = makeTable([1000, 1000, 1000]);
    t.after(() => stopTimers(game));
    svc.startHand('R');
    const before = game.players.reduce((s, p) => s + p.chips + p.currentBet, 0);
    assert.equal(game.hand.sevenDeuceBounty, 40, '开手就把这一手的奖励额定下来：2 × 大盲 20');
    const w = game.players[0];
    game.holeCards[w.userId] = [new Card('Hearts', '7'), new Card('Spades', '2')];   // 不同花也算
    foldAllBut(svc, game, w.userId);
    const h = saved[0];
    assert.ok(h && h.sevenDeuce, '牌谱记下了这笔奖励');
    assert.equal(h.sevenDeuce.total, 80, '两个人各付 40');
    assert.deepEqual(h.sevenDeuce.payers.map(x => x.paid), [40, 40]);
    const end = h.results.reduce((s, r) => s + r.endChips, 0);
    const start = h.seats.reduce((s, x) => s + x.startChips, 0);
    assert.equal(end, start, '🔴 单手筹码守恒：Σ结束 = Σ开始（审计看的就是这个）');
    assert.equal(game.players.reduce((s, p) => s + p.chips, 0), before, '桌上总筹码不变');
    assert.ok(emitted.some(([ev, d]) => ev === 'show_cards' && d.userId === w.userId && d.cards.length === 2), '没摊牌也替他亮出 7-2');
    assert.ok(emitted.some(([ev, d]) => ev === 'table_notice' && d.k === 'notice.sevenDeuce' && d.p.total === 80));
});

test('真引擎：没开 7-2 奖励就什么都不发生', (t) => {
    const { svc, game, saved } = makeTable([1000, 1000, 1000], { sevenDeuceBB: 0 });
    t.after(() => stopTimers(game));
    svc.startHand('R');
    game.holeCards.u0 = [new Card('Hearts', '7'), new Card('Hearts', '2')];
    foldAllBut(svc, game, 'u0');
    assert.equal(saved[0].sevenDeuce, undefined);
});

test('🔴 真引擎：奖励额开手时定死，中途改设置不影响这一手', (t) => {
    const { svc, game, saved } = makeTable([1000, 1000, 1000], { sevenDeuceBB: 1 });
    t.after(() => stopTimers(game));
    svc.startHand('R');
    game.config.sevenDeuceBB = 5;    // 房主在这一手中间把倍数改成 5
    game.holeCards.u0 = [new Card('Clubs', '2'), new Card('Diamonds', '7')];
    foldAllBut(svc, game, 'u0');
    assert.equal(saved[0].sevenDeuce.bounty, 20, '这一手仍按开手时的 1BB');
});

// ───────── 规则（纯函数）─────────
function g(holes, chips, bounty = 40) {
    return {
        hand: { sevenDeuceBounty: bounty, seats: Object.keys(holes).map(userId => ({ userId })) },
        holeCards: holes,
        players: Object.keys(holes).map(userId => ({ userId, chips: chips[userId] }))
    };
}

test('7-2 才算（同花也算），7-3、2-2 都不算', () => {
    assert.equal(sd.isSevenDeuce([C('7', 'Hearts'), C('2', 'Hearts')]), true);
    assert.equal(sd.isSevenDeuce([C('2', 'Spades'), C('7', 'Clubs')]), true);
    assert.equal(sd.isSevenDeuce([C('7', 'Spades'), C('3', 'Clubs')]), false);
    assert.equal(sd.isSevenDeuce([C('2', 'Spades'), C('2', 'Clubs')]), false);
    assert.equal(sd.isSevenDeuce(null), false);
});

test('🔴 平分底池 / 各赢一份不给：只有「这一手只有他一个人赢到筹码」才算', () => {
    const holes = { a: [C('7', 'Hearts'), C('2', 'Spades')], b: [C('A', 'Hearts'), C('K', 'Spades')] };
    const game = g(holes, { a: 500, b: 500 });
    assert.equal(sd.settleSevenDeuce(game, { a: 100, b: 100 }), null, '平分');
    assert.equal(game.players[1].chips, 500, '一分钱没动');
    assert.equal(sd.settleSevenDeuce(g(holes, { a: 500, b: 500 }), { a: 0, b: 200 }), null, '赢的是别人');
    assert.ok(sd.settleSevenDeuce(g(holes, { a: 500, b: 500 }), { a: 200, b: 0 }), '他一个人赢');
});

test('付不起的付到 0 为止，已经输光的不用付', () => {
    const holes = { a: [C('7', 'Hearts'), C('2', 'Spades')], b: [C('A', 'Hearts'), C('K', 'Spades')], c: [C('Q', 'Hearts'), C('Q', 'Spades')] };
    const game = g(holes, { a: 900, b: 15, c: 0 });
    const r = sd.settleSevenDeuce(game, { a: 300 });
    assert.equal(r.total, 15);
    assert.deepEqual(r.payers, [{ userId: 'b', paid: 15 }]);
    assert.deepEqual(game.players.map(p => p.chips), [915, 0, 0]);
});

test('只有开手时发到牌的人付钱（中途坐下的不在这一手里）', () => {
    const holes = { a: [C('7', 'Hearts'), C('2', 'Spades')], b: [C('A', 'Hearts'), C('K', 'Spades')] };
    const game = g(holes, { a: 500, b: 500 });
    game.players.push({ userId: 'late', chips: 2000 });   // 这一手中途才坐下，不在 hand.seats 里
    const r = sd.settleSevenDeuce(game, { a: 100 });
    assert.equal(r.total, 40);
    assert.equal(game.players[2].chips, 2000);
});

test('🔴 结算挂在 saveHandHistory 里、而且在取结束筹码之前（所有收尾路径都汇到这里）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'src/games/poker/hand-history-service.js'), 'utf8');
    const i = src.indexOf('settleSevenDeuce(game, winShare)'), j = src.indexOf('game.hand.results = game.hand.seats.map');
    assert.ok(i > 0 && j > i, '先转账，再取结束筹码 —— 反过来牌谱就不守恒了');
    assert.equal(fs.readFileSync(path.join(__dirname, 'src/games/poker/hand-service.js'), 'utf8').includes('sevenDeuceBounty: bountyForHand(game, BB)'), true);
});
