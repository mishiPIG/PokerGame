'use strict';
// Bomb pot（2026-11-18，家庭局玩法）。改的是「一手怎么开始」，所以全用真引擎跑：
//   · 这一手不收盲注 / 前注 / straddle，每人放同样一笔，发完底牌直接到翻牌
//   · 筹码守恒；短码付不起就全押；人人都因 Bomb 全押时直接全押亮牌（不卡住）
//   · 一次性标记用完即清，下一手恢复正常盲注；每 N 手一次按手数算
//   · 统计：Bomb 那一手不算进 VPIP / PFR 的分母
const test = require('node:test');
const assert = require('node:assert/strict');
const { Deck, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');
const bomb = require('./src/games/poker/extensions/bomb-pot');

function makeTable(stacks, cfg = {}, { buttonSeat = null } = {}) {
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
        config: { sb: 10, bb: 20, ante: 5, maxPlayers: stacks.length, bombEvery: 0, bombBB: 2, ...cfg },
        deck: new Deck(), players: stacks.map((chips, i) => ({
            userId: 'u' + i, username: 'p' + i, seat: i, chips, buyIn: chips,
            currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false
        })),
        buttonSeat, handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0
    };
    roomGames.R = game;
    return { svc, game, saved, emitted };
}
// 引擎会挂好几种计时器（行动、跑马、多次发牌协商、下一手 straddle 邀请）：测试里都要自己拆，否则 node --test 一直等它们到期
const stop = (g) => { clearTimeout(g.actionTimer); clearTimeout(g.runoutTimer); clearTimeout(g.nextHandTimer); clearTimeout(g.runItTimer); if (g.straddleDecision) clearTimeout(g.straddleDecision.timer); };
const onTable = (g) => g.players.reduce((s, p) => s + p.chips + p.currentBet, 0) + g.pot;

test('🔴 Bomb 那一手：不收盲注和前注，每人 2BB 进底池，发完底牌直接到翻牌、从按钮左手第一位开始', (t) => {
    const { svc, game, emitted } = makeTable([1000, 1000, 1000], {}, { buttonSeat: 2 });
    t.after(() => stop(game));
    game.nextBomb = true;
    svc.startHand('R');
    assert.equal(game.phase, config.PHASES.FLOP, '直接到翻牌');
    assert.equal(game.communityCards.length, 3);
    assert.deepEqual(game.players.map(p => p.chips), [960, 960, 960], '每人只放了 40（2 × 大盲 20），没有盲注、没有前注 5');
    assert.equal(game.pot, 120);
    assert.equal(game.currentBet, 0, 'Bomb 不是下注：翻牌上从 0 开始');
    assert.equal(game.buttonSeat, 0, '开手时按钮从上一手的 2 号轮到 0 号');
    assert.equal(game.players[game.actionOnIdx].seat, 1, '翻牌先由按钮左手的 1 号行动');
    assert.equal(onTable(game), 3000, '筹码守恒');
    assert.deepEqual(game.hand.bomb, { amount: 40 });
    assert.equal(game.hand.ante, 0);
    assert.equal(game.sbUserId, null, '这一手没有大小盲，牌桌上不标 SB / BB');
    assert.equal(game.nextBomb, false, '一次性标记用完即清');
    assert.ok(emitted.some(([ev, d]) => ev === 'table_notice' && d.k === 'notice.bombPot' && d.p.amount === 40));
});

test('Bomb 之后下一手恢复正常盲注和前注', (t) => {
    const { svc, game } = makeTable([1000, 1000, 1000], {}, { buttonSeat: 2 });
    t.after(() => stop(game));
    game.nextBomb = true;
    svc.startHand('R');
    stop(game);
    // 结束这一手：除一人外都弃牌
    for (const p of game.players.slice(1)) { p.folded = true; p.hasActed = true; }
    svc.afterAction('R');
    stop(game);
    svc.startHand('R');
    assert.equal(game.phase, config.PHASES.PREFLOP, '回到正常的翻前');
    assert.equal(game.hand.bomb, null);
    assert.equal(game.hand.ante, 5);
    assert.ok(game.players.some(p => p.currentBet === 20), '大盲贴了 20');
});

test('短码付不起 Bomb 就全押；人人都因 Bomb 全押时直接全押亮牌，不卡住', (t) => {
    const a = makeTable([1000, 30, 1000], {}, { buttonSeat: 2 });
    t.after(() => stop(a.game));
    a.game.nextBomb = true;
    a.svc.startHand('R');
    assert.equal(a.game.players[1].allIn, true);
    assert.equal(a.game.players[1].chips, 0);
    assert.equal(a.game.pot, 40 + 30 + 40);
    assert.equal(onTable(a.game), 2030);

    const b = makeTable([30, 25], {}, { buttonSeat: 1 });
    t.after(() => stop(b.game));
    b.game.nextBomb = true;
    b.svc.startHand('R');
    assert.equal(b.game.allinRevealed, true, '两人都全押了：没有任何决定可做，直接亮牌跑马');
    assert.equal(b.game.actionOnIdx, -1);
    assert.equal(onTable(b.game), 55);
});

test('每 N 手一次：按手数算（重启后也一样准）；SNG 不适用', () => {
    const g = { roomType: 'cash', config: { bombEvery: 10 } };
    assert.equal(bomb.isBombHand(g, 10), true);
    assert.equal(bomb.isBombHand(g, 20), true);
    assert.equal(bomb.isBombHand(g, 11), false);
    assert.equal(bomb.isBombHand({ roomType: 'cash', config: { bombEvery: 0 } }, 10), false);
    assert.equal(bomb.isBombHand({ roomType: 'sng', config: { bombEvery: 10 }, nextBomb: true }, 10), false);
    assert.equal(bomb.isBombHand({ roomType: 'cash', config: { bombEvery: 7 } }, 7), false, '只认 5 / 10 / 20');
    assert.equal(bomb.bombAmount({ config: { bombBB: 5 } }, 20), 100);
    assert.equal(bomb.bombAmount({ config: { bombBB: 3 } }, 20), 40, '不认识的倍数回到 2BB');
});

test('🔴 Bomb 那一手没有 straddle：上一手答应 straddle 的人会被告知作废，钱不会被扣', (t) => {
    const { svc, game } = makeTable([1000, 1000, 1000, 1000], { allowUtgStraddle: true }, { buttonSeat: 3 });
    t.after(() => stop(game));
    game.nextBomb = true;
    game.straddleChain = [{ userId: 'u3', seat: 3, amount: 40, targetHandSeq: 1 }];
    svc.startHand('R');
    assert.equal(game.straddle, null);
    assert.deepEqual(game.straddles, []);
    assert.deepEqual(game.straddleChain, []);
    assert.deepEqual(game.players.map(p => p.chips), [960, 960, 960, 960], '只扣了 Bomb 那 40');
});

test('统计：Bomb 那一手不算进 VPIP / PFR 的分母（没有人自愿入池这回事）', () => {
    const statsSrc = require('fs').readFileSync(require('path').join(__dirname, 'stats.js'), 'utf8');
    assert.match(statsSrc, /if \(!h\.bomb\) \{\s*preHands\+\+;/);
    assert.match(statsSrc, /vpip: pct\(vpip, preHands\)/);
    assert.match(statsSrc, /pfr: pct\(pfr, preHands\)/);
});
