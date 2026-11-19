'use strict';
// 🔴 2026-11-19 历史 bug 回放抓到的：全押亮牌到翻牌之间那 ~1.4 秒里服务器崩了，重启后这手永远卡住、筹码锁死（三种玩法都会）。
//    原因：亮牌时先广播（存快照）、后记「什么时候发下一张」，快照里没有这个时刻，恢复时谁都不推进。
//    另一个隐患：这个时刻原来从不清，正常下注轮里重启的话，残留的旧时刻会让它提前发下一条街。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPokerService } = require('./src/games/poker/poker-service');
const { Deck, HandEvaluator } = require('./PokerLogic');
const config = require('./src/config');
const equity = require('./equity');
const fs = require('fs');
const path = require('path');

function svcWith(game) {
    const roomGames = { R: game }, noop = () => {};
    const sink = { emit() {} };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const svc = createPokerService({ io, db: { raw: { transaction: (f) => f }, appendHand: noop, matches: { markRecoveryNeeded: noop } }, equity, Deck, HandEvaluator, config, runtime: { roomGames },
        hooks: { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop }, persistence: { commit: noop } });
    return svc;
}
const base = (extra) => ({ roomType: 'cash', status: 'running', matchId: 'm', config: { sb: 10, bb: 20 }, deck: new Deck(), players: [], holeCards: {}, communityCards: [], pot: 0, ...extra });

test('🔴 快照里没有「下一张什么时候发」：只要正在等全押跑马，恢复后照样接着发', () => {
    const game = base({ phase: 'preflop', allinRevealed: true, actionOnIdx: -1 });
    svcWith(game).restoreRunoutTimer('R');
    try { assert.ok(game.runoutTimer, '应当重新挂上跑马计时器'); } finally { clearTimeout(game.runoutTimer); }
});

test('🔴 正常下注轮里重启：残留的旧时刻不许触发发牌', () => {
    const game = base({ phase: 'flop', allinRevealed: false, actionOnIdx: 1, runoutDeadline: Date.now() - 60000 });
    svcWith(game).restoreRunoutTimer('R');
    assert.equal(game.runoutTimer, undefined);
});

test('全押亮牌和每发一条街：先记时刻再广播（广播会存快照）；新一手清掉旧时刻', () => {
    const src = fs.readFileSync(path.join(__dirname, 'src/games/poker/hand-service.js'), 'utf8');
    const reveal = src.indexOf("io.in(roomId).emit('allin_reveal'");
    assert.ok(src.indexOf('game.runoutDeadline = Date.now() + RUNOUT_DELAY;', reveal) < src.indexOf('broadcastState(roomId);', reveal));
    assert.match(src, /game\.runoutDeadline = null;/);
});
