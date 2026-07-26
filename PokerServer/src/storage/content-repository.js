'use strict';

const crypto = require('crypto');

function stableLegacyMatchId(record) {
    const raw = `${record.roomId || 'unknown'}:${record.mode || 'cash'}:${record.ts || 0}`;
    return `legacy-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function stableHandId(record, matchId) {
    if (record.id) return record.id;
    const raw = `${matchId}:${record.handSeq || 0}:${record.ts || 0}`;
    return `hand-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

function createContentRepository(db) {
    const addMessageStmt = db.prepare(`
        INSERT INTO user_messages(id, user_id, message_type, text, is_read, created_at_ms)
        VALUES (@id, @user_id, @message_type, @text, @is_read, @created_at_ms)
    `);
    const trimMessages = db.prepare(`
        DELETE FROM user_messages
        WHERE user_id = ?
          AND id NOT IN (
              SELECT id FROM user_messages
              WHERE user_id = ?
              ORDER BY created_at_ms DESC
              LIMIT 100
          )
    `);
    const addMessageTx = db.transaction((userId, msg) => {
        const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) return null;
        const row = {
            id: msg.id || crypto.randomUUID(),
            user_id: userId,
            message_type: msg.type || 'info',
            text: String(msg.text || ''),
            is_read: msg.read ? 1 : 0,
            created_at_ms: msg.ts || Date.now()
        };
        addMessageStmt.run(row);
        trimMessages.run(userId, userId);
        return row.id;
    });

    const insertFeedback = db.prepare(`
        INSERT INTO feedback(id, user_id, username, text, contact, user_agent, status, created_at_ms)
        VALUES (@id, @user_id, @username, @text, @contact, @user_agent, @status, @created_at_ms)
    `);

    const insertHand = db.prepare(`
        INSERT OR IGNORE INTO hands (
            id, match_id, room_code, hand_seq, mode, started_at_ms, completed_at_ms,
            sb, bb, ante, button_user_id, community_json, payload_json
        ) VALUES (
            @id, @match_id, @room_code, @hand_seq, @mode, @started_at_ms, @completed_at_ms,
            @sb, @bb, @ante, @button_user_id, @community_json, @payload_json
        )
    `);
    const insertHandPlayer = db.prepare(`
        INSERT OR IGNORE INTO hand_players (
            hand_id, user_id, username_snapshot, seat, start_chips, end_chips, won, hole_json
        ) VALUES (
            @hand_id, @user_id, @username_snapshot, @seat, @start_chips, @end_chips, @won, @hole_json
        )
    `);
    const insertAction = db.prepare(`
        INSERT OR IGNORE INTO hand_actions (
            hand_id, action_seq, user_id, street, action, amount, think_ms
        ) VALUES (
            @hand_id, @action_seq, @user_id, @street, @action, @amount, @think_ms
        )
    `);
    const ensureLegacyMatchStmt = db.prepare(`
        INSERT OR IGNORE INTO matches (
            id, room_code, room_type, status, owner_user_id, name, config_json,
            state_version, started_at_ms, ended_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'finished', ?, ?, '{}', 0, ?, ?, ?, ?)
    `);

    const saveHandTx = db.transaction(record => {
        const firstSeat = (record.seats || [])[0];
        if (!firstSeat) throw new Error('HAND_WITHOUT_PLAYERS');
        const matchId = record.matchId || stableLegacyMatchId(record);
        const now = Date.now();
        if (!record.matchId) {
            ensureLegacyMatchStmt.run(
                matchId,
                String(record.roomId || 'legacy'),
                record.mode === 'sng' ? 'sng' : 'cash',
                firstSeat.userId,
                `Legacy ${record.roomId || ''}`.trim(),
                record.ts || now,
                record.completedAt || now,
                record.ts || now,
                now
            );
        }
        const handId = stableHandId(record, matchId);
        const resultByUser = new Map((record.results || []).map(r => [r.userId, r]));
        const inserted = insertHand.run({
            id: handId,
            match_id: matchId,
            room_code: String(record.roomId || ''),
            hand_seq: Number.isInteger(record.handSeq) ? record.handSeq : 0,
            mode: record.mode === 'sng' ? 'sng' : 'cash',
            started_at_ms: record.ts || now,
            completed_at_ms: record.completedAt || now,
            sb: record.sb || 0,
            bb: record.bb || 0,
            ante: record.ante || 0,
            button_user_id: record.buttonUserId || null,
            community_json: JSON.stringify(record.community || []),
            payload_json: JSON.stringify(record)
        });
        if (!inserted.changes) return { handId, inserted: false };
        for (const seat of record.seats || []) {
            const result = resultByUser.get(seat.userId) || {};
            insertHandPlayer.run({
                hand_id: handId,
                user_id: seat.userId,
                username_snapshot: seat.username || seat.userId,
                seat: seat.seat || 0,
                start_chips: seat.startChips || 0,
                end_chips: result.endChips ?? seat.startChips ?? 0,
                won: result.won || 0,
                hole_json: JSON.stringify(seat.hole || [])
            });
        }
        (record.actions || []).forEach((action, index) => {
            insertAction.run({
                hand_id: handId,
                action_seq: index,
                user_id: action.userId,
                street: action.street || '',
                action: action.action || '',
                amount: action.amount || 0,
                think_ms: action.thinkMs || 0
            });
        });
        return { handId, inserted: true };
    });

    return {
        addMessage(userId, msg) {
            return addMessageTx(userId, msg);
        },
        getMessages(userId) {
            return db.prepare(`
                SELECT id, message_type AS type, text, created_at_ms AS ts, is_read AS read
                FROM user_messages
                WHERE user_id = ?
                ORDER BY created_at_ms DESC
                LIMIT 100
            `).all(userId).map(row => ({ ...row, read: !!row.read }));
        },
        markMessagesRead(userId) {
            db.prepare('UPDATE user_messages SET is_read = 1 WHERE user_id = ?').run(userId);
        },
        appendFeedback(record) {
            const row = {
                id: record.id || crypto.randomUUID(),
                user_id: record.userId || null,
                username: record.username || 'unknown',
                text: record.text || '',
                contact: record.contact || '',
                user_agent: record.ua || record.userAgent || '',
                status: record.status || 'new',
                created_at_ms: record.ts || Date.now()
            };
            insertFeedback.run(row);
            return row.id;
        },
        getFeedback(limit = 200) {
            return db.prepare(`
                SELECT id, user_id AS userId, username, text, contact,
                       user_agent AS ua, status, created_at_ms AS ts
                FROM feedback
                ORDER BY created_at_ms DESC
                LIMIT ?
            `).all(Math.max(1, Math.min(limit, 500)));
        },
        appendHand(record) {
            return saveHandTx(record);
        },
        getHandsForUser(userId, { limit = 30, offset = 0, mode = null, room = null } = {}) {
            const conditions = ['hp.user_id = ?'];
            const params = [userId];
            if (mode) {
                conditions.push('h.mode = ?');
                params.push(mode);
            }
            if (room) {
                conditions.push('h.room_code = ?');
                params.push(room);
            }
            params.push(Math.max(1, Math.min(limit, 200000)), Math.max(0, offset));
            return db.prepare(`
                SELECT h.payload_json
                FROM hand_players hp
                JOIN hands h ON h.id = hp.hand_id
                WHERE ${conditions.join(' AND ')}
                ORDER BY h.started_at_ms DESC, h.hand_seq DESC
                LIMIT ? OFFSET ?
            `).all(...params).map(row => JSON.parse(row.payload_json));
        },
        saveHandTx
    };
}

module.exports = { createContentRepository, stableLegacyMatchId, stableHandId };
