'use strict';

function hydrateGame(snapshot, { Deck, Card }) {
    const decoded = JSON.parse(JSON.stringify(snapshot), (key, value) => {
        if (!value || typeof value !== 'object') return value;
        if (value.__pokerType === 'Set') return new Set(value.values || []);
        if (value.__pokerType === 'Card') return new Card(value.suit, value.rank);
        if (value.__pokerType === 'Deck') {
            const deck = new Deck();
            deck.cards = (value.cards || []).map(card => new Card(card.suit, card.rank));
            deck.lastShuffleId = value.lastShuffleId || null;
            return deck;
        }
        return value;
    });
    delete decoded.formatVersion;
    decoded.players = (decoded.players || []).map(player => ({
        ...player,
        socketId: null,
        away: true,
        reserveTimer: null
    }));
    decoded.vacatedPlayers = (decoded.vacatedPlayers || []).map(player => ({
        ...player,
        socketId: null,
        away: true,
        reserveTimer: null
    }));
    return decoded;
}

module.exports = { hydrateGame };
