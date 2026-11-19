'use strict';
// 🔴 2026-11-19 上线前安全测试抓到的两个经济漏洞（德州一直就有，奥马哈底池限注下更容易碰上）：
//   ① 房主在一手牌中间「强制站起」/「请出」对手 → 对手被判弃牌 → 底池归房主。
//      房主下注后把面对下注的人请走；或者全押亮牌后看到自己落后就把对手请走，牌都不用发完。
//   ② 全押亮牌之后（再没有人要做决定）跟注方离开房间 / 留座 / 站起 → 被判弃牌，白白丢掉底池。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSeatService } = require('./src/rooms/seat-service');

const PHASES = { WAITING: 'waiting', SHOWDOWN: 'showdown', PREFLOP: 'preflop', FLOP: 'flop', TURN: 'turn' };
const sent = [];
const io = {
    in() { return { emit() {} }; },
    to() { return { emit() {} }; },
    sockets: { adapter: { rooms: new Map() }, sockets: new Map([['sB', { emit: (ev, d) => sent.push([ev, d]) }]]) }
};
function seatSvc(roomGames, calls) {
    return createSeatService({
        io, db: {}, roomGames, lobbySockets: new Set(),
        config: { PHASES, BUYIN_RATE: 0.11, CASHOUT_RATE: 0.1, gameBB: () => 100, timeCardsFor: () => 0 },
        persistence: { commit() {} },
        hooks: {
            clampInt: (v) => v, broadcastState() {}, broadcastRoomList() {}, clearActionTimer() {}, afterAction: () => calls.push('afterAction'),
            isBettingRoundComplete: () => false, advanceStage: () => calls.push('advanceStage'), scheduleNextHand() {}, liveCount: () => 2,
            cashOut: () => 0, recordLeft() {}
        }
    });
}
const table = (extra = {}) => ({
    roomType: 'cash', phase: PHASES.FLOP, status: 'running', ownerUserId: 'A', buttonIdx: 0, actionOnIdx: 1, vacatedPlayers: [], config: {},
    players: [
        { userId: 'A', username: 'a', socketId: 'sA', chips: 1000, currentBet: 300, committed: 200, folded: false, allIn: false, hasActed: true },
        { userId: 'B', username: 'b', socketId: 'sB', chips: 5000, currentBet: 0, committed: 200, folded: false, allIn: false, hasActed: false },
    ],
    ...extra,
});

test('🔴 房主强制站起：对手正面对下注也不判弃牌，照常打完这一手，打完再离座', () => {
    const calls = [];
    const roomGames = { r: table() };
    seatSvc(roomGames, calls).standUpPlayer('r', 1, true);
    const B = roomGames.r.players[1];
    assert.equal(B.folded, false, '不许判弃牌（否则房主下注后把人请走就白拿底池）');
    assert.equal(B.vacateAfter, true, '这一手打完再离座');
    assert.equal(roomGames.r.actionOnIdx, 1, '还轮到他，他照常做决定');
    assert.deepEqual(calls, [], '不推进行动');
    assert.ok(sent.some(([ev, d]) => ev === 'server_msg' && d.k === 'seat.forcedOutAfterHand'), '告诉他：这一手打完再离座');
});

test('🔴 全押亮牌之后：自己站起也不判弃牌（已经没有决定要做了）', () => {
    const calls = [];
    const roomGames = { r: table({ allinRevealed: true, actionOnIdx: -1 }) };
    roomGames.r.players[0].allIn = true;
    seatSvc(roomGames, calls).standUpPlayer('r', 1, false);
    assert.equal(roomGames.r.players[1].folded, false);
    assert.equal(roomGames.r.players[1].vacateAfter, true);
});

test('自己在下注轮里站起：仍然是自己弃牌（这一条行为不变）', () => {
    const calls = [];
    const roomGames = { r: table() };
    seatSvc(roomGames, calls).standUpPlayer('r', 1, false);
    assert.equal(roomGames.r.players[1].folded, true);
    assert.deepEqual(calls, ['afterAction']);
});

test('🔴 请出房间：对方还在这一手里就先不让请；全押亮牌后离开 / 留座不判弃牌；观众不能看后续牌', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    const kick = read('src/socket/events/table-control-events.js');
    const kickAt = kick.indexOf("socket.on('kick_player'");
    const guardAt = kick.indexOf("k: 'host.kickAfterHand'", kickAt);
    const leaveAt = kick.indexOf('standUpPlayer(roomId, idx, true)', kickAt);
    assert.ok(guardAt > kickAt && guardAt < leaveAt, '还在手里的人：拒绝必须在真正请出之前');
    assert.match(kick, /if \(target && handLive && !target\.folded\) \{ socket\.emit\('server_msg', \{ k: 'host\.kickAfterHand' \}\); return; \}/);
    // 留座离座 / 退出房间：全押亮牌之后不算 midHand
    const mem = read('src/socket/events/membership-events.js');
    const mids = mem.match(/const midHand = [^;]+;/g) || [];
    assert.equal(mids.length, 2);
    for (const m of mids) assert.match(m, /!game\.allinRevealed/, m);
    // 看后续牌只给在座的人
    assert.match(read('src/socket/events/poker-card-events.js'), /if \(!game\.players\.some\(p => p\.userId === user\.id\)\) return;/);
});

test('补码的带入上限要算上本手投进底池的筹码（否则全押后补码能补到上限的近两倍）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'src/socket/events/table-control-events.js'), 'utf8');
    assert.match(src, /const inPot = p\.folded \? 0 : \(p\.currentBet \|\| 0\) \+ \(p\.committed \|\| 0\);/);
    assert.match(src, /const cap = maxB - p\.chips - inPot - \(p\.pendingRebuy \|\| 0\);/);
});
