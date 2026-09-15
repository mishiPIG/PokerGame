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
    // 拉黑：先把关系【两边】都删干净，再只写我这一行 blocked。
    // ⚠️ 只写我这一行是刻意的 —— 对方那边看到的就是「关系没了」，
    //    和被删好友一模一样，他【无法分辨自己是不是被拉黑了】。
    //    告诉他等于给冲突加一把火，而拉黑的全部意义就是让事情停下来。
    const blockTx = db.transaction((me, other, now) => {
        delEdge.run(me, other);
        delEdge.run(other, me);
        upsert.run({ user_id: me, friend_id: other, status: 'blocked', now });
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
            // 我拉黑了他 → 明确告诉我「先解除」。这一侧没必要瞒自己。
            if (mine?.status === 'blocked') return 'youBlocked';
            // 🔴 他拉黑了我 → 【什么都不写】，但回一个和成功一样的 'requested'。
            //    这是有意的隐瞒：一旦让他看出「我被拉黑了」，要么换号再来、要么把事情闹大，
            //    拉黑就白做了。他看到的是「申请发出去了、对方没理」——和真被忽略没有区别。
            //    ⚠️ 不能改成「只写他那一行 pending」来把戏做全套：那会留下一条单边关系，
            //    正是本文件开头那条铁律（成对写入）要杜绝的东西。宁可少写，不留半条。
            if (getEdge.get(other, me)?.status === 'blocked') return 'requested';
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
        block(me, other) {
            if (me === other) return false;
            blockTx(me, other, Date.now());
            return true;
        },
        unblock(me, other) {
            if (getEdge.get(me, other)?.status !== 'blocked') return false;
            delEdge.run(me, other);
            return true;
        },
        listBlocked(userId) {
            return listByStatus.all(userId, 'blocked').map(mapFriend);
        },
        // ⚠️ 备注是【私有】的：只写我这一行。对方查自己的列表时读的是他那一行，
        //    永远看不到我给他记了什么。这条有测试锁着。
        setNote(me, other, note) {
            const clean = String(note || '').trim().slice(0, MAX_NOTE);
            const r = setNoteStmt.run(clean || null, Date.now(), me, other);
            return r.changes > 0;                               // 非好友改不了备注
        },

        // ⭐ 对战战绩：我和每个对手【同桌过的那些手】里，双方各自净多少。
        //
        // 为什么是「双方各自的净」而不是「我从他身上赢了多少」：
        //   6-9 人桌上我赢的钱大半来自别人，「我净 +78 万」并不代表从他身上拿了 78 万 ——
        //   那个数【这张表算不出来】（要按池子逐笔归属）。而「同一批手里我 +55 万、
        //   他 +62 万」是定义明确的，也正好是较劲想看的那个对比。
        // 为什么不做单挑那一栏：实测生产数据，几千手同桌里单挑只有 0~5 手 —— 会是一列 0。
        //
        // 口径和 stats.js 的生涯净盈亏【完全一致】（都是 endChips - startChips）。
        // 同一个 App 里两个「净盈亏」对不上，比不精确更糟。
        // ⚠️ 少数「手中补码」的手不守恒（生产实测 182/26943 ≈ 0.7%），净值会偏高一点点；
        //    生涯战绩本来就有同样的偏差，这里不另立口径。
        //
        // 只算现金桌：SNG 是锦标赛记分牌，和现金筹码不是一个东西，混在一起这个数就没意义了。
        //
        // 性能（2026-09-15 实测于生产备份：26,943 手 / 84,950 行 / 62 用户）：
        //   最活跃的现金玩家 6,493 手、15 个对手 → 冷 88ms、热 85ms；47 人各跑一次共 737ms。
        //   走的是 idx_hand_players_user(user_id, hand_id) 和 hand_players 的主键。
        //   ⚠️ 代价随牌谱线性增长。手数到十万量级（约现在的 4 倍）就该考虑落一张聚合表，
        //      别等它慢到有人抱怨 —— 那时它已经在每次打开面板时拖 0.5 秒了。
        headToHead(userId) {
            return db.prepare(`
                SELECT hp2.user_id                                    AS other_id,
                       u.username, u.display_name, u.avatar,
                       COUNT(*)                                       AS hands_together,
                       SUM(hp1.end_chips - hp1.start_chips)           AS my_net,
                       SUM(hp2.end_chips - hp2.start_chips)           AS their_net,
                       SUM(CASE WHEN hp1.won > 0 THEN 1 ELSE 0 END)   AS my_wins,
                       MAX(h.completed_at_ms)                         AS last_played_ms
                FROM hand_players hp1
                JOIN hands h          ON h.id = hp1.hand_id AND h.mode = 'cash'
                JOIN hand_players hp2 ON hp2.hand_id = hp1.hand_id AND hp2.user_id <> hp1.user_id
                JOIN users u          ON u.id = hp2.user_id AND u.deleted_at_ms IS NULL
                WHERE hp1.user_id = ?
                GROUP BY hp2.user_id
                ORDER BY hands_together DESC
            `).all(userId).map(r => ({
                userId: r.other_id,
                handsTogether: r.hands_together,
                myNet: r.my_net,
                theirNet: r.their_net,
                myWins: r.my_wins,
                lastPlayedMs: r.last_played_ms,
            }));
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
