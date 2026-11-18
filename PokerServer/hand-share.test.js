'use strict';
// 牌谱分享链接（2026-11-17）。
//
// 🔴 这里最怕的不是「分享不了」，而是【分享出去的东西比该给的多】：
//    链接谁都能看、还可能被转来转去，所以只许出现分享人当时在牌桌上看得见的东西。
//    断言大多从「陌生人拿到这个链接能看到什么」这个角度写。
// 真库（临时文件）+ 真路由处理器。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabaseService } = require('./src/storage/database-service');
const { registerAccountRoutes } = require('./src/http/register-account-routes');
const { publicHandView } = require('./src/games/poker/public-hand');

function tempDb(t) {
    const file = path.join(os.tmpdir(), `share-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = createDatabaseService({ databasePath: file, allowCreate: true });
    t.after(() => { try { db.close?.(); } catch { /* */ } for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true }); });
    return db;
}
const raw = (db) => require('better-sqlite3')(db.databasePath);

// 三人一手：A 弃牌（拿着 KK，从没亮过），B 和 C 走到摊牌。桌子【已经散了】——
// 对同桌人来说散了就一切公开（为了可验证公平），但对拿到链接的陌生人不是。
function handPayload(ids) {
    const [a, b, c] = ids;
    return {
        ts: Date.now(), matchId: 'm-secret', roomId: '987654', mode: 'cash', handSeq: 7, sb: 10, bb: 20, ante: 0,
        buttonUserId: a,
        seats: [
            { userId: a, username: 'Alice', seat: 0, avatar: null, startChips: 1000, hole: ['KS', 'KH'] },
            { userId: b, username: 'Bob', seat: 1, avatar: null, startChips: 1000, hole: ['7H', '7D'] },
            { userId: c, username: 'Cara', seat: 2, avatar: null, startChips: 1000, hole: ['AH', 'QD'] },
        ],
        actions: [
            { userId: a, street: 'preflop', action: 'fold', amount: 0 },
            { userId: b, street: 'preflop', action: 'call', amount: 20 },
            { userId: c, street: 'preflop', action: 'check', amount: 20 },
        ],
        community: ['2S', '7C', '9D', 'JH', '3C'],
        results: [
            { userId: a, won: 0, endChips: 1000, category: 'One Pair', folded: true },
            { userId: b, won: 40, endChips: 1020, category: 'Three of a Kind', folded: false },
            { userId: c, won: 0, endChips: 980, category: 'High Card', folded: false },
        ],
        fair: { commit: 'c0ffee', serverSeed: 'SEED-SECRET', clientSeed: '987654', nonce: 7, deckOrder: ['KS', 'KH', '7H'] },
    };
}

function seed(db) {
    const users = ['alice', 'bob', 'cara', 'dave'].map(n => db.createUser(n, 'h', false, n + '@example.com'));
    const [a, b, c] = users;
    const h = raw(db);
    try {
        const now = Date.now();
        h.prepare(`INSERT INTO matches(id, room_code, room_type, status, owner_user_id, name, config_json, created_at_ms, updated_at_ms, ended_at_ms)
            VALUES ('m-secret','987654','cash','ended',?, 'r','{}',?,?,?)`).run(a.id, now, now, now);
        h.prepare(`INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms, completed_at_ms, sb, bb, payload_json)
            VALUES ('hand-1','m-secret','987654',7,'cash',?,?,10,20,?)`).run(now, now, JSON.stringify(handPayload([a.id, b.id, c.id])));
        [a, b, c].forEach((u, i) => h.prepare(`INSERT INTO hand_players(hand_id, user_id, username_snapshot, seat, start_chips, end_chips, won, hole_json)
            VALUES ('hand-1',?,?,?,1000,1000,0,'[]')`).run(u.id, u.username, i));
    } finally { h.close(); }
    return users;
}

// ───────────── 看得见什么 ─────────────

test('🔴 陌生人只看得见分享人当时看得见的：弃牌者的底牌和牌型都不在（哪怕桌子已经散了）', () => {
    const ids = ['ua', 'ub', 'uc'];
    const pub = publicHandView(handPayload(ids), 'ub');   // Bob 分享
    const seatOf = (name) => pub.seats.find(s => s.username === name);
    assert.equal(seatOf('Alice').hole, undefined, 'Alice 弃牌、从没亮过 KK');
    assert.deepEqual(seatOf('Bob').hole, ['7H', '7D'], '分享人自己的牌');
    assert.deepEqual(seatOf('Cara').hole, ['AH', 'QD'], '摊牌时亮出来的牌');
    const aliceRes = pub.results.find(r => r.userId === seatOf('Alice').userId);
    assert.equal(aliceRes.category, undefined, '牌型是从底牌算出来的，留着等于泄露一半');
    const text = JSON.stringify(pub);
    assert.ok(!text.includes('KS') && !text.includes('KH'), '整份数据里不该出现 Alice 的牌：' + text);
});

test('🔴 种子和牌序整段不给（知道种子就能重算整副牌）；房间号、比赛 id 也不给', () => {
    const pub = publicHandView(handPayload(['ua', 'ub', 'uc']), 'ub');
    const text = JSON.stringify(pub);
    assert.equal(pub.fair, undefined);
    assert.ok(!text.includes('SEED-SECRET') && !text.includes('deckOrder'));
    assert.ok(!text.includes('987654') && !text.includes('m-secret'), '私密桌的房间号不该随链接流出去：' + text);
});

test('🔴 内部 userId 一个都不出现，换成 p1/p2…；回放从分享人的视角看', () => {
    const ids = ['3f2a-uuid-alice', '9b1c-uuid-bob', '77aa-uuid-cara'];
    const pub = publicHandView(handPayload(ids), ids[1]);
    const text = JSON.stringify(pub);
    for (const id of ids) assert.ok(!text.includes(id), '泄露了 ' + id);
    assert.equal(pub.heroId, 'p2');
    assert.equal(pub.buttonUserId, 'p1', '引用 userId 的其他字段也一起换掉了');
    assert.deepEqual(pub.actions.map(a => a.userId), ['p1', 'p2', 'p3']);
    assert.equal(pub.shared, true);
});

test('分享人自己弃了牌：他自己的牌照样亮（是他的牌），别人照样盖着', () => {
    const pub = publicHandView(handPayload(['ua', 'ub', 'uc']), 'ua');   // Alice 分享（她弃牌了）
    assert.deepEqual(pub.seats[0].hole, ['KS', 'KH']);
    assert.equal(pub.heroId, 'p1');
});

// ───────────── 谁能生成、链接什么时候失效 ─────────────

test('只有打过这一手的人能生成链接；同一个人同一手永远是同一个链接；链接猜不到', (t) => {
    const db = tempDb(t);
    const [a, b, , dave] = seed(db);
    assert.equal(db.handShares.createShare('hand-1', dave.id), null, 'Dave 没打这一手');
    assert.equal(db.handShares.createShare('no-such-hand', a.id), null);
    const t1 = db.handShares.createShare('hand-1', a.id);
    assert.match(t1, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(db.handShares.createShare('hand-1', a.id), t1, '同一个人再点一次拿回同一个链接');
    assert.notEqual(db.handShares.createShare('hand-1', b.id), t1, '不同的人各自一个');
    assert.equal(db.handShares.getShared('not-a-real-token-xx'), null);
    assert.equal(db.handShares.getShared('../../etc'), null, '格式不对的直接拒绝，不进 SQL');
});

test('🔴 分享人注销账号 → 他的链接全部作废', (t) => {
    const db = tempDb(t);
    const [a] = seed(db);
    const tok = db.handShares.createShare('hand-1', a.id);
    assert.ok(db.handShares.getShared(tok));
    const r = db.accountDeletion.anonymizeIdentity(a.id);
    assert.equal(r.ok, true);
    assert.equal(db.handShares.getShared(tok), null);
    // 读的时候本来就会跳过已注销的人 —— 只看上面那条断言，撤掉删除那一步也照样绿。
    // 所以再直接查一次表：行本身必须没了（链接里有他的底牌，不该留着）。
    const h = raw(db);
    try { assert.equal(h.prepare('SELECT COUNT(*) n FROM hand_shares WHERE user_id = ?').get(a.id).n, 0); } finally { h.close(); }
});

// ───────────── 真路由 ─────────────

function routes(db) {
    const handlers = {};
    const app = { get: (p, ...fns) => { handlers['GET ' + p] = fns; }, post: (p, ...fns) => { handlers['POST ' + p] = fns; } };
    const requireAuth = (req, res, next) => (req.authUser ? next() : res.status(401).json({ error: 'auth' }));
    registerAccountRoutes({ app, db, stats: {}, mailer: {}, requireAuth, requireAdmin: requireAuth, bcrypt: {}, roomGames: {}, io: {} });
    return async (key, req) => {
        const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        const fns = handlers[key];
        let i = 0;
        const next = () => { const fn = fns[i++]; if (fn) return fn(req, res, next); };
        await next();
        return res;
    };
}

test('路由：没登录不能生成；不是这一手的玩家 404；生成的链接不登录也能看，看到的是过滤过的', async (t) => {
    const db = tempDb(t);
    const [a, b, , dave] = seed(db);
    const call = routes(db);
    assert.equal((await call('POST /api/hands/share', { body: { handId: 'hand-1' } })).code, 401);
    const nope = await call('POST /api/hands/share', { authUser: dave, body: { handId: 'hand-1' } });
    assert.equal(nope.code, 404);
    assert.equal(nope.body.k, 'shareNotFound');
    const ok = await call('POST /api/hands/share', { authUser: b, body: { handId: 'hand-1' } });
    assert.equal(ok.code, 200);
    const seen = await call('GET /api/shared-hand/:token', { params: { token: ok.body.token } });   // 不带 authUser
    assert.equal(seen.code, 200);
    const text = JSON.stringify(seen.body.hand);
    assert.ok(!text.includes('KS') && !text.includes(a.id) && !text.includes('SEED-SECRET'), text);
    assert.equal(seen.body.hand.heroId, 'p2', 'Bob 分享的，从 Bob 的视角看');
    const gone = await call('GET /api/shared-hand/:token', { params: { token: 'xxxxxxxxxxxxxxxx' } });
    assert.equal(gone.code, 404);
    assert.equal(gone.body.k, 'shareGone');
});

test('我的牌谱列表带上库里的 id（分享时用），过滤规则不变', (t) => {
    const db = tempDb(t);
    const [, b] = seed(db);
    const [hand] = db.getHandsForUser(b.id);
    assert.equal(hand.handId, 'hand-1');
    assert.equal(hand.seats.length, 3);
});

// ───────────── 分享带来的新人（运营漏斗）─────────────

test('分享来源：只认真实存在的分享；带来的号打过牌 / 转正都数得到；运营数字算得对', (t) => {
    const db = tempDb(t);
    const [a] = seed(db);
    const tok = db.handShares.createShare('hand-1', a.id);
    db.handShares.getShared(tok); db.handShares.getShared(tok);          // 被打开两次

    const g1 = db.createGuest('New1');
    const g2 = db.createGuest('New2');
    const reg = db.createUser('newbie', 'h', false, 'newbie@example.com');
    assert.equal(db.handShares.recordSignup(tok, g1.id, 'guest'), true);
    assert.equal(db.handShares.recordSignup(tok, g2.id, 'guest'), true);
    assert.equal(db.handShares.recordSignup(tok, reg.id, 'register'), true);
    // 🔴 编一个 token / 乱填 kind / 怪格式：一律不记（别让人随手往运营数字里灌水）
    assert.equal(db.handShares.recordSignup('NotARealToken123', g1.id, 'guest'), false);
    assert.equal(db.handShares.recordSignup(tok, g1.id, 'admin'), false);
    assert.equal(db.handShares.recordSignup('<script>', g1.id, 'guest'), false);
    assert.equal(db.handShares.recordSignup({ toString: 1 }, g1.id, 'guest'), false);

    // g1 打了一手，g2 什么都没做；reg 本来就是正式账号
    const h = raw(db);
    try {
        h.prepare(`INSERT INTO hand_players(hand_id, user_id, username_snapshot, seat, start_chips, end_chips, won, hole_json)
            VALUES ('hand-1',?,?,5,1000,1000,0,'[]')`).run(g1.id, g1.username);
    } finally { h.close(); }
    db.upgradeGuest(g1.id, { username: 'g1saved', email: 'g1@example.com', passwordHash: 'h' });

    const m = db.metrics.totals();
    assert.equal(m.sharesCreated, 1);
    assert.equal(m.shareViews, 2);
    assert.equal(m.shareArrivals, 3);
    assert.equal(m.shareArrivalsPlayed, 1, '只有 g1 打过牌');
    assert.equal(m.shareArrivalsSaved, 2, 'g1 转正 + reg 直接注册');
});

test('🔴 带来的游客被清理 / 注销：清理不被外键挡住，「带来过几个人」不会自己变小，注销后不再指向那个人', (t) => {
    const db = tempDb(t);
    const [a] = seed(db);
    const tok = db.handShares.createShare('hand-1', a.id);
    const DAY = 86400000;
    const stale = db.createGuest('Stale', { createdAtMs: Date.now() - 8 * DAY });
    const quitter = db.createUser('quitter', 'h', false, 'q@example.com');
    db.handShares.recordSignup(tok, stale.id, 'guest');
    db.handShares.recordSignup(tok, quitter.id, 'register');

    const errors = [];
    const origError = console.error;
    console.error = (...x) => errors.push(x.join(' '));
    t.after(() => { console.error = origError; });
    assert.equal(db.purgeStaleGuests(), 1);
    console.error = origError;
    assert.deepEqual(errors, [], '清理一手没打的游客，不该被 share_signups 挡回来');

    assert.equal(db.accountDeletion.anonymizeIdentity(quitter.id).ok, true);
    const h = raw(db);
    try {
        assert.equal(h.prepare('SELECT COUNT(*) n FROM share_signups WHERE user_id = ?').get(quitter.id).n, 0, '注销后不再记着是谁');
    } finally { h.close(); }
    assert.equal(db.metrics.totals().shareArrivals, 2, '两行都还在：进来过两个人这件事没变');

    // 分享人自己注销：他的链接删掉，带来的记录不受影响（也没被外键挡住）
    assert.equal(db.accountDeletion.anonymizeIdentity(a.id).ok, true);
    assert.equal(db.metrics.totals().shareArrivals, 2);
});
