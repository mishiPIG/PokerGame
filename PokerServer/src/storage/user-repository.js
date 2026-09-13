'use strict';

const crypto = require('crypto');

function parseCreatedAt(value) {
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function mapUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        displayNameChangedAtMs: row.display_name_changed_at_ms || null,
        email: row.email,
        password_hash: row.password_hash,
        gold: row.gold,
        isAdmin: !!row.is_admin,
        avatar: row.avatar,
        friendCode: row.friend_code || null,
        lastCheckin: row.last_checkin,
        checkinStreak: row.checkin_streak || 0,
        created_at: new Date(row.created_at_ms).toISOString()
    };
}


// ===== 牌友号（8 位随机数字，注册时发、永不可改）=====
// 随机而不是递增：递增号会暴露「你是第几个注册的」（等于公开用户规模），
// 还能顺着号去猜相邻账号。随机没有这两个问题。
// 8 位 = 9000 万个坑位，几万用户时撞号概率极低；真撞上就重试，别指望「不会撞」。
const CODE_MIN = 10000000, CODE_MAX = 99999999;
function newFriendCode(db) {
    const taken = db.prepare('SELECT 1 FROM users WHERE friend_code = ?');
    for (let i = 0; i < 50; i++) {
        const code = String(crypto.randomInt(CODE_MIN, CODE_MAX + 1));
        if (!taken.get(code)) return code;
    }
    // 50 次都撞说明号池真的快满了 —— 这时候宁可报错，也不能发一个重复号出去
    throw new Error('FRIEND_CODE_EXHAUSTED');
}

function createUserRepository(db) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at_ms IS NULL');
    const byUsername = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at_ms IS NULL');
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND deleted_at_ms IS NULL');
    const insertUser = db.prepare(`
        INSERT INTO users (
            id, username, display_name, email, password_hash, gold, is_admin, avatar,
            last_checkin, checkin_streak, created_at_ms, updated_at_ms, friend_code
        ) VALUES (
            @id, @username, @display_name, @email, @password_hash, @gold, @is_admin, @avatar,
            @last_checkin, @checkin_streak, @created_at_ms, @updated_at_ms, @friend_code
        )
    `);
    const insertInitial = db.prepare(`
        INSERT INTO wallet_transactions (
            id, user_id, delta, balance_before, balance_after, transaction_type,
            operation_key, metadata_json, created_at_ms
        ) VALUES (?, ?, ?, 0, ?, 'initial_balance', ?, ?, ?)
    `);

    const createUserTx = db.transaction((username, passwordHash, isAdmin, email, options = {}) => {
        const id = options.id || crypto.randomUUID();
        const now = options.createdAtMs || Date.now();
        const gold = Number.isInteger(options.gold) ? options.gold : 10000;
        const normalizedEmail = email ? email.toLowerCase() : null;
        insertUser.run({
            id,
            username,
            display_name: options.displayName || username,
            email: normalizedEmail,
            password_hash: passwordHash,
            gold,
            is_admin: isAdmin ? 1 : 0,
            avatar: options.avatar || null,
            last_checkin: options.lastCheckin || null,
            checkin_streak: options.checkinStreak || 0,
            created_at_ms: now,
            updated_at_ms: now,
            friend_code: options.friendCode || newFriendCode(db)
        });
        insertInitial.run(
            crypto.randomUUID(),
            id,
            gold,
            gold,
            options.initialOperationKey || `initial:${id}`,
            JSON.stringify(options.initialMetadata || {}),
            now
        );
        return mapUser(byId.get(id));
    });

    return {
        createUser(username, passwordHash, isAdmin = false, email = null, options = {}) {
            try {
                return createUserTx(username, passwordHash, isAdmin, email, options);
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    if (email && byEmail.get(email)) throw new Error('EMAIL constraint failed');
                    throw new Error('UNIQUE constraint failed');
                }
                throw error;
            }
        },
        // 存量用户补发牌友号。迁移只加了列，补发放在这里做 —— 随机撞号要重试，SQL 不好写。
        // 幂等：只补 NULL 的那些，重复调用无副作用。
        backfillFriendCodes() {
            const rows = db.prepare('SELECT id FROM users WHERE friend_code IS NULL').all();
            if (!rows.length) return 0;
            const upd = db.prepare('UPDATE users SET friend_code = ? WHERE id = ?');
            const tx = db.transaction(list => { for (const r of list) upd.run(newFriendCode(db), r.id); });
            tx(rows);
            console.log(`[db] 已为 ${rows.length} 个存量用户补发牌友号`);
            return rows.length;
        },
        // 搜索加好友：只认【精确匹配】牌友号或用户名。
        // ⚠️ 刻意不做模糊/前缀搜索 —— 那等于让任何人把整个用户库枚举出来。
        findByCodeOrName(q) {
            const s = String(q || '').trim();
            if (!s) return null;
            if (/^\d{6,10}$/.test(s)) {
                return mapUser(db.prepare(
                    'SELECT * FROM users WHERE friend_code = ? AND deleted_at_ms IS NULL').get(s));
            }
            return mapUser(db.prepare(
                'SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at_ms IS NULL').get(s));
        },
        getUserById(id) {
            return mapUser(byId.get(id));
        },
        getUserByUsername(username) {
            if (!username) return null;
            return mapUser(byUsername.get(username));
        },
        getUserByEmail(email) {
            if (!email) return null;
            return mapUser(byEmail.get(email));
        },
        setPassword(id, passwordHash) {
            db.prepare('UPDATE users SET password_hash = ?, updated_at_ms = ? WHERE id = ?')
                .run(passwordHash, Date.now(), id);
        },
        setEmail(id, email) {
            try {
                db.prepare('UPDATE users SET email = ?, updated_at_ms = ? WHERE id = ?')
                    .run(email ? email.toLowerCase() : null, Date.now(), id);
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('EMAIL constraint failed');
                throw error;
            }
        },
        setAvatar(id, avatar) {
            db.prepare('UPDATE users SET avatar = ?, updated_at_ms = ? WHERE id = ?')
                .run(avatar || null, Date.now(), id);
        },
        setDisplayName(id, displayName, changedAtMs = Date.now()) {
            db.prepare('UPDATE users SET display_name = ?, display_name_changed_at_ms = ?, updated_at_ms = ? WHERE id = ?')
                .run(displayName, changedAtMs, changedAtMs, id);
            return this.getUserById(id);
        },
        setAdmin(id, isAdmin) {
            db.prepare('UPDATE users SET is_admin = ?, updated_at_ms = ? WHERE id = ?')
                .run(isAdmin ? 1 : 0, Date.now(), id);
        },
        getAllUsers() {
            return db.prepare(`
                SELECT id, username, gold, is_admin
                FROM users
                WHERE deleted_at_ms IS NULL
                ORDER BY created_at_ms
            `).all().map(row => ({
                id: row.id,
                username: row.username,
                gold: row.gold,
                isAdmin: !!row.is_admin
            }));
        },
        importUser(user) {
            return this.createUser(user.username, user.password_hash, !!user.isAdmin, user.email || null, {
                id: user.id,
                gold: Number.isInteger(user.gold) ? user.gold : 0,
                displayName: user.displayName || user.username,
                avatar: user.avatar || null,
                lastCheckin: user.lastCheckin || null,
                checkinStreak: user.checkinStreak || 0,
                createdAtMs: parseCreatedAt(user.created_at),
                initialOperationKey: `legacy-initial:${user.id}`,
                initialMetadata: { source: 'data.json' }
            });
        }
    };
}

module.exports = { createUserRepository, mapUser, parseCreatedAt };
