'use strict';

// 账号删除 + 牌谱匿名化（2026-09-16）。
//
// 上架 Google Play / App Store **硬性要求 App 内能删除账号**，所以这件事早晚要做。
// 但它真正的难点不是「删」，是【删什么、留什么】—— 必须先定死策略再写代码，
// 否则第一版怎么写，以后就再也改不回来了（数据删了就没了）。
//
// ══ 策略（想清楚了再动手的那部分）══
//
// 1) **绝不能物理删掉这个人的牌谱**。一手牌是【好几个人共同的记录】——
//    删了它，同桌另外几个人的牌谱、战绩、以及筹码守恒审计的证据链一起没了。
//    「A 要删号」不该让 B 的历史出现空洞。而且牌谱是本项目的核心数据资产。
//
// 2) **所以是「抹掉身份」而不是「删掉行」**：把能指向真人的东西全部销毁
//    （邮箱 / 密码 / 用户名 / 显示名 / 头像 / 牌友号 / 站内信 / 好友关系 / 反馈里的联系方式），
//    牌局记录本身原样留下，只把里面的名字换成一个**随机**的匿名代号。
//    留下的 user_id 是个 UUID，在邮箱和用户名都销毁之后**没有任何东西能把它连回真人**。
//
// 3) **匿名代号必须是随机的，不能是原用户名的哈希**。
//    用户名是低熵的（就那么几个常见名字），哈希能被暴力反查出来 —— 那就不叫匿名。
//
// 4) **软删除是被 schema 逼出来的，不是偏好**：`foreign_keys=ON`，而 8 张表外键指向
//    users（钱包流水 / 牌局 / 房间 / 好友 …）。真 DELETE 要么违反外键、要么级联删掉一大片。
//    好在 `deleted_at_ms` 早就存在，而且**读取层已经处处在过滤它**
//    （按 id/用户名/邮箱/牌友号 查、钱包余额查询，全都带 `deleted_at_ms IS NULL`）——
//    也就是说打上这个标记的瞬间，这个号就登不进来、查不到、搜不着了。
//
// 5) **金币作废**。删号即放弃余额，界面上必须说清楚（不能让人以为还能找回来）。
//
// ══ 为什么拆成「立刻生效」+「慢慢擦」两步 ══
// 牌谱可能有上万手，逐条 JSON.parse/stringify 是同步的，一口气做完会把事件循环卡住几百毫秒
// —— 而本项目的底线是**绝不能影响正在进行的牌局**。
// 所以：身份销毁在一个**小而快的事务**里完成（登录立刻失效，这才是要紧的那半），
// 牌谱擦除**分批做、可中断、可重放**（擦除是按 userId 找、写成固定代号，重复跑无副作用）。
// 万一中途重启，启动时的清扫会把没擦完的接着擦完 —— 不留半抹状态。

const crypto = require('crypto');

const SCRUB_BATCH = 300;

// 随机代号（见策略 3）。前缀让人一眼看出这是注销账号，而不是某个真名。
function makeHandle() {
    return '已注销#' + crypto.randomBytes(4).toString('hex');
}

function createAccountDeletionRepository(db) {

    // 找出这个人还有多少手牌谱没擦干净。
    // 判据是「那手牌的 payload 里还没有出现这个匿名代号」—— 代号唯一且专属于他，
    // 所以这个判据天然幂等：擦过的不会再被选中，没擦完的下次一定还在。
    const pendingStmt = db.prepare(`
        SELECT h.id AS id, h.payload_json AS payload
          FROM hands h
          JOIN hand_players hp ON hp.hand_id = h.id AND hp.user_id = @uid
         WHERE h.payload_json NOT LIKE @mark
         LIMIT @limit
    `);
    const pendingCountStmt = db.prepare(`
        SELECT COUNT(*) AS n
          FROM hands h
          JOIN hand_players hp ON hp.hand_id = h.id AND hp.user_id = @uid
         WHERE h.payload_json NOT LIKE @mark
    `);
    const updatePayload = db.prepare('UPDATE hands SET payload_json = ? WHERE id = ?');

    // 第一步：销毁身份。小事务，必须原子 —— 半抹的账号是最糟的结果
    // （既登不进去、又还挂着邮箱占着唯一索引）。
    const anonymizeTx = db.transaction((userId, handle, now) => {
        const user = db.prepare('SELECT id, deleted_at_ms FROM users WHERE id = ?').get(userId);
        if (!user) return { ok: false, reason: 'NOT_FOUND' };
        if (user.deleted_at_ms) return { ok: false, reason: 'ALREADY_DELETED' };

        db.prepare(`
            UPDATE users SET
                username = @handle,
                email = NULL,                       -- 释放邮箱：以后还能拿它重新注册一个新号
                password_hash = 'deleted-account',  -- 不是任何 bcrypt 哈希，永远比不中
                display_name = NULL,
                avatar = NULL,
                friend_code = NULL,
                last_checkin = NULL,
                checkin_streak = 0,
                gold = 0,                           -- 余额作废（见策略 5）
                is_admin = 0,
                deleted_at_ms = @now,
                updated_at_ms = @now
            WHERE id = @id
        `).run({ id: userId, handle, now });

        // 名字快照：这两张表各自存了一份当时的用户名
        db.prepare('UPDATE hand_players SET username_snapshot = @handle WHERE user_id = @id')
            .run({ id: userId, handle });
        db.prepare('UPDATE match_players SET username_snapshot = @handle WHERE user_id = @id')
            .run({ id: userId, handle });

        // 好友关系：两个方向都要删。备注是**对方写的、存在对方那一行**，
        // 同样是关于这个人的个人数据，一并清掉。
        db.prepare('DELETE FROM friendships WHERE user_id = @id OR friend_id = @id').run({ id: userId });

        // 站内信是发给他个人的（名次/盈亏/管理员通知），跟着人走
        db.prepare('DELETE FROM user_messages WHERE user_id = @id').run({ id: userId });

        // 反馈：**联系方式和 UA 是实打实的个人数据**（玩家会填邮箱/微信/手机），必须清；
        // 正文留下 —— 那是一份还可能要处理的 bug 报告，且不含身份指向。
        db.prepare(`
            UPDATE feedback SET username = @handle, contact = NULL, user_agent = NULL
             WHERE user_id = @id
        `).run({ id: userId, handle });

        // 活跃牌局快照里也有名字。正常删号前已校验「不在任何牌局里」，
        // 这里只是兜底清掉可能残留的旧快照。
        for (const row of db.prepare(
            'SELECT match_id, snapshot_json FROM active_match_states WHERE snapshot_json LIKE @like')
            .all({ like: '%' + userId + '%' })) {
            db.prepare('UPDATE active_match_states SET snapshot_json = ? WHERE match_id = ?')
                .run(scrubJsonNames(row.snapshot_json, userId, handle), row.match_id);
        }

        return { ok: true, handle };
    });

    // 第二步：分批擦牌谱。每批一个小事务，随时可停、可重放。
    const scrubBatchTx = db.transaction((userId, handle, limit) => {
        const mark = '%"username":"' + handle + '"%';
        const rows = pendingStmt.all({ uid: userId, mark, limit });
        for (const r of rows) updatePayload.run(scrubJsonNames(r.payload, userId, handle), r.id);
        return rows.length;
    });

    return {
        makeHandle,

        // 只做身份销毁（快）。返回匿名代号，第二步要用它。
        anonymizeIdentity(userId, { now = Date.now(), handle = makeHandle() } = {}) {
            return anonymizeTx(userId, handle, now);
        },

        scrubHandBatch(userId, handle, limit = SCRUB_BATCH) {
            return scrubBatchTx(userId, handle, limit);
        },

        pendingHandCount(userId, handle) {
            return pendingCountStmt.get({ uid: userId, mark: '%"username":"' + handle + '"%' }).n;
        },

        // 启动时用：找出「已注销但牌谱还没擦完」的账号。
        // 中途重启不会留下永远擦不完的半成品。
        pendingScrubUsers() {
            const out = [];
            for (const u of db.prepare(
                'SELECT id, username FROM users WHERE deleted_at_ms IS NOT NULL').all()) {
                const n = pendingCountStmt.get({
                    uid: u.id, mark: '%"username":"' + u.username + '"%' }).n;
                if (n > 0) out.push({ userId: u.id, handle: u.username, pending: n });
            }
            return out;
        },

        SCRUB_BATCH,
        // 上次有账号注销到一半就重启了？把没擦完的牌谱接着擦完。
        // **每批之间让出事件循环** —— 上万手牌一口气擦会把服务卡住几百毫秒，
        // 而本项目的底线是绝不能影响正在进行的牌局。
        // 不做这件事的话，中断处会留下一个【永远擦不完的半成品】—— 而且没有任何人会发现。
        async resumePendingScrubs({ log = console.log } = {}) {
            let total = 0;
            for (const job of this.pendingScrubUsers()) {
                log('[account] 续擦上次未完成的注销 user=' + job.userId + ' 剩 ' + job.pending + ' 手');
                for (let i = 0; i < 5000; i++) {
                    const n = this.scrubHandBatch(job.userId, job.handle);
                    if (n === 0) break;
                    total += n;
                    await new Promise(r => setImmediate(r));
                }
            }
            return total;
        },
    };
}

// 把一段 JSON 里属于某个 userId 的名字/头像换成匿名代号。
// 只动**确实属于这个人**的那些条目 —— 同桌其他人的名字一个字都不能碰。
function scrubJsonNames(jsonText, userId, handle) {
    let obj;
    try { obj = JSON.parse(jsonText); } catch { return jsonText; }
    const walk = (node) => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (node.userId === userId || node.id === userId) {
            if ('username' in node) node.username = handle;
            if ('displayName' in node) node.displayName = handle;
            if ('name' in node) node.name = handle;
            if ('avatar' in node) node.avatar = null;
        }
        for (const v of Object.values(node)) walk(v);
    };
    walk(obj);
    return JSON.stringify(obj);
}

module.exports = { createAccountDeletionRepository, scrubJsonNames, makeHandle };
