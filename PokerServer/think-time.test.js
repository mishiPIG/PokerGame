'use strict';
// 房主可选的思考时间（2026-11-17，玩家视角复盘 P6）。用真引擎开一手，看计时器真的按这一桌的设置走。
const test = require('node:test');
const assert = require('node:assert/strict');
const { Deck, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');

function table(actionTimeSec) {
    const roomGames = {};
    const sink = { emit() {} };
    // 房里有人连着（否则会走「房里没人 → 1.5 秒快速代打」那条路）
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map([['R', new Set(['s1'])]]) }, sockets: new Map() } };
    const noop = () => {};
    const db = { raw: { transaction: (fn) => fn }, appendHand: noop, matches: { markRecoveryNeeded: noop } };
    const hooks = { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop };
    const svc = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime: { roomGames }, hooks, persistence: { commit: noop } });
    const cfg = { sb: 10, bb: 20, ante: 0, maxPlayers: 3 };
    if (actionTimeSec !== undefined) cfg.actionTimeSec = actionTimeSec;
    const game = {
        roomType: 'cash', status: 'running', phase: config.PHASES.WAITING, matchId: 'm1', config: cfg,
        deck: new Deck(), handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0, buttonSeat: null,
        players: [0, 1, 2].map(i => ({ userId: 'u' + i, username: 'p' + i, seat: i, chips: 1000, buyIn: 1000,
            currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false })),
    };
    roomGames.R = game;
    return { svc, game };
}

test('这一桌设了 30 秒，轮到谁就给谁 30 秒', (t) => {
    const { svc, game } = table(30);
    t.after(() => clearTimeout(game.actionTimer));
    svc.startHand('R');
    assert.ok(game.actionOnIdx >= 0);
    assert.equal(game.actionTotalMs, 30000);
});

test('没设（老房间的快照）照旧 18 秒；乱填的值也按 18 秒', (t) => {
    for (const v of [undefined, 7, '999', 'abc']) {
        const { svc, game } = table(v);
        t.after(() => clearTimeout(game.actionTimer));
        svc.startHand('R');
        assert.equal(game.actionTotalMs, 18000, String(v));
    }
});

test('只收 15 / 18 / 20 / 30', () => {
    assert.deepEqual(config.ACTION_TIME_CHOICES, [15, 18, 20, 30]);
    assert.equal(config.pickActionTimeSec('20'), 20);
    assert.equal(config.pickActionTimeSec(60), 18);
    assert.equal(config.pickActionTimeSec(null), 18);
});
