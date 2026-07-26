'use strict';

const { serializeGame, economicParticipants } = require('./game-serializer');
const { hydrateGame } = require('./game-hydrator');

function createGamePersistenceService({ db, runtime, Deck, Card }) {
    const { roomGames } = runtime;

    function createMatch(roomId, game) {
        if (game.matchId) return game.matchId;
        game.createdAt = game.createdAt || Date.now();
        const snapshot = serializeGame(game, 1);
        const created = db.matches.create({
            roomCode: roomId,
            roomType: game.roomType,
            ownerUserId: game.ownerUserId,
            name: game.config?.name || roomId,
            config: game.config || {},
            invite: game.invite || null,
            status: game.status || 'waiting',
            startedAt: game.status === 'running' ? (game.levelStartTime || game.createdAt) : null,
            scheduledEndAt: game.tableEndAt || null,
            handSeq: game.handSeq || 0,
            phase: game.phase || 'waiting',
            snapshot
        });
        game.matchId = created.id;
        game.stateVersion = created.stateVersion;
        return created.id;
    }

    function commit(roomId, eventType = 'state_committed', userId = null, eventPayload = {}) {
        const game = roomGames[roomId];
        if (!game || game._restoring || game.tournamentOver && game._persistenceFinished) return null;
        if (!game.matchId) createMatch(roomId, game);
        const expectedVersion = game.stateVersion || 1;
        const nextVersion = expectedVersion + 1;
        const snapshot = serializeGame(game, nextVersion);
        const result = db.matches.commitState({
            matchId: game.matchId,
            expectedVersion,
            status: game.status || 'waiting',
            config: game.config || {},
            invite: game.invite || null,
            startedAt: game.status === 'running' ? (game.levelStartTime || game.createdAt || Date.now()) : null,
            scheduledEndAt: game.tableEndAt || null,
            endedAt: game.tournamentOver ? Date.now() : null,
            handSeq: game.handSeq || 0,
            phase: game.phase || 'waiting',
            snapshot,
            players: economicParticipants(game),
            eventType,
            userId,
            eventPayload
        });
        game.stateVersion = result.stateVersion;
        return result;
    }

    function commitWithWallet(roomId, walletChanges, eventType, userId = null, eventPayload = {}, extraParticipants = []) {
        let matchResult;
        let walletResults;
        db.raw.transaction(() => {
            walletResults = walletChanges.map(change => db.wallet.adjust(change));
            matchResult = commit(roomId, eventType, userId, eventPayload);
            for (const participant of extraParticipants) {
                db.matches.upsertPlayer({ ...participant, matchId: roomGames[roomId].matchId });
            }
        })();
        return { match: matchResult, wallets: walletResults };
    }

    function finish(roomId, status = 'finished') {
        const game = roomGames[roomId];
        if (!game?.matchId || game._persistenceFinished) return;
        commit(roomId, 'match_finished', null, { status });
        db.matches.finish(game.matchId, status);
        game._persistenceFinished = true;
    }

    function recoverAll() {
        const recovered = [];
        for (const row of db.matches.findRecoverable()) {
            try {
                if (row.snapshot?.formatVersion !== 1) throw new Error(`UNSUPPORTED_SNAPSHOT_VERSION:${row.snapshot?.formatVersion}`);
                const game = hydrateGame(row.snapshot, { Deck, Card });
                game.matchId = row.id;
                game.stateVersion = row.state_version;
                game._restoring = false;
                roomGames[String(row.room_code)] = game;
                recovered.push({ roomId: String(row.room_code), game });
                console.log(`[recovery] matchId=${row.id} room=${row.room_code} version=${row.state_version} result=restored`);
            } catch (error) {
                db.matches.markRecoveryNeeded(row.id, error);
                console.error(`[recovery] matchId=${row.id} room=${row.room_code} result=failed`, error.message);
            }
        }
        return recovered;
    }

    return { createMatch, commit, commitWithWallet, finish, recoverAll };
}

module.exports = { createGamePersistenceService };
