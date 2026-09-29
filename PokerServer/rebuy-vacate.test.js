'use strict';
// 🔴 2026-09-29 上线前最终验收的多房间压测抓到的：
//    现金桌「补码」在本手进行中买的筹码是【挂起】的（下一手才生效），钱已经扣了。
//    如果同一手里他又站起 / 留座离桌 / 被房主请到观战席 / 被请出，本手结束时：
//      removeBustedPlayers 先走 vacateAfter 分支就 continue 了 —— 挂起补码没生效；
//      vacateSeat 新建的观战条目只抄了 chips —— pendingRebuy 整个丢了；
//      结束结算 cashOut 只认 chips —— 这笔筹码永远兑不回来。
//    表现：带入+补码的筹码 ≠ 兑出的筹码（压测里正好差一笔 2000 的补码）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeatService } = require('./src/rooms/seat-service');
const { createCashMatchService } = require('./src/matches/cash-match-service');

const PHASES = { WAITING: 'waiting', SHOWDOWN: 'showdown', PREFLOP: 'preflop', FLOP: 'flop' };
const io = {
    in() { return { emit() {} }; },
    to() { return { emit() {} }; },
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
};

function seatSvc(roomGames) {
    return createSeatService({
        io, db: {}, roomGames, lobbySockets: new Set(),
        config: { PHASES, BUYIN_RATE: 0.11, CASHOUT_RATE: 0.1, gameBB: () => 100, timeCardsFor: () => 0 },
        persistence: { commit() {} },
        hooks: {
            clampInt: (v) => v, broadcastState() {}, broadcastRoomList() {}, clearActionTimer() {}, afterAction() {},
            isBettingRoundComplete: () => false, advanceStage() {}, scheduleNextHand() {}, liveCount: () => 2,
            cashOut: () => 0, recordLeft() {}
        }
    });
}

test('🔴 补码后同一手里站起：挂起的补码不能丢，要跟着进观战席', () => {
    const p = { userId: 'u1', username: 'a', chips: 3000, pendingRebuy: 2000, buyIn: 10000, vacateAfter: true, currentBet: 0 };
    const q = { userId: 'u2', username: 'b', chips: 9000, buyIn: 10000, currentBet: 0 };
    const roomGames = { r: { roomType: 'cash', phase: PHASES.SHOWDOWN, players: [p, q], vacatedPlayers: [], config: { minBuyIn: 2000 }, buttonIdx: 0, actionOnIdx: -1 } };
    seatSvc(roomGames).removeBustedPlayers(roomGames.r);
    const v = roomGames.r.vacatedPlayers.find(x => x.userId === 'u1');
    assert.ok(v, '他应该进了观战席');
    assert.equal(v.chips, 5000, '3000 + 挂起补码 2000 —— 补码是付过钱的');
    assert.ok(!(v.pendingRebuy > 0), '不能再留一个没人处理的挂起');
});

test('🔴 结束结算：兑出要算上还挂着的补码（任何路径漏掉都不能让钱蒸发）', () => {
    const paid = [];
    const roomGames = {
        r: {
            roomType: 'cash', phase: PHASES.SHOWDOWN, status: 'running', matchId: 'm1',
            players: [{ userId: 'u1', username: 'a', chips: 3000, pendingRebuy: 2000, buyIn: 12000 }],
            vacatedPlayers: [{ userId: 'u2', username: 'b', chips: 1000, pendingRebuy: 500, buyIn: 1500 }],
            config: { name: 't' }
        }
    };
    const svc = createCashMatchService({
        io, db: {}, roomGames, lobbySockets: new Set(),
        config: { CASHOUT_RATE: 0.1, PHASES, gameBB: () => 100, STRADDLE_INTERMISSION_MS: 5000 },
        persistence: {
            commit() {}, finish() {},
            commitWithWallet(roomId, entries) { paid.push(...entries); return { wallets: entries.map(() => ({ balance: 0 })) }; }
        },
        hooks: {
            buildRanking: () => [], sendMatchResult() {}, clearActionTimer() {}, clearStraddleDecision() {},
            showStraddleDecision() {}, broadcastState() {}, broadcastRoomList() {}, listRooms: () => [],
            removeBustedPlayers() {}, liveCount: () => 0, startHand() {}, dissolveNow() {}
        }
    });
    svc.endCashTable('r', 'test');
    const byUser = Object.fromEntries(paid.map(e => [e.userId, e]));
    assert.equal(byUser.u1.metadata.chips, 5000, '在座：3000 + 挂起 2000');
    assert.equal(byUser.u1.delta, 500, '按 0.1 兑出');
    assert.equal(byUser.u2.metadata.chips, 1500, '观战席：1000 + 挂起 500');
});
