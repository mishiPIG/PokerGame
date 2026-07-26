'use strict';

const path = require('path');
const crypto = require('crypto');
const { openSqlite } = require('./sqlite');
const { createUserRepository } = require('./user-repository');
const { createWalletRepository } = require('./wallet-repository');
const { createContentRepository } = require('./content-repository');
const { createMatchRepository } = require('./match-repository');

function defaultDatabasePath(baseDir) {
    return process.env.POKER_DB_PATH || path.join(baseDir, '.local', 'pokerdojo.sqlite');
}

function createDatabaseService({
    databasePath,
    baseDir = path.resolve(__dirname, '../..'),
    allowCreate = process.env.NODE_ENV !== 'production' || process.env.POKER_ALLOW_CREATE_DB === '1'
} = {}) {
    const db = openSqlite(databasePath || defaultDatabasePath(baseDir), { allowCreate });
    const users = createUserRepository(db);
    const wallet = createWalletRepository(db);
    const content = createContentRepository(db);
    const matches = createMatchRepository(db);

    const checkinTx = db.transaction((id, dateStr, streak, reward) => {
        const user = db.prepare('SELECT gold FROM users WHERE id = ?').get(id);
        if (!user) return null;
        db.prepare(`
            INSERT INTO daily_checkins(user_id, checkin_date, streak, reward, created_at_ms)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, dateStr, streak, reward, Date.now());
        const result = wallet.adjust({
            userId: id,
            delta: reward,
            type: 'checkin_reward',
            operationKey: `checkin:${id}:${dateStr}`,
            metadata: { streak, date: dateStr }
        });
        db.prepare(`
            UPDATE users
            SET last_checkin = ?, checkin_streak = ?, updated_at_ms = ?
            WHERE id = ?
        `).run(dateStr, streak, Date.now(), id);
        return result.balance;
    });

    return {
        ...users,
        ...content,
        wallet,
        matches,
        applyCheckin(id, dateStr, streak, reward) {
            try {
                return checkinTx(id, dateStr, streak, reward);
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new Error('ALREADY_CHECKED_IN');
                throw error;
            }
        },
        setGold(id, gold, metadata = {}) {
            return wallet.setBalance({
                userId: id,
                gold,
                operationKey: metadata.operationKey || `legacy-set-gold:${id}:${crypto.randomUUID()}`,
                metadata
            }).balance;
        },
        close() {
            db.close();
        },
        integrityCheck() {
            return db.pragma('integrity_check', { simple: true });
        },
        foreignKeyCheck() {
            return db.pragma('foreign_key_check');
        },
        raw: db
    };
}

module.exports = { createDatabaseService, defaultDatabasePath };
