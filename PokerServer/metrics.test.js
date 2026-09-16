'use strict';

// 运营指标（2026-09-16）。
//
// 这些数字是**要拿来做产品决定的**（「该不该继续做这个功能」），
// 所以错了比没有更糟：没有指标你会去问人，错的指标你会直接信。
// 下面守的四条全是「错了看不出来」的那种：日界线、断掉的那天、重复计数、还没到期的 cohort。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabaseService } = require('./src/storage/database-service');

const DAY = 86400000;
const at = (iso) => Date.parse(iso);            // 测试里一律写明 +08:00，别依赖跑测试那台机器的时区
const NOW = at('2026-09-16T10:00:00+08:00');

let seq = 0;
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokermetrics-'));
    const dbPath = path.join(dir, `m${++seq}.sqlite`);
    const svc = createDatabaseService({ databasePath: dbPath, allowCreate: true });
    const raw = new Database(dbPath);

    const mkUser = (name, createdAt, { deleted = null } = {}) => {
        const u = svc.createUser(name, 'x', false, `${name}@t.local`);
        raw.prepare('UPDATE users SET created_at_ms = ?, deleted_at_ms = ? WHERE id = ?')
            .run(createdAt, deleted, u.id);
        return u.id;
    };
    const mkMatch = (id, ownerId, createdAt) => {
        raw.prepare(`INSERT INTO matches(id, room_code, room_type, status, owner_user_id, name,
            config_json, created_at_ms, updated_at_ms) VALUES (?,?,'cash','ended',?,?,'{}',?,?)`)
            .run(id, '1234', ownerId, 'room', createdAt, createdAt);
    };
    let handNo = 0;
    const mkHand = (matchId, startedAt, userIds) => {
        const id = 'h' + (++handNo);
        raw.prepare(`INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms,
            completed_at_ms, sb, bb, payload_json) VALUES (?,?,'1234',?,'cash',?,?,10,20,'{}')`)
            .run(id, matchId, handNo, startedAt, startedAt + 1000);
        userIds.forEach((uid, i) => raw.prepare(`INSERT INTO hand_players(hand_id, user_id,
            username_snapshot, seat, start_chips, end_chips, won, hole_json)
            VALUES (?,?,?,?,1000,1000,0,'[]')`).run(id, uid, 'u', i));
        return id;
    };
    const mkCheckin = (uid, dateStr, createdAt) =>
        raw.prepare(`INSERT INTO daily_checkins(user_id, checkin_date, streak, reward, created_at_ms)
            VALUES (?,?,1,200,?)`).run(uid, dateStr, createdAt);

    return { svc, raw, mkUser, mkMatch, mkHand, mkCheckin, m: svc.metrics };
}

test('🔴 日界线是显式 UTC+8，不跟跑它的那台机器的时区走', () => {
    const f = fixture();
    const owner = f.mkUser('a', at('2026-09-01T12:00:00+08:00'));
    f.mkMatch('m1', owner, at('2026-09-01T12:00:00+08:00'));
    // 北京时间 09-16 凌晨 1 点 = UTC 的 09-15 17:00。
    // 按 UTC 算会掉到 09-15 那一格 —— 迁 AWS 时差 8 小时就是这个错。
    f.mkHand('m1', at('2026-09-16T01:00:00+08:00'), [owner]);

    const rows = f.m.daily({ days: 3, now: NOW });
    const d16 = rows.find(r => r.date === '2026-09-16');
    const d15 = rows.find(r => r.date === '2026-09-15');
    assert.equal(d16.hands, 1, '凌晨那手应该算在 09-16（UTC+8）');
    assert.equal(d15.hands, 0, '不该掉到前一天去');
});

test('🔴 没有任何活动的那天必须出现、且是 0 —— 断掉的折线会被看成「还行」', () => {
    const f = fixture();
    const u = f.mkUser('a', at('2026-09-01T12:00:00+08:00'));
    f.mkMatch('m1', u, at('2026-09-01T12:00:00+08:00'));
    f.mkHand('m1', at('2026-09-16T12:00:00+08:00'), [u]);

    const rows = f.m.daily({ days: 7, now: NOW });
    assert.equal(rows.length, 7, '七天就要有七行，缺的那几天不能直接不出现');
    assert.equal(rows[0].date, '2026-09-10');
    assert.equal(rows[rows.length - 1].date, '2026-09-16', '最后一行必须是今天');
    assert.equal(rows.find(r => r.date === '2026-09-13').hands, 0);
});

test('🔴 DAU = 打牌 ∪ 签到，同一个人当天两样都干了只算一个', () => {
    const f = fixture();
    const a = f.mkUser('a', at('2026-09-01T12:00:00+08:00'));
    const b = f.mkUser('b', at('2026-09-01T12:00:00+08:00'));
    f.mkMatch('m1', a, at('2026-09-01T12:00:00+08:00'));
    f.mkHand('m1', at('2026-09-16T12:00:00+08:00'), [a]);      // a 打了牌
    f.mkCheckin(a, '2026-09-16', at('2026-09-16T09:00:00+08:00'));  // a 还签了到
    f.mkCheckin(b, '2026-09-16', at('2026-09-16T09:00:00+08:00'));  // b 只签到

    const today = f.m.daily({ days: 2, now: NOW }).find(r => r.date === '2026-09-16');
    assert.equal(today.dau, 2, 'a 被算了两次 —— 并集没去重');
    assert.equal(today.playedUsers, 1, '打牌人数要能单独看见');
    assert.equal(today.checkinUsers, 2, '签到人数要能单独看见');
});

test('🔴 cohort 还没满 N 天 → null，不是 0（0 会被读成「一个都没留下」）', () => {
    const f = fixture();
    f.mkUser('fresh', at('2026-09-16T09:00:00+08:00'));   // 今天刚注册，D1/D7 都无从谈起

    const [row] = f.m.retention({ days: 30, now: NOW });
    assert.equal(row.cohort, 1);
    assert.equal(row.retained.d1, null, '明天才知道，不能记成 0');
    assert.equal(row.retained.d7, null);
});

test('留存要真的数对：第二天回来了就算 D1 留存', () => {
    const f = fixture();
    const stay = f.mkUser('stay', at('2026-09-01T20:00:00+08:00'));
    const gone = f.mkUser('gone', at('2026-09-01T20:00:00+08:00'));
    f.mkMatch('m1', stay, at('2026-09-01T20:00:00+08:00'));
    f.mkHand('m1', at('2026-09-02T20:00:00+08:00'), [stay]);        // 次日回来
    f.mkHand('m1', at('2026-09-08T20:00:00+08:00'), [stay]);        // 第 7 天也回来

    const row = f.m.retention({ days: 30, now: NOW }).find(r => r.date === '2026-09-01');
    assert.equal(row.cohort, 2);
    assert.equal(row.retained.d1, 1, 'stay 次日回来了');
    assert.equal(row.retained.d7, 1);
});

test('🔴 注册了一手没打过 / 只玩过一天 —— 「做了没人用」最直接的两个数', () => {
    const f = fixture();
    const played = f.mkUser('played', at('2026-09-01T12:00:00+08:00'));
    f.mkUser('lurker', at('2026-09-01T12:00:00+08:00'));            // 注册了从没打过
    f.mkMatch('m1', played, at('2026-09-01T12:00:00+08:00'));
    f.mkHand('m1', at('2026-09-10T12:00:00+08:00'), [played]);      // 只在这一天打过

    const t = f.m.totals({ now: NOW });
    assert.equal(t.users, 2);
    assert.equal(t.neverPlayed, 1, 'lurker 应该被数出来');
    assert.equal(t.onlyOneDay, 1, 'played 只活跃过一天');
});

test('注销的账号不进任何分母', () => {
    const f = fixture();
    f.mkUser('alive', at('2026-09-16T09:00:00+08:00'));
    f.mkUser('bye', at('2026-09-16T09:00:00+08:00'), { deleted: NOW });

    const t = f.m.totals({ now: NOW });
    assert.equal(t.users, 1, '注销的还留在总数里');
    assert.equal(t.deletedUsers, 1);
    assert.equal(f.m.daily({ days: 1, now: NOW })[0].signups, 1, '注销的不该算作新注册');
    assert.equal(f.m.retention({ days: 3, now: NOW })[0].cohort, 1, '注销的不该进留存分母');
});

test('空库不崩，全是 0', () => {
    const f = fixture();
    const rows = f.m.daily({ days: 5, now: NOW });
    assert.equal(rows.length, 5);
    assert.ok(rows.every(r => r.dau === 0 && r.hands === 0));
    const t = f.m.totals({ now: NOW });
    assert.equal(t.users, 0);
    assert.equal(t.neverPlayed, 0);
    assert.deepEqual(f.m.retention({ now: NOW }), []);
});
