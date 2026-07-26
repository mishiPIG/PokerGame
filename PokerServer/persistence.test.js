'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Card, Deck } = require('./PokerLogic');
const { createDatabaseService } = require('./src/storage/database-service');
const { createGamePersistenceService } = require('./src/persistence/game-persistence-service');
const { createHandHistoryService } = require('./src/games/poker/hand-history-service');

function temporaryDatabase() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-recovery-'));
    return { dir, file: path.join(dir, 'pokerdojo.sqlite') };
}

function baseGame(ownerId, secondId) {
    const deck = new Deck();
    const ownerHole = [deck.drawCard(), deck.drawCard()];
    const secondHole = [deck.drawCard(), deck.drawCard()];
    return {
        deck,
        players: [
            {
                userId: ownerId, username: 'Owner', socketId: 'socket-owner', seat: 0,
                chips: 2000, currentBet: 20, committed: 0, buyIn: 2000, buyInGold: 220,
                folded: false, allIn: false, hasActed: false, ready: false
            },
            {
                userId: secondId, username: 'Second', socketId: 'socket-second', seat: 1,
                chips: 1980, currentBet: 40, committed: 0, buyIn: 2000, buyInGold: 220,
                folded: false, allIn: false, hasActed: false, ready: false
            }
        ],
        holeCards: { [ownerId]: ownerHole, [secondId]: secondHole },
        communityCards: [],
        authorized: new Set([ownerId, secondId]),
        shownCards: { [ownerId]: new Set([0]) },
        pot: 0,
        currentBet: 40,
        lastRaiseSize: 20,
        buttonIdx: 0,
        buttonSeat: 0,
        actionOnIdx: 0,
        actionDeadline: Date.now() + 30000,
        actionTotalMs: 30000,
        roomType: 'cash',
        status: 'running',
        ownerUserId: ownerId,
        ownerName: 'Owner',
        config: { name: '恢复测试', maxPlayers: 2, sb: 20, bb: 40, ante: 0, durationH: 2 },
        invite: { token: 'token', joinCode: '1234', entryLocked: false, version: 1 },
        phase: 'preflop',
        handSeq: 1,
        tournamentOver: false,
        statsHistory: [],
        vacatedPlayers: [],
        tableEndAt: Date.now() + 3600000
    };
}

test('active game snapshots survive a database close and restore runtime classes safely', () => {
    const temp = temporaryDatabase();
    let first;
    try {
        first = createDatabaseService({ databasePath: temp.file });
        const owner = first.createUser('RecoverOwner', 'hash');
        const second = first.createUser('RecoverSecond', 'hash');
        const runtime = { roomGames: {}, lobbySockets: new Set() };
        const persistence = createGamePersistenceService({ db: first, runtime, Deck, Card });
        const game = baseGame(owner.id, second.id);
        runtime.roomGames['123456'] = game;
        persistence.createMatch('123456', game);

        game.players[0].chips -= 100;
        game.players[0].currentBet += 100;
        game.currentBet = 120;
        game.actionOnIdx = 1;
        const economic = persistence.commitWithWallet('123456', [{
            userId: owner.id,
            delta: -220,
            type: 'cash_buyin',
            matchId: game.matchId,
            operationKey: `cash-buyin:${game.matchId}:${owner.id}`,
            metadata: { chips: 2000 }
        }], 'player_action', owner.id, { action: 'raise', amount: 120 });
        assert.equal(economic.wallets[0].balance, 9780);
        const savedVersion = game.stateVersion;
        first.close();
        first = null;

        const reopened = createDatabaseService({ databasePath: temp.file });
        try {
            const runtimeAfterRestart = { roomGames: {}, lobbySockets: new Set() };
            const recoveredPersistence = createGamePersistenceService({
                db: reopened,
                runtime: runtimeAfterRestart,
                Deck,
                Card
            });
            const recovered = recoveredPersistence.recoverAll();
            assert.equal(recovered.length, 1);
            const restored = runtimeAfterRestart.roomGames['123456'];
            assert.equal(restored.stateVersion, savedVersion);
            assert.equal(restored.currentBet, 120);
            assert.equal(restored.actionOnIdx, 1);
            assert.equal(restored.players[0].chips, 1900);
            assert.equal(restored.players[0].socketId, null);
            assert.equal(restored.players[0].away, true);
            assert.ok(restored.deck instanceof Deck);
            assert.ok(restored.deck.cards[0] instanceof Card);
            assert.ok(restored.holeCards[owner.id][0] instanceof Card);
            assert.ok(restored.authorized instanceof Set);
            assert.ok(restored.shownCards[owner.id] instanceof Set);

            const replay = recoveredPersistence.commitWithWallet('123456', [{
                userId: owner.id,
                delta: -220,
                type: 'cash_buyin',
                matchId: restored.matchId,
                operationKey: `cash-buyin:${restored.matchId}:${owner.id}`,
                metadata: { chips: 2000 }
            }], 'idempotency_replay', owner.id);
            assert.equal(replay.wallets[0].applied, false);
            assert.equal(reopened.getUserById(owner.id).gold, 9780);
        } finally {
            reopened.close();
        }
    } finally {
        if (first) first.close();
        fs.rmSync(temp.dir, { recursive: true, force: true });
    }
});

test('completed hand and final game snapshot commit atomically', () => {
    const db = createDatabaseService({ databasePath: ':memory:' });
    try {
        const owner = db.createUser('HandOwner', 'hash');
        const second = db.createUser('HandSecond', 'hash');
        const runtime = { roomGames: {}, lobbySockets: new Set() };
        const persistence = createGamePersistenceService({ db, runtime, Deck, Card });
        const game = baseGame(owner.id, second.id);
        runtime.roomGames['777777'] = game;
        persistence.createMatch('777777', game);
        game.hand = {
            ts: Date.now(),
            matchId: game.matchId,
            roomId: '777777',
            mode: 'cash',
            handSeq: 1,
            sb: 20,
            bb: 40,
            ante: 0,
            buttonUserId: owner.id,
            seats: game.players.map(player => ({
                userId: player.userId,
                username: player.username,
                seat: player.seat,
                startChips: 2000,
                hole: game.holeCards[player.userId].map(card => `${card.rank}${card.suit[0]}`)
            })),
            actions: [{ userId: owner.id, street: 'preflop', action: 'fold', amount: 20, thinkMs: 100 }]
        };
        const history = createHandHistoryService({ db, persistence, roomGames: runtime.roomGames });
        const completed = history.saveHandHistory(game, { [second.id]: 60 });
        game.players[1].chips += 60;
        game.pot = 0;
        game.phase = 'showdown';
        game.actionOnIdx = -1;
        history.commitHandHistory('777777', completed);

        assert.equal(db.raw.prepare('SELECT count(*) AS n FROM hands').get().n, 1);
        assert.equal(db.raw.prepare('SELECT count(*) AS n FROM hand_players').get().n, 2);
        assert.equal(db.raw.prepare('SELECT count(*) AS n FROM hand_actions').get().n, 1);
        const recoverable = db.matches.findRecoverable()[0];
        assert.equal(recoverable.snapshot.phase, 'showdown');
        assert.equal(recoverable.snapshot.pot, 0);
        assert.equal(recoverable.snapshot.players[1].chips, 2040);
    } finally {
        db.close();
    }
});
