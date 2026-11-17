'use strict';
const { safeAvatar } = require('../account/avatar');

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
        avatar: safeAvatar(row.avatar),   // 读出时也过白名单：库里的脏头像不必改库就失效
        friendCode: row.friend_code || null,
        isGuest: !!row.is_guest,
        upgradedAtMs: row.upgraded_at_ms || null,
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

// ===== 游客账号（2026-11-17）=====
// 游客就是 users 表里 is_guest=1 的一行。它没有邮箱、没有能用的密码，
// 用户名是随机的 guest_xxxxxxxxxx（玩家看到的是显示名，不是它）。
const GUEST_PASSWORD = 'guest-account';          // 不是任何 bcrypt 哈希，永远比不中；登录接口另外还会显式拒绝游客
const GUEST_NAME_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const guestUsername = () => 'guest_' + Array.from({ length: 10 },
    () => GUEST_NAME_CHARS[crypto.randomInt(GUEST_NAME_CHARS.length)]).join('');
// 日界线 UTC+8：和 metrics-repository.js 一致（显式写死，不跟服务器时区走）
const dayOfUtc8 = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 清理时「这个游客什么都没留下」的判据：下面任何一张表里有他的行，就不删。
// 🔴 不删的理由各不相同，但结论一样：
//    hand_players / match_players / matches —— 牌局是同桌几个人共同的记录，删了他别人的牌谱就缺一块；
//    wallet_transactions（开户那笔以外）—— 有过买入 / 兑出，流水是审计的证据链；
//    friendships / feedback / daily_checkins —— 游客本来做不了这些，真出现了说明他转正过又出了别的事，别碰。
const GUEST_TRACES = [
    'SELECT 1 FROM hand_players WHERE user_id = u.id',
    'SELECT 1 FROM match_players WHERE user_id = u.id',
    'SELECT 1 FROM matches WHERE owner_user_id = u.id',
    "SELECT 1 FROM wallet_transactions WHERE user_id = u.id AND transaction_type != 'initial_balance'",
    'SELECT 1 FROM friendships WHERE user_id = u.id OR friend_id = u.id',
    'SELECT 1 FROM feedback WHERE user_id = u.id',
    'SELECT 1 FROM daily_checkins WHERE user_id = u.id',
];

function createUserRepository(db) {
    const byId = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at_ms IS NULL');
    const byUsername = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at_ms IS NULL');
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND deleted_at_ms IS NULL');
    const insertUser = db.prepare(`
        INSERT INTO users (
            id, username, display_name, email, password_hash, gold, is_admin, avatar,
            last_checkin, checkin_streak, created_at_ms, updated_at_ms, friend_code, is_guest
        ) VALUES (
            @id, @username, @display_name, @email, @password_hash, @gold, @is_admin, @avatar,
            @last_checkin, @checkin_streak, @created_at_ms, @updated_at_ms, @friend_code, @is_guest
        )
    `);
    const insertInitial = db.prepare(`
        INSERT INTO wallet_transactions (
            id, user_id, delta, balance_before, balance_after, transaction_type,
            operation_key, metadata_json, created_at_ms
        ) VALUES (?, ?, ?, 0, ?, 'initial_balance', ?, ?, ?)
    `);

    const bumpCounter = db.prepare(`
        INSERT INTO daily_counters(day, key, n) VALUES (?, ?, 1)
        ON CONFLICT(day, key) DO UPDATE SET n = n + 1
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
            friend_code: options.friendCode || newFriendCode(db),
            is_guest: options.isGuest ? 1 : 0
        });
        if (options.isGuest) bumpCounter.run(dayOfUtc8(now), 'guest_created');
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
        // 建一个游客号。displayName 由调用方先用 normalizeDisplayName 校验过。
        // 用户名随机，撞了就换一个再试（31^10 个坑位，基本撞不上；真连撞 5 次就报错，不硬发）。
        createGuest(displayName, options = {}) {
            for (let i = 0; i < 5; i++) {
                try {
                    return createUserTx(guestUsername(), GUEST_PASSWORD, false, null,
                        { ...options, displayName, isGuest: true });
                } catch (error) {
                    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
                }
            }
            throw new Error('GUEST_USERNAME_EXHAUSTED');
        },
        // 游客「保存账号」：在【同一行】上补用户名 / 邮箱 / 密码，去掉游客标记。id 不变。
        //
        // 🔴 `AND is_guest = 1` 是这条语句里最要紧的一个条件：没有它，任何一个【正式账号】
        //    只要登录令牌被人拿到，就能用这个接口直接改掉用户名、邮箱、密码 —— 等于一个不用输旧密码的
        //    改密后门（改绑邮箱必须输当前密码，就是为了堵同一件事）。
        //    返回 null = 这个号不是游客（或已经转正过 / 不存在），调用方必须当失败处理。
        // 一条 UPDATE 本身是原子的：要么四个字段一起变，要么（撞唯一索引）一个都不变，没有中间状态。
        upgradeGuest(id, { username, email, passwordHash }, now = Date.now()) {
            let info;
            try {
                info = db.prepare(`
                    UPDATE users
                       SET username = ?, email = ?, password_hash = ?, is_guest = 0,
                           upgraded_at_ms = ?, updated_at_ms = ?
                     WHERE id = ? AND is_guest = 1 AND deleted_at_ms IS NULL
                `).run(username, email ? email.toLowerCase() : null, passwordHash, now, now, id);
            } catch (error) {
                if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    if (email && byEmail.get(email)) throw new Error('EMAIL constraint failed');
                    throw new Error('UNIQUE constraint failed');
                }
                throw error;
            }
            return info.changes === 1 ? mapUser(byId.get(id)) : null;
        },
        // 清掉「来了一下、什么都没留下」的游客：建号超过 olderThanMs、且 GUEST_TRACES 里一条都不占。
        // 打过牌的游客【不删】（牌谱是数据资产），和正式账号一样留着。
        //
        // skip：此刻在线 / 还在某张牌桌上的人。筹码只存在内存里，这时候把号删了，
        //       下一次落库就是外键错误 —— 所以调用方必须把这些 id 传进来。
        // 整行删除而不是打 deleted_at 标记：这些行没有任何别人依赖的东西，留着只会让用户表越来越大
        // （游客号谁都能建）。逐个开事务：万一哪一个删不掉（外键），只跳过它，不连累这一批。
        purgeStaleGuests({ olderThanMs = 7 * 86400000, now = Date.now(), skip = new Set(), limit = 500 } = {}) {
            const rows = db.prepare(`
                SELECT u.id FROM users u
                 WHERE u.is_guest = 1 AND u.deleted_at_ms IS NULL AND u.created_at_ms < @cutoff
                   ${GUEST_TRACES.map(q => `AND NOT EXISTS (${q})`).join(' ')}
                 LIMIT @limit
            `).all({ cutoff: now - olderThanMs, limit });
            const drop = db.transaction((id) => {
                // 再确认一次还是游客：从选出来到真删之间，他可能刚好点了「保存账号」
                if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND is_guest = 1').get(id)) return false;
                db.prepare('DELETE FROM user_messages WHERE user_id = ?').run(id);
                db.prepare('DELETE FROM login_events WHERE user_id = ?').run(id);
                db.prepare('DELETE FROM wallet_transactions WHERE user_id = ?').run(id);
                db.prepare('DELETE FROM users WHERE id = ?').run(id);
                return true;
            });
            let purged = 0;
            for (const { id } of rows) {
                if (skip.has(id)) continue;
                try { if (drop(id)) purged++; }
                catch (error) { console.error('[guest] 清理失败，跳过 user=' + id, error.message); }
            }
            return purged;
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
                SELECT id, username, gold, is_admin, is_guest
                FROM users
                WHERE deleted_at_ms IS NULL
                ORDER BY created_at_ms
            `).all().map(row => ({
                id: row.id,
                username: row.username,
                gold: row.gold,
                isAdmin: !!row.is_admin,
                isGuest: !!row.is_guest
            }));
        }
    };
}

module.exports = { createUserRepository, mapUser, parseCreatedAt };
