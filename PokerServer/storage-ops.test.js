'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createDatabaseService } = require('./src/storage/database-service');
const { importLegacy } = require('./src/storage/legacy-import');

const root = __dirname;

function temporaryDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'poker-storage-ops-'));
}

test('production refuses to create a missing database implicitly', () => {
    const dir = temporaryDirectory();
    try {
        assert.throws(() => createDatabaseService({
            databasePath: path.join(dir, 'missing.sqlite'),
            allowCreate: false
        }), /DATABASE_NOT_FOUND/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('online backup is consistent and legacy export can be imported again', () => {
    const dir = temporaryDirectory();
    const source = path.join(dir, 'source.sqlite');
    const backup = path.join(dir, 'backups', 'snapshot.sqlite');
    const exported = path.join(dir, 'exported');
    const reimported = path.join(dir, 'reimported.sqlite');
    let db;
    try {
        db = createDatabaseService({ databasePath: source, allowCreate: true });
        const user = db.createUser('OpsUser', 'hash', false, 'ops@example.test');
        db.addMessage(user.id, { id: 'm1', ts: 10, read: false, type: 'result', text: '测试消息' });
        db.appendHand({
            ts: 20, roomId: '100001', mode: 'cash', handSeq: 1, sb: 10, bb: 20,
            seats: [{ userId: user.id, username: user.username, seat: 0, startChips: 1000, hole: ['AS', 'AH'] }],
            actions: [], community: [], results: [{ userId: user.id, won: 20, endChips: 1010 }]
        });
        db.appendFeedback({ id: 'f1', ts: 30, userId: user.id, username: user.username, text: '测试反馈' });

        execFileSync(process.execPath, ['scripts/backup-sqlite.js', source, backup], { cwd: root });
        execFileSync(process.execPath, [
            'scripts/export-sqlite-to-legacy.js', '--database', backup, '--output', exported
        ], { cwd: root });

        const backupDb = createDatabaseService({ databasePath: backup, allowCreate: false });
        try {
            assert.equal(backupDb.integrityCheck(), 'ok');
            assert.equal(backupDb.getUserById(user.id).username, 'OpsUser');
        } finally {
            backupDb.close();
        }

        const importedDb = createDatabaseService({ databasePath: reimported, allowCreate: true });
        try {
            importLegacy(importedDb, {
                data: path.join(exported, 'data.json'),
                hands: path.join(exported, 'hands.jsonl'),
                feedback: path.join(exported, 'feedback.jsonl')
            });
            assert.equal(importedDb.getUserById(user.id).email, 'ops@example.test');
            assert.equal(importedDb.getMessages(user.id)[0].text, '测试消息');
            assert.equal(importedDb.getHandsForUser(user.id, {}).length, 1);
            assert.equal(importedDb.getFeedback(10)[0].text, '测试反馈');
        } finally {
            importedDb.close();
        }

        const verify = spawnSync(process.execPath, ['scripts/verify-sqlite.js', backup], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(verify.status, 0, verify.stderr);
    } finally {
        if (db) db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
