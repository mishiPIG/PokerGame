'use strict';

const path = require('path');
const crypto = require('crypto');
const { openSqlite } = require('./sqlite');
const { createUserRepository } = require('./user-repository');
const { createWalletRepository } = require('./wallet-repository');
const { createContentRepository } = require('./content-repository');
const { createMatchRepository } = require('./match-repository');
const { createFriendRepository } = require('./friend-repository');

function defaultDatabasePath(baseDir) {
    return process.env.POKER_DB_PATH || path.join(baseDir, '.local', 'pokerdojo.sqlite');
}

function createDatabaseService({
    databasePath,
    baseDir = path.resolve(__dirname, '../..'),
    allowCreate = process.env.NODE_ENV !== 'production' || process.env.POKER_ALLOW_CREATE_DB === '1'
} = {}) {
    // 把解析后的实际路径向外暴露一份。
    // 路径来自 POKER_DB_PATH，且【刻意在代码目录之外】（部署的 tar 不覆盖数据）——
    // 所以凡是「要跟数据放在一起、不能被部署冲掉」的东西，都得问它要这个目录，
    // 而不是自己再拼一遍（拼错了就写进代码目录，下次部署静默丢掉）。
    // 现在的用处：崩溃现场标记 crash-report.json。
    const resolvedPath = databasePath || defaultDatabasePath(baseDir);
    const db = openSqlite(resolvedPath, { allowCreate });
    const users = createUserRepository(db);
    const wallet = createWalletRepository(db);
    const content = createContentRepository(db);
    const matches = createMatchRepository(db);
    const friends = createFriendRepository(db);
    users.backfillFriendCodes();   // 存量用户补发牌友号（幂等，没的才发）

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
        databasePath: resolvedPath,
        ...users,
        ...content,
        wallet,
        matches,
        friends,
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
