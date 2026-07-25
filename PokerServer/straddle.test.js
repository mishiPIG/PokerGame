const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('./server');

function player(userId, seat, chips = 2000) {
    return { userId, seat, chips, currentBet: 0, committed: 0, sittingOut: false };
}

test('three-handed next positions rotate from the current button', () => {
    const game = {
        buttonSeat: 0,
        players: [player('a', 0), player('b', 1), player('c', 2)]
    };
    const pos = _test.projectedPositions(game);
    assert.equal(pos.buttonSeat, 1);
    assert.equal(pos.sb.userId, 'c');
    assert.equal(pos.bb.userId, 'a');
    assert.equal(pos.utg.userId, 'b');
});

test('position projection follows occupied seats and skips sitting-out players', () => {
    const out = player('out', 3);
    out.sittingOut = true;
    const game = {
        buttonSeat: 1,
        players: [player('a', 0), player('b', 1), out, player('c', 5), player('d', 8)]
    };
    const pos = _test.projectedPositions(game);
    assert.deepEqual(pos.ordered.map(p => p.userId), ['a', 'b', 'c', 'd']);
    assert.equal(pos.buttonSeat, 5);
    assert.equal(pos.sb.userId, 'd');
    assert.equal(pos.bb.userId, 'a');
    assert.equal(pos.utg.userId, 'b');
});

test('heads-up has no UTG straddle candidate', () => {
    const game = { buttonSeat: 0, players: [player('a', 0), player('b', 4)] };
    const pos = _test.projectedPositions(game);
    assert.equal(pos.utg, null);
});

test('safe decision window is fifteen seconds and intermission fallback fits before next hand', () => {
    assert.equal(_test.STRADDLE_DECISION_MS, 15000);
    assert.equal(_test.STRADDLE_INTERMISSION_MS, 4500);
    assert.ok(_test.STRADDLE_INTERMISSION_MS < 5000);
});
