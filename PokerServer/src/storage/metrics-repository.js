'use strict';

// 运营指标（2026-09-16）。
//
// 🔴 缺口：这个产品**不知道有没有人在用**。
//    ROADMAP 的结论是核心风险已经从「牌局出错」变成「做了没人用」，
//    可我们手上一个能回答这件事的数字都没有 —— 只能靠「最近好像没人反馈」这种体感。
//    加功能之前先能看见「加了到底有没有人用」，否则做的全是盲目投入。
//
// 三条设计原则（都是为了让这些数字**敢拿来做决定**）：
//
// ① **日界线必须是显式 UTC+8，不能跟服务器时区走**。
//    迁 AWS 那次「预计结束时间」差了 8 小时就是这个教训；签到那段写对了
//    （显式 `Date.now()+8*3600*1000`），这里照它来。跟服务器时区走的话，
//    换一台机器所有历史数字会整体平移一天，而且**不会报错**。
//
// ② **活跃的定义写死在这里，并且拆开显示**。
//    「DAU」如果是个黑箱，看的人会按自己的理解去解释它。
//    这里 活跃 = 当天打过牌 ∪ 当天签到，而且打牌人数/签到人数**分别也给出来**，
//    这样 DAU 涨了能立刻看出是真有人打牌、还是只是来领了个金币。
//
// ③ **留存给「几分之几」，不只给百分比**。
//    这个产品现在几十个用户，一个 2 人的 cohort 里多一个人就是 +50%。
//    只显示百分比会让人对着噪声做决定 —— 那比没有指标更糟。

const DAY_MS = 86400000;
const TZ_OFFSET_HOURS = 8;                       // 见原则①：显式写死，不读服务器时区
const OFFSET_MS = TZ_OFFSET_HOURS * 3600 * 1000;

// 毫秒时间戳 → 'YYYY-MM-DD'（UTC+8）。
// 整数除法在 SQLite 里是截断，对正数时间戳没问题。
const DAY_OF = (col) => `strftime('%Y-%m-%d', (${col} + ${OFFSET_MS}) / 1000, 'unixepoch')`;

// 活跃 = 打过牌 ∪ 签到（见原则②）。
//
// ⚠️ 去重有【两道】：这里的 UNION（按 day+user_id 去重）和调用处的 COUNT(DISTINCT user_id)。
//    两道各自都够用，所以**单独改掉任何一道都不会出错、测试也不会红**
//    （实测：UNION→UNION ALL 全绿，去掉外层 DISTINCT 也全绿，两个一起拆才挂）。
//    写在这里是免得以后有人看见其中一道以为它是多余的就顺手删掉 ——
//    真删到只剩零道时，同时既打牌又签到的人会被算两次，而 DAU 只是「偏高一点」，
//    没有任何外在症状。要动就两道一起想清楚。
// daily_checkins.checkin_date 本来就是按 UTC+8 存的 'YYYY-MM-DD'，直接用。
const ACTIVE_UNION = `
    SELECT ${DAY_OF('h.started_at_ms')} AS day, hp.user_id AS user_id
      FROM hand_players hp JOIN hands h ON h.id = hp.hand_id
     WHERE h.started_at_ms >= @since
    UNION
    SELECT checkin_date AS day, user_id
      FROM daily_checkins
     WHERE created_at_ms >= @since
`;

function createMetricsRepository(db) {
    // 把 [since, 今天] 之间每一天都补齐成一行。
    // **没有数据的那天必须是 0，不能不出现** —— 一条中间断掉的折线会被看成「还行」，
    // 而真相是那天一个人都没有。这正是最该看见的信号。
    function emptyDays(days, nowMs) {
        const out = [];
        const todayIdx = Math.floor((nowMs + OFFSET_MS) / DAY_MS);
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date((todayIdx - i) * DAY_MS);
            out.push({
                date: d.toISOString().slice(0, 10),
                dau: 0, playedUsers: 0, checkinUsers: 0, hands: 0, signups: 0, matches: 0,
            });
        }
        return out;
    }

    function daily({ days = 30, now = Date.now() } = {}) {
        const todayIdx = Math.floor((now + OFFSET_MS) / DAY_MS);
        const since = (todayIdx - days + 1) * DAY_MS - OFFSET_MS;   // 那一天 00:00(UTC+8) 的毫秒
        const rows = emptyDays(days, now);
        const byDate = new Map(rows.map(r => [r.date, r]));
        const put = (date, key, value) => { const r = byDate.get(date); if (r) r[key] = value; };

        for (const r of db.prepare(`
            SELECT day, COUNT(DISTINCT user_id) AS n FROM (${ACTIVE_UNION}) GROUP BY day
        `).all({ since })) put(r.day, 'dau', r.n);

        for (const r of db.prepare(`
            SELECT ${DAY_OF('h.started_at_ms')} AS day, COUNT(DISTINCT hp.user_id) AS n
              FROM hand_players hp JOIN hands h ON h.id = hp.hand_id
             WHERE h.started_at_ms >= @since GROUP BY day
        `).all({ since })) put(r.day, 'playedUsers', r.n);

        for (const r of db.prepare(`
            SELECT checkin_date AS day, COUNT(DISTINCT user_id) AS n
              FROM daily_checkins WHERE created_at_ms >= @since GROUP BY day
        `).all({ since })) put(r.day, 'checkinUsers', r.n);

        for (const r of db.prepare(`
            SELECT ${DAY_OF('started_at_ms')} AS day, COUNT(*) AS n
              FROM hands WHERE started_at_ms >= @since GROUP BY day
        `).all({ since })) put(r.day, 'hands', r.n);

        for (const r of db.prepare(`
            SELECT ${DAY_OF('created_at_ms')} AS day, COUNT(*) AS n
              FROM users WHERE created_at_ms >= @since AND deleted_at_ms IS NULL GROUP BY day
        `).all({ since })) put(r.day, 'signups', r.n);

        for (const r of db.prepare(`
            SELECT ${DAY_OF('created_at_ms')} AS day, COUNT(*) AS n
              FROM matches WHERE created_at_ms >= @since GROUP BY day
        `).all({ since })) put(r.day, 'matches', r.n);

        return rows;
    }

    function totals({ now = Date.now() } = {}) {
        const one = (sql, params = {}) => db.prepare(sql).get(params)?.n ?? 0;
        const since = (d) => now - d * DAY_MS;

        return {
            users: one('SELECT COUNT(*) AS n FROM users WHERE deleted_at_ms IS NULL'),
            deletedUsers: one('SELECT COUNT(*) AS n FROM users WHERE deleted_at_ms IS NOT NULL'),
            hands: one('SELECT COUNT(*) AS n FROM hands'),
            matches: one('SELECT COUNT(*) AS n FROM matches'),
            active7d: one(`SELECT COUNT(DISTINCT user_id) AS n FROM (${ACTIVE_UNION})`, { since: since(7) }),
            active30d: one(`SELECT COUNT(DISTINCT user_id) AS n FROM (${ACTIVE_UNION})`, { since: since(30) }),

            // 🔴 这两个是对「做了没人用」最直接的回答，比 DAU 更该先看：
            // 注册了却**一手都没打过**的人 —— 卡在注册到坐下之间的漏斗，
            // 正是 ROADMAP 里「冷启动死局」预测会发生的事。
            neverPlayed: one(`
                SELECT COUNT(*) AS n FROM users u
                 WHERE u.deleted_at_ms IS NULL
                   AND NOT EXISTS (SELECT 1 FROM hand_players hp WHERE hp.user_id = u.id)
            `),
            // 只在**一天**里打过牌的人（来了一次就没再回来）
            onlyOneDay: one(`
                SELECT COUNT(*) AS n FROM (
                    SELECT hp.user_id
                      FROM hand_players hp JOIN hands h ON h.id = hp.hand_id
                     GROUP BY hp.user_id
                    HAVING COUNT(DISTINCT ${DAY_OF('h.started_at_ms')}) = 1
                )
            `),
        };
    }

    // 留存：按注册日分组，看这批人在第 N 天还活不活跃。
    // 只统计**已经满了 N 天**的 cohort —— 昨天注册的人不可能有 D7 数据，
    // 把他们算进分母会让留存率凭空变低（而且是越近期越低，看上去像在恶化）。
    function retention({ days = 30, now = Date.now(), offsets = [1, 7] } = {}) {
        const todayIdx = Math.floor((now + OFFSET_MS) / DAY_MS);
        const since = (todayIdx - days + 1) * DAY_MS - OFFSET_MS;

        const regs = db.prepare(`
            SELECT ${DAY_OF('created_at_ms')} AS day, id
              FROM users WHERE created_at_ms >= @since AND deleted_at_ms IS NULL
        `).all({ since });

        // 活跃集合取全量（注册在窗口内、但活跃可能发生在今天）
        const acts = db.prepare(`SELECT DISTINCT day, user_id FROM (${ACTIVE_UNION})`).all({ since });
        const activeSet = new Set(acts.map(a => a.user_id + '@' + a.day));

        const cohorts = new Map();
        for (const r of regs) {
            if (!cohorts.has(r.day)) cohorts.set(r.day, []);
            cohorts.get(r.day).push(r.id);
        }

        const dayIdxOf = (dateStr) => Math.floor(Date.parse(dateStr + 'T00:00:00Z') / DAY_MS);
        const out = [];
        for (const [day, ids] of [...cohorts.entries()].sort()) {
            const row = { date: day, cohort: ids.length, retained: {} };
            for (const off of offsets) {
                // cohort 还没满 off 天 → 给 null，而不是 0。
                // 0 会被当成「一个都没留下」，null 才是「还不知道」。
                if (dayIdxOf(day) + off > todayIdx) { row.retained['d' + off] = null; continue; }
                const target = new Date((dayIdxOf(day) + off) * DAY_MS).toISOString().slice(0, 10);
                row.retained['d' + off] = ids.filter(id => activeSet.has(id + '@' + target)).length;
            }
            out.push(row);
        }
        return out;
    }

    return { daily, totals, retention, TZ_OFFSET_HOURS };
}

module.exports = { createMetricsRepository, TZ_OFFSET_HOURS };
