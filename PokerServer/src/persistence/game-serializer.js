'use strict';

const TRANSIENT_KEYS = new Set([
    'actionTimer',
    'levelTimer',
    'tableTimer',
    'nextHandTimer',
    'runoutTimer',
    'runItTimer',
    'dissolveTimer',
    'emptyCleanupTimer',
    'reserveTimer',
    'timer'
]);

function serializeGame(game, stateVersion = game.stateVersion || 0) {
    const encoded = JSON.stringify(game, (key, value) => {
        if (TRANSIENT_KEYS.has(key)) return undefined;
        if (key === 'socketId') return null;
        if (value instanceof Set) return { __pokerType: 'Set', values: [...value] };
        if (key === 'deck' && value && Array.isArray(value.cards)) {
            return {
                __pokerType: 'Deck',
                cards: value.cards.map(card => ({ suit: card.suit, rank: card.rank })),
                lastShuffleId: value.lastShuffleId || null
            };
        }
        if (value && value.constructor?.name === 'Card') {
            return { __pokerType: 'Card', suit: value.suit, rank: value.rank };
        }
        return value;
    });
    const snapshot = JSON.parse(encoded);
    snapshot.formatVersion = 1;
    snapshot.stateVersion = stateVersion;
    return snapshot;
}

function playerStatus(player, vacated = false) {
    if (player.settledAt) return 'settled';
    if (player.eliminated) return 'eliminated';
    if (player.leaving || player.left) return 'left';
    if (vacated || player.standing) return 'vacated';
    if (player.reserved) return 'reserved';
    if (player.sittingOut) return 'sitting_out';
    return 'seated';
}

function economicParticipants(game) {
    const rows = [];
    const push = (player, vacated = false) => {
        if (!player?.userId || rows.some(row => row.userId === player.userId)) return;
        rows.push({
            userId: player.userId,
            username: player.username || player.userId,
            seat: player.seat ?? null,
            status: playerStatus(player, vacated),
            buyinGoldTotal: player.buyInGold || 0,
            buyinChipsTotal: player.buyIn || 0,
            currentChips: player.chips || 0,
            handsPlayed: player.handsPlayed || 0,
            settlementGold: player.settlementGold ?? null,
            settledAt: player.settledAt || null,
            joinedAt: player.joinedAt || game.createdAt || Date.now(),
            leftAt: player.leftAt || null
        });
    };
    (game.players || []).forEach(player => push(player, false));
    (game.vacatedPlayers || []).forEach(player => push(player, true));
    (game.statsHistory || []).forEach(player => push(player, true));
    return rows;
}

module.exports = { serializeGame, economicParticipants, TRANSIENT_KEYS };
