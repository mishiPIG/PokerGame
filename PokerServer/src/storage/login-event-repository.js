'use strict';

// 登录/注册来源（2026-09-21）。表结构与「为什么」见 migrations/005-login-events.sql。
//
// ⚠️ 本模块的第一原则：**记录失败绝不能连累注册和登录**。
//    这是运营数据，不是业务数据 —— 为了记一条来源而让人登不进去，是本末倒置。
//    所以 record() 吞掉一切异常，只打日志。
//
// ⚠️ 第二原则：**同 IP 只是线索，不是结论**。查询函数一律叫 `...Candidates`，
//    返回的东西也一律当「待人工复核」看待，别在调用处写成自动处置。
//    （CGNAT 下成千上万人共用一个出口 IP；朋友局里同宿舍/同公司更是常态。）

const { prefixOf } = require('../ops/client-ip');

const DEFAULT_RETENTION_DAYS = 180;

function createLoginEventRepository(db) {
    const insert = db.prepare(`
        INSERT INTO login_events(user_id, kind, ip, ip_prefix, created_at_ms)
        VALUES (@user_id, @kind, @ip, @ip_prefix, @created_at_ms)
    `);

    return {
        // kind: 'signup' | 'login'。ip 允许为 null（取不到就是取不到）。
        record({ userId, kind, ip, now = Date.now() }) {
            try {
                insert.run({
                    user_id: userId,
                    kind: kind === 'signup' ? 'signup' : 'login',
                    ip: ip || null,
                    ip_prefix: ip ? prefixOf(ip) : null,
                    created_at_ms: now,
                });
                return true;
            } catch (e) {
                console.error('[login-event] 记录失败（不影响登录）', e.message);
                return false;
            }
        },

        // 地区分布：按国家聚合「有过活动的独立用户数」。
        // 用 DISTINCT user_id 而不是事件数 —— 否则一个人登录 100 次会把他所在地区顶上天。
        distributionByCountry({ days = 90, now = Date.now() } = {}) {
            const since = now - days * 86400000;
            return db.prepare(`
                SELECT COALESCE(g.country, '?') AS country,
                       COUNT(DISTINCT e.user_id) AS users,
                       COUNT(*)                  AS events
                  FROM login_events e
                  LEFT JOIN ip_geo g ON g.ip = e.ip
                 WHERE e.created_at_ms >= @since AND e.ip IS NOT NULL
                 GROUP BY COALESCE(g.country, '?')
                 ORDER BY users DESC, events DESC
            `).all({ since });
        },

        // 每个用户最近一次来源（管理面板玩家列表用得上）
        latestForUsers({ limit = 200 } = {}) {
            return db.prepare(`
                SELECT e.user_id, e.ip, e.ip_prefix, e.created_at_ms, g.country, g.city
                  FROM login_events e
                  LEFT JOIN ip_geo g ON g.ip = e.ip
                 WHERE e.id IN (SELECT MAX(id) FROM login_events GROUP BY user_id)
                 ORDER BY e.created_at_ms DESC
                 LIMIT @limit
            `).all({ limit });
        },

        // 🔴 同网段多账号【候选】—— 只是线索，不是结论。见文件头。
        sameNetworkCandidates({ minAccounts = 2, days = 365, now = Date.now() } = {}) {
            const since = now - days * 86400000;
            const rows = db.prepare(`
                SELECT e.ip_prefix AS prefix,
                       COUNT(DISTINCT e.user_id) AS accounts,
                       MAX(e.created_at_ms)      AS last_seen
                  FROM login_events e
                 WHERE e.ip_prefix IS NOT NULL AND e.created_at_ms >= @since
                 GROUP BY e.ip_prefix
                HAVING COUNT(DISTINCT e.user_id) >= @minAccounts
                 ORDER BY accounts DESC, last_seen DESC
            `).all({ since, minAccounts });

            const who = db.prepare(`
                SELECT DISTINCT e.user_id, u.username, u.display_name, u.deleted_at_ms
                  FROM login_events e JOIN users u ON u.id = e.user_id
                 WHERE e.ip_prefix = @prefix AND e.created_at_ms >= @since
            `);
            return rows.map(r => ({ ...r, users: who.all({ prefix: r.prefix, since }) }));
        },

        // 还没解析过地理位置的 IP（交给一次性子进程去查，见 tools/geo-lookup.js）
        unresolvedIps({ limit = 500 } = {}) {
            return db.prepare(`
                SELECT DISTINCT e.ip FROM login_events e
                 LEFT JOIN ip_geo g ON g.ip = e.ip
                 WHERE e.ip IS NOT NULL AND g.ip IS NULL
                 LIMIT @limit
            `).all({ limit }).map(r => r.ip);
        },

        saveGeo(rows, { now = Date.now() } = {}) {
            const up = db.prepare(`
                INSERT INTO ip_geo(ip, country, region, city, resolved_at_ms)
                VALUES (@ip, @country, @region, @city, @at)
                ON CONFLICT(ip) DO UPDATE SET
                    country = excluded.country, region = excluded.region,
                    city = excluded.city, resolved_at_ms = excluded.resolved_at_ms
            `);
            // 解析不出来也要写一行（country=NULL），否则每次都会重复去查同一批查不到的 IP
            const tx = db.transaction((list) => {
                for (const r of list) {
                    up.run({
                        ip: r.ip, country: r.country || null,
                        region: r.region || null, city: r.city || null, at: now,
                    });
                }
            });
            tx(rows);
            return rows.length;
        },

        // 保留期清理。IP 是个人数据，不能无限期留着。
        purgeOlderThan({ days = DEFAULT_RETENTION_DAYS, now = Date.now() } = {}) {
            const cutoff = now - days * 86400000;
            const n = db.prepare('DELETE FROM login_events WHERE created_at_ms < ?').run(cutoff).changes;
            // 没有任何事件再引用的地理缓存也一并清掉
            db.prepare('DELETE FROM ip_geo WHERE ip NOT IN (SELECT ip FROM login_events WHERE ip IS NOT NULL)').run();
            return n;
        },

        // 账号注销时调用：这个人的来源记录要连根拔掉。
        // 🔴 不能只把 user_id 抹掉留着 IP —— 那条 IP 仍然指向一个真人。
        forgetUser(userId) {
            return db.prepare('DELETE FROM login_events WHERE user_id = ?').run(userId).changes;
        },

        DEFAULT_RETENTION_DAYS,
    };
}

module.exports = { createLoginEventRepository, DEFAULT_RETENTION_DAYS };
