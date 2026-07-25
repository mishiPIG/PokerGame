'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSquidService } = require('./src/games/poker/extensions/squid/squid-service');

function fixture(overrides = {}) {
    const events = [];
    const histories = [];
    const audits = [];
    const scheduled = [];
    const roomGames = {};
    const io = {
        in(roomId) {
            return { emit(event, data) { events.push({ roomId, event, data }); } };
        },
        to(socketId) {
            return { emit(event, data) { events.push({ socketId, event, data }); } };
        }
    };
    const service = createSquidService({
        io,
        roomGames,
        db: { appendSquidRound(record) { audits.push(record); } },
        config: {
            SQUID_PENALTY_BB_MIN: 1,
            SQUID_PENALTY_BB_MAX: 10,
            SQUID_PENALTY_BB_DEFAULT: 1,
            SQUID_CLAIM_WINDOW_MS: 100000,
            PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' },
            gameBB() { return 10; }
        },
        hooks: {
            broadcastState() {},
            scheduleNextHand(roomId) { scheduled.push(roomId); },
            saveHandHistory(game, winShare) {
                histories.push({ hand: game.hand, winShare });
                game.hand = null;
            }
        }
    });
    const game = {
        roomType: 'cash',
        phase: 'waiting',
        handSeq: 7,
        config: { squid: { enabled: true, penaltyBB: 1 } },
        players: [
            { userId: 'a', username: 'A', socketId: 'sa', seat: 0, chips: 100, buyIn: 100 },
            { userId: 'b', username: 'B', socketId: 'sb', seat: 1, chips: 100, buyIn: 100 }
        ],
        holeCards: {
            a: [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: 'K' }]
        },
        ...overrides
    };
    roomGames.realRoom = game;
    return { service, game, events, histories, audits, scheduled };
}

test('Squid resolves the room key, retries pending funding, and does not double-count rebuy', () => {
    const f = fixture();
    f.game.players[0].chips = 5;
    f.service.startRoundIfNeeded(f.game);
    assert.equal(f.game.squid.lifecycle, 'pending_funding');

    f.game.players[0].pendingRebuy = 20;
    f.game.players[0].buyIn = 120; // chargeRebuy already recorded it
    f.service.startRoundIfNeeded(f.game);

    assert.equal(f.game.roomId, 'realRoom');
    assert.equal(f.game.squid.lifecycle, 'active');
    assert.equal(f.game.squid.round.roundId, 'realRoom:1');
    assert.equal(f.game.players[0].buyIn, 120);
    assert.equal(f.game.players[0].pendingRebuy, 0);
    assert.ok(f.events.every(event => event.roomId === undefined || event.roomId === 'realRoom'));
    f.service.clearClaimTimer(f.game);
});

test('Squid publishes claim handSeq and saves history only after claim resolution', () => {
    const f = fixture();
    f.service.startRoundIfNeeded(f.game);
    f.game.hand = { id: 'hand-7' };
    const outcome = {
        handSeq: 7,
        totalPotAwarded: 40,
        awards: { a: 40 },
        parts: [{ type: 'main', amount: 40, winners: [{ userId: 'a', amount: 40 }] }],
        endedByFold: true
    };

    assert.equal(f.service.onHandSettled(f.game, outcome, { a: 40 }), true);
    assert.equal(f.service.publicState(f.game).claim.handSeq, 7);
    assert.equal(f.histories.length, 0);
    assert.deepEqual(f.service.claimToken(f.game, 'a', 7), { ok: true });
    const awardEvent = f.events.find(event => event.event === 'squid_token_awarded');
    assert.equal(awardEvent.data.username, 'A');
    assert.equal(f.histories.length, 1);
    assert.deepEqual(f.histories[0].winShare, { a: 40 });
    assert.equal(f.histories[0].hand.squid.tokenAwardedTo, 'a');
    assert.deepEqual(f.service.claimToken(f.game, 'a', 0), { ok: false, reason: 'wrong_hand' });
    f.service.clearClaimTimer(f.game);
});

test('Squid does not offer a claim after automatic showdown', () => {
    const f = fixture();
    f.service.startRoundIfNeeded(f.game);
    const outcome = {
        handSeq: 7,
        totalPotAwarded: 40,
        awards: { a: 40 },
        parts: [{ type: 'main', amount: 40, winners: [{ userId: 'a', amount: 40 }] }],
        endedByFold: false
    };

    assert.equal(f.service.onHandSettled(f.game, outcome, { a: 40 }), false);
    assert.equal(f.service.publicState(f.game).claim, undefined);
    assert.equal(f.events.some(event => event.event === 'squid_token_awarded'), false);
    f.service.clearClaimTimer(f.game);
});

test('Squid stop request persists after settlement and round numbers remain monotonic', () => {
    const f = fixture();
    f.service.startRoundIfNeeded(f.game);
    assert.equal(f.game.squid.round.roundNo, 1);

    f.service.requestConfigChange(f.game, 'owner', { enabled: false });
    const round = f.game.squid.round;
    round.participants[0].tokens = 2;
    round.awardedTokens = 2;
    round.remainingTokens = 0;
    f.service.settleRound(f.game);

    const settledEvent = f.events.find(event => event.event === 'squid_round_settled');
    assert.deepEqual(settledEvent.data.participants.map(p => p.net), [20, -20]);
    assert.equal(settledEvent.data.participants.reduce((sum, p) => sum + p.net, 0), 0);
    assert.equal(f.game.config.squid.enabled, false);
    assert.equal(f.game.squid.lifecycle, 'idle');
    f.game.config.squid.enabled = true;
    f.game.squid.lifecycle = 'pending_start';
    f.service.startRoundIfNeeded(f.game);
    assert.equal(f.game.squid.round.roundNo, 2);
    assert.equal(f.game.squid.round.roundId, 'realRoom:2');
    f.service.clearClaimTimer(f.game);
});

test('Squid automatically stops after the configured number of rounds', () => {
    const f = fixture();
    f.service.requestConfigChange(f.game, 'owner', { enabled: true, penaltyBB: 2, rounds: 1 });
    f.service.startRoundIfNeeded(f.game);
    assert.equal(f.service.publicState(f.game).targetRounds, 1);

    const round = f.game.squid.round;
    round.participants[0].tokens = 2;
    round.awardedTokens = 2;
    round.remainingTokens = 0;
    f.service.settleRound(f.game);

    assert.equal(f.game.squid.completedRounds, 1);
    assert.equal(f.game.squid.lifecycle, 'idle');
    assert.equal(f.game.config.squid.enabled, false);
    assert.ok(f.events.some(event => event.event === 'server_msg'
        && String(event.data).includes('已完成设定的 1 轮')));
});
