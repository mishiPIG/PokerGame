'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCashMatchService } = require('./src/matches/cash-match-service');

function fixture(overrides = {}) {
    const emitted = [];
    const roomGames = {
        room1: {
            roomType: 'cash', phase: 'showdown', status: 'running', players: [], vacatedPlayers: [],
            config: { durationH: 1 }, tableEndAt: Date.now() + 60000, ...overrides
        }
    };
    const io = {
        in() { return { emit(event, payload) { emitted.push([event, payload]); } }; },
        sockets: { adapter: { rooms: new Map() }, sockets: new Map() }
    };
    let broadcasts = 0;
    const service = createCashMatchService({
        io, db: {}, roomGames, lobbySockets: new Set(),
        config: {
            CASHOUT_RATE: 0.1, PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' },
            gameBB() { return 20; }, STRADDLE_INTERMISSION_MS: 5000
        },
        persistence: { commit() {}, finish() {} },
        hooks: {
            buildRanking() { return []; }, sendMatchResult() {}, clearActionTimer() {}, clearStraddleDecision() {},
            showStraddleDecision() {}, broadcastState() { broadcasts += 1; }, broadcastRoomList() {}, listRooms() { return []; },
            removeBustedPlayers() {}, liveCount() { return 0; }, startHand() {}, dissolveNow() {}
        }
    });
    return { game: roomGames.room1, roomGames, service, emitted, broadcasts: () => broadcasts };
}

test('cash table time-up pauses new hands without settling or deleting the room', () => {
    const { game, service, emitted, broadcasts } = fixture();
    service.onTableTimeUp('room1');
    assert.equal(game.timeExpired, true);
    assert.equal(game.tournamentOver, undefined);
    assert.equal(broadcasts(), 1);
    assert.ok(emitted.some(([event]) => event === 'match_time_expired'));
});

test('adjusting a cash-table end can shorten to pause or extend to resume the timer', t => {
    const { game, service } = fixture();
    const immediate = service.adjustTableEnd('room1', Date.now());
    assert.equal(immediate.timeExpired, true);
    assert.equal(game.tableTimer, null);

    const future = service.adjustTableEnd('room1', Date.now() + 60000);
    assert.equal(future.timeExpired, false);
    assert.equal(game.timeExpired, false);
    assert.ok(game.tableTimer);
    t.after(() => clearTimeout(game.tableTimer));
});

test('the intermission after time-up keeps the room and does not start another hand', () => {
    const { game, roomGames, service, broadcasts } = fixture({ timeExpired: true });
    const nativeSetTimeout = global.setTimeout;
    let nextHand;
    global.setTimeout = callback => { nextHand = callback; return { fake: true }; };
    try {
        service.scheduleNextHand('room1');
    } finally {
        global.setTimeout = nativeSetTimeout;
    }
    assert.equal(typeof nextHand, 'function');
    nextHand();
    assert.equal(roomGames.room1, game);
    assert.equal(game.tournamentOver, undefined);
    assert.equal(broadcasts(), 1);
});
