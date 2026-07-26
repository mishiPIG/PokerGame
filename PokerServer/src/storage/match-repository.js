'use strict';

const crypto = require('crypto');

function createMatchRepository(db) {
    const upsertPlayerStmt = db.prepare(`
        INSERT INTO match_players (
            match_id, user_id, username_snapshot, seat, player_status,
            buyin_gold_total, buyin_chips_total, current_chips, hands_played,
            settlement_gold, settled_at_ms, joined_at_ms, left_at_ms
        ) VALUES (
            @match_id, @user_id, @username_snapshot, @seat, @player_status,
            @buyin_gold_total, @buyin_chips_total, @current_chips, @hands_played,
            @settlement_gold, @settled_at_ms, @joined_at_ms, @left_at_ms
        )
        ON CONFLICT(match_id, user_id) DO UPDATE SET
            username_snapshot = excluded.username_snapshot,
            seat = excluded.seat,
            player_status = excluded.player_status,
            buyin_gold_total = MAX(match_players.buyin_gold_total, excluded.buyin_gold_total),
            buyin_chips_total = MAX(match_players.buyin_chips_total, excluded.buyin_chips_total),
            current_chips = excluded.current_chips,
            hands_played = excluded.hands_played,
            settlement_gold = COALESCE(excluded.settlement_gold, match_players.settlement_gold),
            settled_at_ms = COALESCE(excluded.settled_at_ms, match_players.settled_at_ms),
            left_at_ms = COALESCE(excluded.left_at_ms, match_players.left_at_ms)
    `);
    function upsertPlayer(params) {
        const now = Date.now();
        upsertPlayerStmt.run({
            match_id: params.matchId,
            user_id: params.userId,
            username_snapshot: params.username,
            seat: params.seat ?? null,
            player_status: params.status || 'seated',
            buyin_gold_total: params.buyinGoldTotal || 0,
            buyin_chips_total: params.buyinChipsTotal || 0,
            current_chips: params.currentChips || 0,
            hands_played: params.handsPlayed || 0,
            settlement_gold: params.settlementGold ?? null,
            settled_at_ms: params.settledAt || null,
            joined_at_ms: params.joinedAt || now,
            left_at_ms: params.leftAt || null
        });
    }
    const insertMatch = db.prepare(`
        INSERT INTO matches (
            id, room_code, room_type, status, owner_user_id, name, config_json,
            invite_json, state_version, started_at_ms, scheduled_end_ms, ended_at_ms,
            created_at_ms, updated_at_ms
        ) VALUES (
            @id, @room_code, @room_type, @status, @owner_user_id, @name, @config_json,
            @invite_json, @state_version, @started_at_ms, @scheduled_end_ms, @ended_at_ms,
            @created_at_ms, @updated_at_ms
        )
    `);
    const insertState = db.prepare(`
        INSERT INTO active_match_states (
            match_id, state_version, hand_seq, phase, snapshot_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertEvent = db.prepare(`
        INSERT INTO match_events(match_id, state_version, event_type, user_id, payload_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const createTx = db.transaction(params => {
        const now = Date.now();
        const id = params.id || crypto.randomUUID();
        insertMatch.run({
            id,
            room_code: String(params.roomCode),
            room_type: params.roomType,
            status: params.status || 'waiting',
            owner_user_id: params.ownerUserId,
            name: params.name,
            config_json: JSON.stringify(params.config || {}),
            invite_json: JSON.stringify(params.invite || null),
            state_version: 1,
            started_at_ms: params.startedAt || null,
            scheduled_end_ms: params.scheduledEndAt || null,
            ended_at_ms: null,
            created_at_ms: now,
            updated_at_ms: now
        });
        insertState.run(id, 1, params.handSeq || 0, params.phase || 'waiting', JSON.stringify(params.snapshot), now);
        insertEvent.run(id, 1, 'match_created', params.ownerUserId, JSON.stringify({ roomCode: String(params.roomCode) }), now);
        for (const player of params.players || []) upsertPlayer({ ...player, matchId: id });
        return { id, stateVersion: 1 };
    });

    const commitTx = db.transaction(params => {
        const current = db.prepare('SELECT state_version, status FROM matches WHERE id = ?').get(params.matchId);
        if (!current) throw new Error('MATCH_NOT_FOUND');
        if (params.expectedVersion != null && current.state_version !== params.expectedVersion) {
            throw new Error('STALE_MATCH_VERSION');
        }
        const nextVersion = current.state_version + 1;
        const now = Date.now();
        const update = db.prepare(`
            UPDATE matches
            SET state_version = ?, status = ?, config_json = ?, invite_json = ?,
                started_at_ms = COALESCE(started_at_ms, ?), scheduled_end_ms = ?,
                ended_at_ms = ?, updated_at_ms = ?
            WHERE id = ? AND state_version = ?
        `).run(
            nextVersion,
            params.status || current.status,
            JSON.stringify(params.config || {}),
            JSON.stringify(params.invite || null),
            params.startedAt || null,
            params.scheduledEndAt || null,
            params.endedAt || null,
            now,
            params.matchId,
            current.state_version
        );
        if (update.changes !== 1) throw new Error('STALE_MATCH_VERSION');
        db.prepare(`
            INSERT INTO active_match_states(match_id, state_version, hand_seq, phase, snapshot_json, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(match_id) DO UPDATE SET
                state_version = excluded.state_version,
                hand_seq = excluded.hand_seq,
                phase = excluded.phase,
                snapshot_json = excluded.snapshot_json,
                updated_at_ms = excluded.updated_at_ms
        `).run(params.matchId, nextVersion, params.handSeq || 0, params.phase || 'waiting', JSON.stringify(params.snapshot), now);
        insertEvent.run(
            params.matchId,
            nextVersion,
            params.eventType || 'state_committed',
            params.userId || null,
            JSON.stringify(params.eventPayload || {}),
            now
        );
        for (const player of params.players || []) upsertPlayer({ ...player, matchId: params.matchId });
        return { stateVersion: nextVersion };
    });

    return {
        create(params) {
            return createTx(params);
        },
        commitState(params) {
            return commitTx(params);
        },
        upsertPlayer(params) {
            upsertPlayer(params);
        },
        findRecoverable() {
            return db.prepare(`
                SELECT m.*, s.snapshot_json, s.state_version AS snapshot_version
                FROM matches m
                JOIN active_match_states s ON s.match_id = m.id
                WHERE m.status IN ('waiting', 'running', 'paused', 'finished', 'recovery_needed')
                ORDER BY m.created_at_ms
            `).all().map(row => ({
                ...row,
                config: JSON.parse(row.config_json || '{}'),
                invite: JSON.parse(row.invite_json || 'null'),
                snapshot: JSON.parse(row.snapshot_json)
            }));
        },
        getById(matchId) {
            return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) || null;
        },
        markRecoveryNeeded(matchId, error) {
            db.prepare(`
                UPDATE matches
                SET status = 'recovery_needed', updated_at_ms = ?
                WHERE id = ?
            `).run(Date.now(), matchId);
            const current = db.prepare('SELECT state_version FROM matches WHERE id = ?').get(matchId);
            if (current) {
                try {
                    insertEvent.run(
                        matchId,
                        current.state_version + 1,
                        'recovery_failed',
                        null,
                        JSON.stringify({ error: String(error?.message || error) }),
                        Date.now()
                    );
                    db.prepare('UPDATE matches SET state_version = state_version + 1 WHERE id = ?').run(matchId);
                } catch { /* preserve original recovery failure */ }
            }
        },
        finish(matchId, status = 'finished') {
            const now = Date.now();
            db.transaction(() => {
                db.prepare(`
                    UPDATE matches
                    SET status = ?, ended_at_ms = ?, updated_at_ms = ?
                    WHERE id = ?
                `).run(status, now, now, matchId);
                db.prepare('DELETE FROM active_match_states WHERE match_id = ?').run(matchId);
            })();
        },
        raw: db
    };
}

module.exports = { createMatchRepository };
