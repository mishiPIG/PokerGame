'use strict';

// 登录/注册来源（2026-09-21）。
//
// 守两类东西：
//   · 可用性 —— 记录失败绝不能连累登录（这是运营数据，不是业务数据）；
//   · 隐私 —— IP 有保留期、注销时连根拔掉。
//
// 还有一条口径问题：**同网段统计必须按「独立账号数」**，不是事件数。
// 按事件数的话，一个人登录 100 次就能把自己变成「同网段 100 个账号」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabaseService } = require('./src/storage/database-service');

let seq = 0;
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerip-'));
    const svc = createDatabaseService({
        databasePath: path.join(dir, 'e' + (++seq) + '.sqlite'), allowCreate: true });
    const mk = (name) => svc.createUser(name, 'h', false, name + '@t.local');
    return { svc, mk, le: svc.loginEvents };
}
const DAY = 86400000;

test('注册和登录都要记下来 —— 只记注册的话，存量用户的来源永远补不上', () => {
    const f = fixture();
    const u = f.mk('alice');
    f.le.record({ userId: u.id, kind: 'signup', ip: '203.0.113.9' });
    f.le.record({ userId: u.id, kind: 'login', ip: '203.0.113.10' });

    const rows = f.le.latestForUsers();
    assert.equal(rows.length, 1, '每人只取最近一条');
    assert.equal(rows[0].ip, '203.0.113.10');
    assert.equal(rows[0].ip_prefix, '203.0.113.0/24');
});

test('🔴 记录失败绝不能连累登录', () => {
    const f = fixture();
    // 不存在的 user_id → 外键失败。record 必须吞掉、返回 false，而不是抛。
    let r;
    assert.doesNotThrow(() => { r = f.le.record({ userId: 'no-such-user', kind: 'login', ip: '1.2.3.4' }); });
    assert.equal(r, false);
});

test('取不到 IP 也要记一条（人来过是事实），但不参与网段聚合', () => {
    const f = fixture();
    const u = f.mk('alice');
    f.le.record({ userId: u.id, kind: 'login', ip: null });
    const rows = f.le.latestForUsers();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ip, null);
    assert.equal(rows[0].ip_prefix, null);
    assert.deepEqual(f.le.sameNetworkCandidates(), [], 'ip 为空的不该被聚成一个网段');
});

test('🔴 同网段按【独立账号数】算，不是事件数', () => {
    const f = fixture();
    const a = f.mk('alice');
    const b = f.mk('bob');
    // alice 在同一个网段登录 50 次
    for (let i = 0; i < 50; i++) f.le.record({ userId: a.id, kind: 'login', ip: '203.0.113.9' });
    assert.deepEqual(f.le.sameNetworkCandidates(), [],
        '一个人登录 50 次被当成了 50 个账号 —— 这种清单只会制造假线索');

    // 真有第二个账号出现在同网段，才算候选
    f.le.record({ userId: b.id, kind: 'login', ip: '203.0.113.77' });
    const hits = f.le.sameNetworkCandidates();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].prefix, '203.0.113.0/24');
    assert.equal(hits[0].accounts, 2);
    assert.deepEqual(hits[0].users.map(u => u.username).sort(), ['alice', 'bob']);
});

test('🔴 IPv6 同一个 /64 下的多个账号要聚到一起', () => {
    const f = fixture();
    const a = f.mk('alice');
    const b = f.mk('bob');
    // 同一条线路、不同设备（IPv6 完整地址不同，但同 /64）
    f.le.record({ userId: a.id, kind: 'login', ip: '2001:db8:1:2:aaaa::1' });
    f.le.record({ userId: b.id, kind: 'login', ip: '2001:db8:1:2:bbbb::9' });

    const hits = f.le.sameNetworkCandidates();
    assert.equal(hits.length, 1, '按完整 IPv6 地址比对的话，这两个永远聚不到一起');
    assert.equal(hits[0].prefix, '2001:db8:1:2::/64');
    assert.equal(hits[0].accounts, 2);
});

test('地区分布按独立用户数排，未解析的归到「?」', () => {
    const f = fixture();
    const a = f.mk('alice');
    const b = f.mk('bob');
    const c = f.mk('carol');
    f.le.record({ userId: a.id, kind: 'login', ip: '1.1.1.1' });
    f.le.record({ userId: b.id, kind: 'login', ip: '1.1.1.2' });
    f.le.record({ userId: c.id, kind: 'login', ip: '8.8.8.8' });
    f.le.saveGeo([
        { ip: '1.1.1.1', country: 'CN' }, { ip: '1.1.1.2', country: 'CN' },
    ]);   // 8.8.8.8 故意不解析

    const d = f.le.distributionByCountry();
    assert.deepEqual(d.map(x => [x.country, x.users]), [['CN', 2], ['?', 1]]);
});

test('查不到的 IP 也要写进缓存，否则每次都重复去查', () => {
    const f = fixture();
    const u = f.mk('alice');
    f.le.record({ userId: u.id, kind: 'login', ip: '10.1.2.3' });
    assert.deepEqual(f.le.unresolvedIps(), ['10.1.2.3']);

    f.le.saveGeo([{ ip: '10.1.2.3', country: null }]);   // 解析不出来
    assert.deepEqual(f.le.unresolvedIps(), [],
        '🔴 查不到的没写缓存 —— 每次打开面板都会重新拉子进程查同一批');
});

test('🔴 保留期：IP 是个人数据，过期要自动清掉', () => {
    const f = fixture();
    const u = f.mk('alice');
    const now = Date.now();
    f.le.record({ userId: u.id, kind: 'login', ip: '1.1.1.1', now: now - 200 * DAY });
    f.le.record({ userId: u.id, kind: 'login', ip: '2.2.2.2', now: now - 10 * DAY });
    f.le.saveGeo([{ ip: '1.1.1.1', country: 'CN' }, { ip: '2.2.2.2', country: 'US' }]);

    assert.equal(f.le.purgeOlderThan({ days: 180, now }), 1, '应当只清掉超期的那条');
    const left = f.le.latestForUsers();
    assert.equal(left.length, 1);
    assert.equal(left[0].ip, '2.2.2.2');
    // 没有事件再引用的地理缓存也要跟着清
    assert.deepEqual(f.svc.raw.prepare('SELECT ip FROM ip_geo ORDER BY ip').all().map(r => r.ip),
        ['2.2.2.2'], '孤儿地理缓存没清 —— 那也是一条指向真人的 IP');
});

test('🔴 账号注销：来源记录连根拔掉，不能只抹 user_id 留着 IP', () => {
    const f = fixture();
    const a = f.mk('alice');
    const b = f.mk('bob');
    f.le.record({ userId: a.id, kind: 'signup', ip: '203.0.113.9' });
    f.le.record({ userId: b.id, kind: 'signup', ip: '203.0.113.10' });

    const r = f.svc.accountDeletion.anonymizeIdentity(a.id);
    assert.equal(r.ok, true);

    const rows = f.svc.raw.prepare('SELECT user_id, ip FROM login_events').all();
    assert.equal(rows.length, 1, '注销者的来源记录还在 —— 那条 IP 仍然指向一个真人');
    assert.equal(rows[0].user_id, b.id, 'bob 的记录被连累删掉了');
});

// ⬇️ 上面那条的另一半，也是它危险的地方：写进去的 null 是【永久】的。
//    所以「查不到」和「没法查」必须分开对待 —— 见下面两条。
test('🔴 缓存 null 等于永久放弃重查 —— 这正是「没法查」绝不能写缓存的原因', () => {
    const f = fixture();
    const u = f.mk('alice');
    f.le.record({ userId: u.id, kind: 'login', ip: '10.1.2.3' });

    f.le.saveGeo([{ ip: '10.1.2.3', country: null }]);
    assert.deepEqual(f.le.unresolvedIps(), []);

    // 后来地理库装上了，可这个 IP 再也不会被交给子进程去查 ——
    // 因为判据是「ip_geo 里有没有这一行」，而不是「country 是不是空」。
    f.le.record({ userId: u.id, kind: 'login', ip: '10.1.2.3' });
    assert.deepEqual(f.le.unresolvedIps(), [],
        '这条不是在要求这种行为，是在把它【钉住】：一旦写了 null 行就没有重查的机会了，'
        + '所以调用方在「库没装」时必须自己拦住，别把 null 写进来');
});

test('🔴 地理库没装时，那批 null 不许写进缓存（否则会被永久钉成「未知」）', () => {
    const src = fs.readFileSync(
        path.join(__dirname, 'src/http/register-admin-routes.js'), 'utf8');
    const call = /if\s*\(([^)]*)\)\s*db\.loginEvents\.saveGeo\(/.exec(src);
    assert.ok(call, '找不到 saveGeo 的调用 —— 这条关卡要跟着改');
    assert.match(call[1], /!\s*geoUnavailable/,
        '🔴 saveGeo 必须被 !geoUnavailable 挡住。'
        + '库没装时写进去的 null 是「没法查」，不是「查过了查不到」，'
        + '而 unresolvedIps 分不出这两者 —— 写进去就再也查不回来了。');
});
