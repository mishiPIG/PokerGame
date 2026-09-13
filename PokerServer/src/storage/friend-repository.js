'use strict';

// 牌友关系。关系存【两行】（A→B、B→A 各一行），理由见 003-friends.sql 的注释。
// 成对写入全部收在本文件的事务里 —— 业务代码永远不该自己去补另一行，
// 否则总有一条路径会漏，留下「我把你删了、你那边还挂着我」这种单边关系。

const MAX_NOTE = 40;

function mapFriend(row) {
    if (!row) return null;
    return {
        userId: row.friend_id,
        username: row.username,
        displayName: row.display_name || row.username,
        avatar: row.avatar || null,
        status: row.status,
        note: row.note || '',
        createdAtMs: row.created_at_ms,
    };
}

function createFriendRepository(db) {
    // 查列表时顺带把对方的名字/头像带出来，省得业务层再查一遍 users
    const listByStatus = db.prepare(`
        SELECT f.friend_id, f.status, f.note, f.created_at_ms,
               u.username, u.display_name, u.avatar
        FROM friendships f
        JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ? AND f.status = ? AND u.deleted_at_ms IS NULL
        ORDER BY f.updated_at_ms DESC
    `);
    const getEdge = db.prepare('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?');
    const upsert = db.prepare(`
        INSERT INTO friendships(user_id, friend_id, status, note, created_at_ms, updated_at_ms)
        VALUES (@user_id, @friend_id, @status, NULL, @now, @now)
        ON CONFLICT(user_id, friend_id) DO UPDATE SET status = @status, updated_at_ms = @now
    `);
    const delEdge = db.prepare('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?');
    const setNoteStmt = db.prepare(`
        UPDATE friendships SET note = ?, updated_at_ms = ?
        WHERE user_id = ? AND friend_id = ? AND status = 'accepted'
    `);

    // 申请：我这边 pending、对方那边 incoming，一个事务写两行
    const requestTx = db.transaction((me, other, now) => {
        upsert.run({ user_id: me, friend_id: other, status: 'pending', now });
        upsert.run({ user_id: other, friend_id: me, status: 'incoming', now });
    });
    // 同意：两边都变 accepted
    const acceptTx = db.transaction((me, other, now) => {
        upsert.run({ user_id: me, friend_id: other, status: 'accepted', now });
        upsert.run({ user_id: other, friend_id: me, status: 'accepted', now });
    });
    // 拒绝 / 删除：两行一起删（留下单边关系比没有关系更糟）
    const removeTx = db.transaction((me, other) => {
        delEdge.run(me, other);
        delEdge.run(other, me);
    });

    return {
        listFriends(userId) {
            return listByStatus.all(userId, 'accepted').map(mapFriend);
        },
        listIncoming(userId) {
            return listByStatus.all(userId, 'incoming').map(mapFriend);
        },
        listOutgoing(userId) {
            return listByStatus.all(userId, 'pending').map(mapFriend);
        },
        edgeStatus(userId, otherId) {
            const row = getEdge.get(userId, otherId);
            return row ? row.status : null;
        },

        // 返回值告诉调用方到底发生了什么，别让它去猜：
        //   'requested'  申请已发出
        //   'accepted'   对方本来就在申请我 → 直接成为好友（不必让两个人各点一次）
        //   'already'    已经是好友
        //   'pending'    我已经申请过了，别重复发
        request(me, other) {
            if (me === other) return 'self';
            const mine = getEdge.get(me, other);
            if (mine?.status === 'accepted') return 'already';
            if (mine?.status === 'pending') return 'pending';
            const now = Date.now();
            // 对方先申请过我 → 我这一下就当作「同意」，省掉一次来回
            if (mine?.status === 'incoming') { acceptTx(me, other, now); return 'accepted'; }
            requestTx(me, other, now);
            return 'requested';
        },
        accept(me, other) {
            const mine = getEdge.get(me, other);
            if (mine?.status !== 'incoming') return false;     // 没有待处理的申请，不许凭空建立关系
            acceptTx(me, other, Date.now());
            return true;
        },
        remove(me, other) {
            removeTx(me, other);
            return true;
        },
        // ⚠️ 备注是【私有】的：只写我这一行。对方查自己的列表时读的是他那一行，
        //    永远看不到我给他记了什么。这条有测试锁着。
        setNote(me, other, note) {
            const clean = String(note || '').trim().slice(0, MAX_NOTE);
            const r = setNoteStmt.run(clean || null, Date.now(), me, other);
            return r.changes > 0;                               // 非好友改不了备注
        },

        // ⭐「上次一起玩的人」：零新数据，全从牌谱里查。
        //    hand_players(我) → hands → hand_players(其他人)，走现成的
        //    idx_hand_players_user(user_id, hand_id) 索引。
        //    只看最近 N 手，避免全表扫（牌谱是只增不减的，早晚会很大）。
        recentTablemates(userId, { handLimit = 400, limit = 20 } = {}) {
            return db.prepare(`
                WITH my_hands AS (
                    SELECT hand_id FROM hand_players
                    WHERE user_id = ?
                    ORDER BY hand_id DESC
                    LIMIT ?
                )
                SELECT hp.user_id                       AS friend_id,
                       u.username, u.display_name, u.avatar,
                       COUNT(*)                         AS hands_together,
                       MAX(h.completed_at_ms)           AS last_played_ms
                FROM my_hands m
                JOIN hand_players hp ON hp.hand_id = m.hand_id AND hp.user_id <> ?
                JOIN hands h         ON h.id = m.hand_id
                JOIN users u         ON u.id = hp.user_id AND u.deleted_at_ms IS NULL
                WHERE hp.user_id NOT IN (SELECT friend_id FROM friendships WHERE user_id = ?)
                GROUP BY hp.user_id
                ORDER BY last_played_ms DESC
                LIMIT ?
            `).all(userId, handLimit, userId, userId, limit).map(r => ({
                userId: r.friend_id,
                username: r.username,
                displayName: r.display_name || r.username,
                avatar: r.avatar || null,
                handsTogether: r.hands_together,
                lastPlayedMs: r.last_played_ms,
            }));
        },
    };
}

module.exports = { createFriendRepository, MAX_NOTE };
