'use strict';
// 现金桌「到时暂停」的 5 分钟兜底：
// 房主一旦掉线/关 App，桌子会永远停着、玩家筹码锁在房间里换不回金币
// （空房清理只管【没人】的房间，有人坐着的暂停房不会被清）。所以必须有这个兜底。
// 这里用 node:test 的假时钟把 5 分钟直接快进过去。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCashMatchService } = require('./src/matches/cash-match-service');

const PHASES = { WAITING: 'waiting', SHOWDOWN: 'showdown', FLOP: 'flop' };

function fixture(overrides = {}) {
    const emitted = [];
    const roomGames = {
        room1: {
            roomType: 'cash', phase: 'showdown', status: 'running',
            players: [], vacatedPlayers: [], config: { name: '训练赛', durationH: 1 },
            tableEndAt: Date.now() + 60000, matchId: 'm1', ...overrides
        }
    };
    const io = {
        in() { return { emit(ev, p) { emitted.push([ev, p]); } }; },
        to() { return { emit() {} }; },
        sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
    };
    const svc = createCashMatchService({
        io, db: {}, roomGames, lobbySockets: new Set(),
        config: { CASHOUT_RATE: 0.1, PHASES, gameBB: () => 20, STRADDLE_INTERMISSION_MS: 5000 },
        persistence: { commit() {}, finish() {} },
        hooks: {
            buildRanking: () => [], sendMatchResult() {}, clearActionTimer() {}, clearStraddleDecision() {},
            showStraddleDecision() {}, broadcastState() {}, broadcastRoomList() {}, listRooms: () => [],
            removeBustedPlayers() {}, liveCount: () => 0, startHand() {}, dissolveNow() {}
        }
    });
    return { svc, roomGames, emitted };
}

test('到时暂停后无人处理 → 5 分钟自动结算收桌', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { svc, roomGames } = fixture();
    svc.onTableTimeUp('room1');
    assert.equal(roomGames.room1.timeExpired, true, '应进入到时暂停状态');
    assert.ok(roomGames.room1.timeUpGraceAt, '应启动兜底计时');
    // 还没到 5 分钟：房间必须还在（不能提前收桌）
    t.mock.timers.tick(4 * 60 * 1000);
    assert.ok(roomGames.room1, '4 分钟时不该结算');
    // 过了 5 分钟：自动结算，房间被删
    t.mock.timers.tick(2 * 60 * 1000);
    assert.equal(roomGames.room1, undefined, '5 分钟后应自动结算收桌');
});

test('房主加时 → 撤销兜底，不再自动结算', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { svc, roomGames } = fixture();
    svc.onTableTimeUp('room1');
    svc.extendTable('room1', 30 * 60 * 1000);          // 房主 +30 分钟
    assert.equal(roomGames.room1.timeExpired, false, '加时后应恢复正常');
    assert.equal(roomGames.room1.timeUpGraceAt, null, '兜底应被撤销');
    t.mock.timers.tick(10 * 60 * 1000);
    assert.ok(roomGames.room1, '加时后不该被兜底收桌');
});

test('兜底触发时若还在牌里 → 不打断，本手结束后再结算', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { svc, roomGames } = fixture();
    svc.onTableTimeUp('room1');
    roomGames.room1.phase = PHASES.FLOP;                // 兜底到点时正好在牌里
    t.mock.timers.tick(6 * 60 * 1000);
    assert.ok(roomGames.room1, '不能把正在进行的手牌直接掐掉');
    assert.equal(roomGames.room1.pendingEnd, true, '应挂起「本手结束后结算」');
});

test('重启恢复 → 接着原来的剩余兜底时间，不白送一个完整 5 分钟', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { svc, roomGames } = fixture();
    svc.onTableTimeUp('room1');
    t.mock.timers.tick(4 * 60 * 1000);                  // 已经过了 4 分钟
    const graceAt = roomGames.room1.timeUpGraceAt;
    svc.restoreTableTimer('room1');                     // 模拟重启后恢复
    assert.equal(roomGames.room1.timeUpGraceAt, graceAt, '兜底截止时间应保持不变');
    t.mock.timers.tick(90 * 1000);                      // 再过 1.5 分钟 → 越过原截止
    assert.equal(roomGames.room1, undefined, '应在原定截止时收桌，而不是重新计时');
});
