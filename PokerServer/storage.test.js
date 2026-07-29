'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabaseService } = require('./src/storage/database-service');
const { importLegacy } = require('./src/storage/legacy-import');
const { displayNameChangeAllowed, normalizeDisplayName } = require('./src/account/display-name');

function withDatabase(fn) {
    const service = createDatabaseService({ databasePath: ':memory:' });
    try {
        return fn(service);
    } finally {
        service.close();
    }
}

test('users preserve the compatibility shape and enforce case-insensitive uniqueness', () => {
    withDatabase(db => {
        const user = db.createUser('Alice', 'hash', true, 'Alice@Example.com');
        assert.equal(user.username, 'Alice');
        assert.equal(user.email, 'alice@example.com');
        assert.equal(user.gold, 10000);
        assert.equal(user.isAdmin, true);
        assert.equal(user.displayName, 'Alice');
        const renamed = db.setDisplayName(user.id, 'Alice P', 123);
        assert.equal(renamed.displayName, 'Alice P');
        assert.equal(renamed.displayNameChangedAtMs, 123);
        assert.equal(db.getUserByUsername('ALICE').id, user.id);
        assert.equal(db.getUserByEmail('ALICE@EXAMPLE.COM').id, user.id);
        assert.throws(() => db.createUser('alice', 'hash2'), /UNIQUE/);
        assert.throws(() => db.createUser('Bob', 'hash2', false, 'ALICE@example.com'), /EMAIL/);
    });
});

test('display names are normalized, constrained, and use a 24-hour cooldown', () => {
    assert.equal(normalizeDisplayName('  小 明  '), '小 明');
    assert.equal(normalizeDisplayName('Player-01'), 'Player-01');
    assert.equal(normalizeDisplayName('A'), null);
    assert.equal(normalizeDisplayName('系统'), null);
    assert.equal(normalizeDisplayName('名字😀'), null);
    assert.equal(displayNameChangeAllowed({ displayNameChangedAtMs: 1_000 }, 1_000 + 86_400_000), true);
    assert.equal(displayNameChangeAllowed({ displayNameChangedAtMs: 1_000 }, 1_000 + 86_399_999), false);
});

test('wallet changes are atomic, auditable and idempotent', () => {
    withDatabase(db => {
        const user = db.createUser('Wallet', 'hash');
        const first = db.wallet.adjust({
            userId: user.id,
            delta: -110,
            type: 'cash_buyin',
            operationKey: 'buyin:one'
        });
        const replay = db.wallet.adjust({
            userId: user.id,
            delta: -110,
            type: 'cash_buyin',
            operationKey: 'buyin:one'
        });
        assert.equal(first.applied, true);
        assert.equal(replay.applied, false);
        assert.equal(replay.balance, 9890);
        assert.equal(db.getUserById(user.id).gold, 9890);
        assert.equal(db.wallet.getTransactions(user.id).length, 2);
        assert.throws(() => db.wallet.adjust({
            userId: user.id,
            delta: -10000,
            type: 'cash_buyin',
            operationKey: 'buyin:too-much'
        }), /INSUFFICIENT_GOLD/);
        assert.equal(db.getUserById(user.id).gold, 9890);
    });
});

test('check-in reward and duplicate protection share one transaction', () => {
    withDatabase(db => {
        const user = db.createUser('Checkin', 'hash');
        assert.equal(db.applyCheckin(user.id, '2026-07-26', 1, 200), 10200);
        assert.throws(() => db.applyCheckin(user.id, '2026-07-26', 1, 200));
        const fresh = db.getUserById(user.id);
        assert.equal(fresh.gold, 10200);
        assert.equal(fresh.lastCheckin, '2026-07-26');
        assert.equal(fresh.checkinStreak, 1);
    });
});

test('messages, feedback and hand history keep current API response shapes', () => {
    withDatabase(db => {
        const user = db.createUser('History', 'hash');
        db.addMessage(user.id, { type: 'result', text: '完成', ts: 100 });
        assert.deepEqual(db.getMessages(user.id)[0], {
            id: db.getMessages(user.id)[0].id,
            type: 'result',
            text: '完成',
            ts: 100,
            read: false
        });
        db.markMessagesRead(user.id);
        assert.equal(db.getMessages(user.id)[0].read, true);

        db.appendFeedback({ ts: 200, userId: user.id, username: user.username, text: '建议', contact: 'x', ua: 'test' });
        assert.equal(db.getFeedback(10)[0].text, '建议');

        const hand = {
            ts: 300,
            completedAt: 400,
            roomId: '123456',
            mode: 'cash',
            handSeq: 1,
            sb: 10,
            bb: 20,
            ante: 0,
            buttonUserId: user.id,
            seats: [{ userId: user.id, username: user.username, seat: 0, startChips: 2000, hole: ['AS', 'KH'] }],
            actions: [{ userId: user.id, street: 'preflop', action: 'fold', amount: 0, thinkMs: 50 }],
            community: [],
            results: [{ userId: user.id, won: 0, endChips: 1990 }]
        };
        assert.equal(db.appendHand(hand).inserted, true);
        assert.equal(db.appendHand(hand).inserted, false);
        assert.deepEqual(db.getHandsForUser(user.id, { limit: 10 }), [hand]);
    });
});

test('match snapshots use optimistic versions and are recoverable', () => {
    withDatabase(db => {
        const owner = db.createUser('Owner', 'hash');
        const created = db.matches.create({
            roomCode: '654321',
            roomType: 'cash',
            ownerUserId: owner.id,
            name: '恢复测试',
            config: { bb: 20 },
            invite: { joinCode: '1234' },
            phase: 'waiting',
            snapshot: { formatVersion: 1, roomId: '654321', phase: 'waiting' }
        });
        const committed = db.matches.commitState({
            matchId: created.id,
            expectedVersion: 1,
            status: 'running',
            config: { bb: 20 },
            invite: { joinCode: '1234' },
            phase: 'preflop',
            handSeq: 1,
            eventType: 'hand_started',
            snapshot: { formatVersion: 1, roomId: '654321', phase: 'preflop' }
        });
        assert.equal(committed.stateVersion, 2);
        assert.equal(db.matches.findRecoverable()[0].snapshot.phase, 'preflop');
        assert.throws(() => db.matches.commitState({
            matchId: created.id,
            expectedVersion: 1,
            status: 'running',
            config: {},
            phase: 'flop',
            snapshot: {}
        }), /STALE_MATCH_VERSION/);
    });
});

test('legacy import is complete and idempotent', () => {
    withDatabase(db => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-sqlite-import-'));
        const dataPath = path.join(dir, 'data.json');
        const handsPath = path.join(dir, 'hands.jsonl');
        const feedbackPath = path.join(dir, 'feedback.jsonl');
        const user = {
            id: 'legacy-user',
            username: 'Legacy',
            password_hash: 'hash',
            gold: 4321,
            isAdmin: false,
            created_at: '2026-01-01T00:00:00.000Z',
            messages: [{ id: 'legacy-message', ts: 1, read: false, type: 'result', text: '旧消息' }]
        };
        fs.writeFileSync(dataPath, JSON.stringify({ users: { [user.id]: user } }));
        fs.writeFileSync(handsPath, `${JSON.stringify({
            ts: 2,
            roomId: '111111',
            mode: 'sng',
            handSeq: 1,
            sb: 10,
            bb: 20,
            seats: [{ userId: user.id, username: user.username, seat: 0, startChips: 1000, hole: ['AS', 'AH'] }],
            actions: [],
            community: [],
            results: [{ userId: user.id, won: 30, endChips: 1010 }]
        })}\n`);
        fs.writeFileSync(feedbackPath, `${JSON.stringify({
            ts: 3, userId: user.id, username: user.username, text: '旧反馈'
        })}\n`);
        const first = importLegacy(db, { data: dataPath, hands: handsPath, feedback: feedbackPath });
        const second = importLegacy(db, { data: dataPath, hands: handsPath, feedback: feedbackPath });
        assert.equal(first.users.rows, 1);
        assert.equal(second.users.alreadyImported, true);
        assert.equal(db.getUserById(user.id).gold, 4321);
        assert.equal(db.getMessages(user.id).length, 1);
        assert.equal(db.getHandsForUser(user.id, {}).length, 1);
        assert.equal(db.getFeedback(10).length, 1);
        assert.equal(db.integrityCheck(), 'ok');
        assert.deepEqual(db.foreignKeyCheck(), []);
    });
});
