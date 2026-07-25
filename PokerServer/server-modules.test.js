const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = __dirname;

test('server entry stays an assembly module', () => {
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(source.split('\n').length < 150);
    assert.match(source, /createTableService/);
    assert.match(source, /registerSocketHandlers/);
    assert.doesNotMatch(source, /socket\.on\(/);
    assert.doesNotMatch(source, /app\.post\('\/api\/voice/);
});

test('server module boundaries exist', () => {
    [
        'src/config.js',
        'src/runtime.js',
        'src/auth.js',
        'src/http/register-admin-routes.js',
        'src/http/register-auth-routes.js',
        'src/http/register-account-routes.js',
        'src/voice/voice-module.js',
        'src/table/table-service.js',
        'src/socket/register-socket-handlers.js'
    ].forEach(relative => assert.ok(fs.existsSync(path.join(root, relative)), relative));
});

test('second-stage facades stay small and domain modules exist', () => {
    const table = fs.readFileSync(path.join(root, 'src/table/table-service.js'), 'utf8');
    const socket = fs.readFileSync(path.join(root, 'src/socket/register-socket-handlers.js'), 'utf8');
    assert.ok(table.split('\n').length < 120);
    assert.ok(socket.split('\n').length < 100);
    [
        'src/games/poker/poker-rules.js',
        'src/games/poker/poker-service.js',
        'src/games/poker/pot-service.js',
        'src/games/poker/state-presenter.js',
        'src/games/poker/hand-service.js',
        'src/games/poker/showdown-service.js',
        'src/games/poker/hand-history-service.js',
        'src/games/poker/extensions/straddle/straddle-service.js',
        'src/games/poker/extensions/run-it/run-it-service.js',
        'src/matches/cash-match-service.js',
        'src/matches/sng-match-service.js',
        'src/matches/match-result-service.js',
        'src/rooms/lobby-service.js',
        'src/rooms/membership-service.js',
        'src/rooms/room-lifecycle.js',
        'src/rooms/seat-service.js',
        'src/socket/events/room-events.js',
        'src/socket/events/poker-action-events.js'
    ].forEach(relative => assert.ok(fs.existsSync(path.join(root, relative)), relative));
});

test('seat service receives its buy-in clamp dependency explicitly', () => {
    const { createSeatService } = require('./src/rooms/seat-service');
    const roomGames = {
        room1: {
            roomType: 'cash', phase: 'waiting', players: [], buttonIdx: 0,
            config: { maxPlayers: 2, minBuyIn: 100, maxBuyIn: 500 }
        }
    };
    const emitted = [];
    const socket = { id: 'socket1', playRoom: 'room1', join() {}, emit(event, payload) { emitted.push([event, payload]); }, to() { return { emit() {} }; } };
    const db = {
        getUserById() { return { gold: 1000, avatar: null }; },
        setGold() {}
    };
    const seatService = createSeatService({
        io: { in() { return { emit() {} }; }, to() { return { emit() {} }; }, sockets: { sockets: new Map() } },
        db, roomGames, lobbySockets: new Set(),
        config: { PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' }, BUYIN_RATE: 0.1, CASHOUT_RATE: 0.1, gameBB() { return 20; }, timeCardsFor() { return 1; } },
        hooks: { clampInt(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; }, broadcastState() {}, broadcastRoomList() {}, clearActionTimer() {}, afterAction() {}, isBettingRoundComplete() { return false; }, advanceStage() {}, scheduleNextHand() {}, liveCount() { return 0; }, cashOut() { return 0; }, recordLeft() {} }
    });
    assert.equal(seatService.seatPlayer('room1', socket, { id: 'user1', username: 'U' }, 1, 0), true);
    assert.equal(roomGames.room1.players[0].chips, 100);
    assert.ok(emitted.some(([event]) => event === 'gold_update'));
});

test('lobby service creates a cryptographically random room invite', () => {
    const { createLobbyService } = require('./src/rooms/lobby-service');
    const service = createLobbyService({
        io: {},
        runtime: {
            roomGames: {},
            lobbySockets: new Set(),
            inviteCodeFailuresByUser: new Map(),
            inviteCodeFailuresByIp: new Map()
        },
        config: {
            PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' },
            CONFIGURED_PUBLIC_ORIGIN: ''
        }
    });

    const invite = service.createRoomInvite();
    assert.match(invite.token, /^[A-Za-z0-9_-]{22}$/);
    assert.match(invite.joinCode, /^\d{4}$/);
    assert.equal(invite.entryLocked, false);
    assert.equal(invite.version, 1);
});
