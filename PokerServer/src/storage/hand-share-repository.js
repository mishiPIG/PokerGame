'use strict';
// 牌谱分享链接（2026-11-17）。表结构见 migrations/007-hand-shares.sql。
const crypto = require('crypto');

function createHandShareRepository(db) {
    const playedStmt = db.prepare('SELECT 1 FROM hand_players WHERE hand_id = ? AND user_id = ?');
    const existingStmt = db.prepare('SELECT token FROM hand_shares WHERE hand_id = ? AND user_id = ?');
    const insertStmt = db.prepare(`
        INSERT INTO hand_shares(token, hand_id, user_id, created_at_ms) VALUES (?, ?, ?, ?)
    `);
    const getStmt = db.prepare(`
        SELECT s.user_id, h.payload_json
        FROM hand_shares s
        JOIN hands h ON h.id = s.hand_id
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND u.deleted_at_ms IS NULL
    `);
    const viewStmt = db.prepare('UPDATE hand_shares SET views = views + 1 WHERE token = ?');
    const tokenExistsStmt = db.prepare('SELECT 1 FROM hand_shares WHERE token = ?');
    const signupStmt = db.prepare(`
        INSERT INTO share_signups(token, user_id, kind, created_at_ms) VALUES (?, ?, ?, ?)
    `);

    return {
        // 只有【打过这一手】的人能分享它。同一个人分享同一手牌，永远拿回同一个链接。
        // 返回 null = 不是这一手的玩家（或者这一手不存在 —— 刻意不区分，别让接口变成探测牌局是否存在的工具）。
        createShare(handId, userId, now = Date.now()) {
            if (!handId || !userId || !playedStmt.get(handId, userId)) return null;
            const found = existingStmt.get(handId, userId);
            if (found) return found.token;
            const token = crypto.randomBytes(12).toString('base64url');   // 16 个字符，猜不到
            insertStmt.run(token, handId, userId, now);
            return token;
        },
        // 分享人已经注销 → 链接失效（他的分享跟着人走）。
        getShared(token) {
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
            const row = getStmt.get(token);
            if (!row) return null;
            viewStmt.run(token);
            return { sharerUserId: row.user_id, hand: JSON.parse(row.payload_json) };
        },
        // 这个新号是从哪条分享链接进来的（表结构见 migrations/008-share-signups.sql）。
        // token 是客户端带上来的，必须是一条真实存在的分享，否则不记 —— 别让人随手往运营数字里灌水。
        // 返回是否记上了。只记统计，失败绝不连累建号（调用方 try/catch 也不必）。
        recordSignup(token, userId, kind, now = Date.now()) {
            try {
                if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return false;
                if (!userId || !['guest', 'register'].includes(kind) || !tokenExistsStmt.get(token)) return false;
                signupStmt.run(token, userId, kind, now);
                return true;
            } catch (e) { console.error('[share] 记录分享来源失败', e.message); return false; }
        },
    };
}

module.exports = { createHandShareRepository };
