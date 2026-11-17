'use strict';
// 游客账号（2026-11-17）：只填昵称就能进来打牌，之后可以「保存账号」转成正式账号。
//
// 这里最怕出错的是【保存账号】那一步，所以大部分断言都围着它：
//   · 账号还是同一个（id 不变），金币 / 牌谱 / 流水一样都不动
//   · 正式账号不能走这条路（否则就是不用输旧密码的改密后门）
//   · 半路失败（用户名被抢）时游客那一行原样不动
// 能跑真模块的都跑真模块：真库（临时文件）、真路由处理器、真 bcrypt / jwt。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createDatabaseService } = require('./src/storage/database-service');
const { createAuth } = require('./src/auth');
const { registerAuthRoutes } = require('./src/http/register-auth-routes');
const { refreshLiveUser } = require('./src/account/live-user');
const { liveUserIds } = require('./src/ops/startup-tasks');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const DAY = 86400000;

function tempDb(t) {
    const file = path.join(os.tmpdir(), `guest-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = createDatabaseService({ databasePath: file, allowCreate: true });
    t.after(() => { try { db.close?.(); } catch { /* 无所谓 */ } for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true }); });
    return db;
}
const raw = (db) => require('better-sqlite3')(db.databasePath);

// 往库里塞一手「这个人打过」的牌（最小字段），用来验证打过牌的游客不会被清理
function giveHand(db, userId) {
    // 牌局挂在另一个人（正式账号）开的房间下：这样被测的那个人只在 hand_players 里留痕
    const host = db.getUserByUsername('tablehost') || db.createUser('tablehost', 'h', false, 'tablehost@example.com');
    const h = raw(db);
    try {
        const now = Date.now();
        const matchId = 'match-' + Math.random().toString(36).slice(2);
        const handId = 'hand-' + Math.random().toString(36).slice(2);
        h.prepare(`INSERT INTO matches(id, room_code, room_type, status, owner_user_id, name,
            config_json, created_at_ms, updated_at_ms) VALUES (?,?,'cash','ended',?,?,'{}',?,?)`)
            .run(matchId, '1234', host.id, 'room', now, now);
        h.prepare(`INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms,
            completed_at_ms, sb, bb, payload_json) VALUES (?,?,'1234',1,'cash',?,?,10,20,'{}')`)
            .run(handId, matchId, now, now + 1000);
        h.prepare(`INSERT INTO hand_players(hand_id, user_id, username_snapshot, seat, start_chips, end_chips, won, hole_json)
            VALUES (?,?,?,0,1000,1000,0,'[]')`).run(handId, userId, 'u');
    } finally { h.close(); }
}

// ───────────────────────── 账号层 ─────────────────────────

test('游客是一行正式的用户记录：有金币、有开户流水、有牌友号，只是带着游客标记', (t) => {
    const db = tempDb(t);
    const g = db.createGuest('River47');
    assert.equal(g.isGuest, true);
    assert.equal(g.displayName, 'River47');
    assert.match(g.username, /^guest_[a-z2-9]{10}$/);
    assert.equal(g.gold, 10000);
    assert.equal(g.email, null);
    assert.match(g.friendCode, /^\d{8}$/);
    const tx = db.wallet.listForUser ? null : null;   // 流水用原始查询看，不依赖仓库有没有这个方法
    void tx;
    const h = raw(db);
    try {
        const rows = h.prepare('SELECT transaction_type, delta, balance_after FROM wallet_transactions WHERE user_id = ?').all(g.id);
        assert.deepEqual(rows, [{ transaction_type: 'initial_balance', delta: 10000, balance_after: 10000 }]);
    } finally { h.close(); }
});

test('🔴 保存账号：还是同一个账号 —— id、金币、显示名、牌友号、流水都不动，只补身份', (t) => {
    const db = tempDb(t);
    const g = db.createGuest('River47');
    giveHand(db, g.id);
    const u = db.upgradeGuest(g.id, { username: 'bob', email: 'Bob@Example.com', passwordHash: 'HASH' });
    assert.equal(u.id, g.id, 'id 一变，钱包 / 牌谱 / 战绩就全断了');
    assert.equal(u.isGuest, false);
    assert.equal(u.username, 'bob');
    assert.equal(u.email, 'bob@example.com');
    assert.equal(u.password_hash, 'HASH');
    assert.equal(u.gold, g.gold);
    assert.equal(u.displayName, 'River47', '昵称是他自己起的，保存账号不该把它改成用户名');
    assert.equal(u.friendCode, g.friendCode);
    assert.ok(u.upgradedAtMs > 0);
    const h = raw(db);
    try {
        assert.equal(h.prepare('SELECT COUNT(*) AS n FROM hand_players WHERE user_id = ?').get(g.id).n, 1, '牌谱还挂在他名下');
        assert.equal(h.prepare('SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = ?').get(g.id).n, 1, '没有多出或少掉流水');
        assert.equal(h.prepare("SELECT COUNT(*) AS n FROM users WHERE username != 'tablehost'").get().n, 1, '没有新建第二行');
    } finally { h.close(); }
    assert.equal(db.getUserByUsername('bob').id, g.id);
    assert.equal(db.getUserByEmail('bob@example.com').id, g.id);
});

test('🔴 正式账号不能被「保存账号」改写（否则是不用输旧密码的改密后门）', (t) => {
    const db = tempDb(t);
    const alice = db.createUser('alice', 'REAL-HASH', false, 'alice@example.com');
    assert.equal(db.upgradeGuest(alice.id, { username: 'evil', email: 'evil@example.com', passwordHash: 'EVIL' }), null);
    const after = db.getUserById(alice.id);
    assert.equal(after.username, 'alice');
    assert.equal(after.email, 'alice@example.com');
    assert.equal(after.password_hash, 'REAL-HASH');
    // 转正过一次的号同样不能再来一次
    const g = db.createGuest('Once');
    assert.ok(db.upgradeGuest(g.id, { username: 'once', email: 'once@example.com', passwordHash: 'H1' }));
    assert.equal(db.upgradeGuest(g.id, { username: 'twice', email: 'twice@example.com', passwordHash: 'H2' }), null);
    assert.equal(db.getUserById(g.id).password_hash, 'H1');
});

test('保存账号时用户名 / 邮箱被占：报错，游客那一行原样不动', (t) => {
    const db = tempDb(t);
    db.createUser('alice', 'h', false, 'alice@example.com');
    const g = db.createGuest('Guest1');
    assert.throws(() => db.upgradeGuest(g.id, { username: 'ALICE', email: 'new@example.com', passwordHash: 'h' }), /UNIQUE/);
    assert.throws(() => db.upgradeGuest(g.id, { username: 'fresh', email: 'Alice@example.com', passwordHash: 'h' }), /EMAIL/);
    const still = db.getUserById(g.id);
    assert.equal(still.isGuest, true);
    assert.equal(still.username, g.username);
    assert.equal(still.email, null);
    assert.equal(still.upgradedAtMs, null);
});

test('清理：只删「超过 7 天、什么都没留下」的游客', (t) => {
    const db = tempDb(t);
    const old = { createdAtMs: Date.now() - 8 * DAY };
    const stale = db.createGuest('Stale', old);
    const fresh = db.createGuest('Fresh');
    const played = db.createGuest('Played', old); giveHand(db, played.id);
    const online = db.createGuest('Online', old);
    const saved = db.createGuest('Saved', old);
    db.upgradeGuest(saved.id, { username: 'saved', email: 'saved@example.com', passwordHash: 'h' });
    const member = db.createUser('member', 'h', false, 'm@example.com', old);
    const bought = db.createGuest('Bought', old);
    db.wallet.adjust({ userId: bought.id, delta: -1100, type: 'cash_buyin', operationKey: 'k1', metadata: {} });
    db.loginEvents.record({ userId: stale.id, kind: 'signup', ip: '203.0.113.9' });

    // 清理过程里不许有「删到一半被外键挡回来」：那说明判据放过了不该选中的人，只是数据库替我们兜住了。
    // （反向对照时发现的：把「打过牌不删」那条判据撤掉，人照样删不掉 —— 是外键拦的，测试原来看不出区别。）
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    t.after(() => { console.error = origError; });
    assert.equal(db.purgeStaleGuests({ skip: new Set([online.id]) }), 1);
    console.error = origError;
    assert.deepEqual(errors, [], '判据本身就该把这些人排除，而不是靠外键报错');
    assert.equal(db.getUserById(stale.id), null, '过期且干净的游客删掉');
    assert.ok(db.getUserById(fresh.id), '没到 7 天的不删');
    assert.ok(db.getUserById(played.id), '🔴 打过牌的不删：牌局是同桌几个人共同的记录');
    assert.ok(db.getUserById(online.id), '🔴 此刻在线 / 在牌桌上的不删：筹码还在内存里');
    assert.ok(db.getUserById(saved.id), '已经保存成正式账号的不删');
    assert.ok(db.getUserById(member.id), '正式账号永远不归这条清理管');
    assert.ok(db.getUserById(bought.id), '有过买入流水的不删：流水是审计的证据链');

    const h = raw(db);
    try {
        assert.equal(h.prepare('SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = ?').get(stale.id).n, 0);
        assert.equal(h.prepare('SELECT COUNT(*) AS n FROM login_events WHERE user_id = ?').get(stale.id).n, 0, 'IP 记录一起删');
        assert.deepEqual(h.prepare('PRAGMA foreign_key_check').all(), [], '没有留下指向已删用户的孤儿行');
    } finally { h.close(); }
    assert.equal(db.purgeStaleGuests({ skip: new Set([online.id]) }), 0, '再跑一次没有东西可删');
});

test('清理要跳过的人：连着的、坐着的、站起围观的、房主', () => {
    const io = { sockets: { sockets: new Map([['s1', { user: { id: 'connected' } }], ['s2', {}]]) } };
    const roomGames = { r1: { ownerUserId: 'owner', players: [{ userId: 'seated' }], vacatedPlayers: [{ userId: 'standing' }] } };
    assert.deepEqual([...liveUserIds({ io, roomGames })].sort(), ['connected', 'owner', 'seated', 'standing']);
    assert.deepEqual([...liveUserIds({})], []);
});

test('运营指标：「用户」不含游客，游客漏斗单独给；被清理的游客仍计入「累计建过」', (t) => {
    const db = tempDb(t);
    db.createUser('alice', 'h', false, 'a@example.com');
    const g1 = db.createGuest('G1'); giveHand(db, g1.id);
    const g2 = db.createGuest('G2');
    db.upgradeGuest(g2.id, { username: 'g2', email: 'g2@example.com', passwordHash: 'h' });
    db.createGuest('G3', { createdAtMs: Date.now() - 8 * DAY });
    assert.equal(db.purgeStaleGuests(), 1);

    const tt = db.metrics.totals();
    assert.equal(tt.users, 3, 'alice + 已保存账号的 g2 + 开桌的 tablehost；游客不算用户');
    assert.equal(tt.neverPlayed, 3, '「从没打过牌」也只数正式账号（打过牌的 G1 是游客，不在这个数里）');
    assert.equal(tt.guests, 1);
    assert.equal(tt.guestsPlayed, 1);
    assert.equal(tt.guestsUpgraded, 1);
    assert.equal(tt.guestsCreated, 3, '🔴 G3 已经整行删了，但「来过」这件事还数得出来');
    const today = db.metrics.daily({ days: 1 })[0];
    assert.equal(today.guests, 2);
    assert.equal(today.signups, 3, '当天的新注册不含还是游客的那些');
});

test('在牌桌上保存账号：内存里认识他的地方一起改，筹码和座位不碰', () => {
    const user = { id: 'u1', username: 'bob', email: 'bob@example.com', isGuest: false, upgradedAtMs: 5 };
    const sockUser = { id: 'u1', username: 'guest_abc', isGuest: true, gold: 777 };
    const other = { id: 'u2', username: 'guest_zzz', isGuest: true };
    const io = { sockets: { sockets: new Map([['a', { user: sockUser }], ['b', { user: other }]]) } };
    const seat = { userId: 'u1', username: 'guest_abc', displayName: 'River47', chips: 4200, seat: 3 };
    const roomGames = { r: { players: [seat, { userId: 'u2', username: 'guest_zzz', chips: 1 }], vacatedPlayers: [], statsHistory: [{ userId: 'u1', username: 'guest_abc', net: -50 }] } };
    refreshLiveUser({ io, roomGames, user });
    assert.equal(sockUser.isGuest, false, '不用断线重连就能用牌友 / 签到');
    assert.equal(sockUser.username, 'bob');
    assert.equal(sockUser.gold, 777, '只改身份字段');
    assert.deepEqual(seat, { userId: 'u1', username: 'bob', displayName: 'River47', chips: 4200, seat: 3 });
    assert.equal(roomGames.r.statsHistory[0].username, 'bob');
    assert.equal(other.isGuest, true, '别人不受影响');
    assert.equal(roomGames.r.players[1].username, 'guest_zzz');
});

// ───────────────────────── 接口（真处理器，假 req / res）─────────────────────────

function harness(t, { now } = {}) {
    const db = tempDb(t);
    const auth = createAuth({ db, jwt, jwtSecret: 'test-secret' });
    const routes = {};
    const app = { post: (p, ...h) => { routes['POST ' + p] = h; }, get: (p, ...h) => { routes['GET ' + p] = h; } };
    const sent = [];
    const mailer = { sendCode: async (email, code, kind) => { sent.push({ email, code, kind }); }, isConfigured: () => true };
    const io = { sockets: { sockets: new Map() } };
    const roomGames = {};
    registerAuthRoutes({ app, db, bcrypt, mailer, signToken: auth.signToken, userPayload: auth.userPayload, requireAuth: auth.requireAuth, io, roomGames });
    void now;
    async function call(route, body, { token, ip = '198.51.100.7' } = {}) {
        const req = { body, headers: token ? { authorization: 'Bearer ' + token } : {}, socket: { remoteAddress: ip } };
        const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; this.done = true; return this; } };
        for (const h of routes[route]) {
            let nexted = false;
            await h(req, res, () => { nexted = true; });
            if (res.done || !nexted) break;
        }
        return res;
    }
    return { db, call, sent, io, roomGames, auth };
}

test('POST /api/guest：一个昵称就建好号并拿到令牌；昵称不合规被拒', async (t) => {
    const { db, call } = harness(t);
    const r = await call('POST /api/guest', { name: '  同花47 ' });
    assert.equal(r.code, 200);
    assert.equal(r.data.user.isGuest, true);
    assert.equal(r.data.user.displayName, '同花47');
    const payload = jwt.verify(r.data.token, 'test-secret');
    assert.equal(payload.isGuest, true);
    assert.ok(payload.exp - payload.iat > 300 * 86400, '🔴 游客令牌要长：他没有密码，令牌过期就等于丢号');
    assert.ok(db.getUserById(r.data.user.id));
    for (const bad of ['', 'a', '<b>x</b>', 'admin', { toString: 1 }, 'x'.repeat(17)]) {
        const b = await call('POST /api/guest', { name: bad });
        assert.equal(b.code, 400, JSON.stringify(bad));
        assert.equal(b.data.k, 'nameFormat');
    }
    // 正式账号的令牌仍是 30 天
    const member = db.createUser('alice', 'h', false, 'a@example.com');
    const mp = jwt.verify(createAuth({ db, jwt, jwtSecret: 'test-secret' }).signToken(member), 'test-secret');
    assert.ok(mp.exp - mp.iat <= 31 * 86400);
});

test('🔴 同一网络一小时最多建 20 个游客号，别的网络不受影响', async (t) => {
    const { call } = harness(t);
    for (let i = 0; i < 20; i++) assert.equal((await call('POST /api/guest', { name: 'Guest' + i })).code, 200);
    const blocked = await call('POST /api/guest', { name: 'Guest21' });
    assert.equal(blocked.code, 429);
    assert.equal(blocked.data.k, 'guestTooMany');
    assert.equal((await call('POST /api/guest', { name: 'Elsewhere' }, { ip: '203.0.113.50' })).code, 200);
});

test('游客号不能用「用户名 + 密码」登录', async (t) => {
    const { db, call } = harness(t);
    const g = db.createGuest('River47');
    for (const pwd of ['guest-account', '', 'anything']) {
        const r = await call('POST /api/login', { username: g.username, password: pwd || 'x' });
        assert.equal(r.code, 401);
        assert.equal(r.data.k, 'badLogin', '和「账号不存在」回一样的话，不泄露这是个游客号');
    }
    // 就算哪天游客那一行里真有了一个能比中的密码哈希，登录接口也不放行：
    // 「游客不能用密码登录」不该只靠「占位串恰好不是合法哈希」这件事撑着。
    const h = raw(db);
    try { h.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash('known-pwd', 4), g.id); }
    finally { h.close(); }
    assert.equal((await call('POST /api/login', { username: g.username, password: 'known-pwd' })).code, 401);
});

test('🔴 保存账号全流程：发码 → 验码 → 同一个账号变成正式账号，之后能用密码登录', async (t) => {
    const { db, call, sent, io, roomGames } = harness(t);
    const g = (await call('POST /api/guest', { name: 'River47' })).data;
    db.wallet.adjust({ userId: g.user.id, delta: -1100, type: 'cash_buyin', operationKey: 'buy1', metadata: {} });
    // 他此刻连着、还坐在一张桌上
    const sockUser = { ...db.getUserById(g.user.id) };
    io.sockets.sockets.set('s', { user: sockUser });
    roomGames.r = { players: [{ userId: g.user.id, username: sockUser.username, chips: 11000 }] };

    const s1 = await call('POST /api/guest/upgrade/send-code', { username: 'bob', email: 'Bob@Example.com', password: 'secret1' }, { token: g.token });
    assert.equal(s1.code, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].email, 'bob@example.com');
    assert.equal(db.getUserById(g.user.id).isGuest, true, '只发了验证码，还没验 —— 账号不该有任何变化');

    const wrong = await call('POST /api/guest/upgrade/verify', { code: '000000' === sent[0].code ? '111111' : '000000' }, { token: g.token });
    assert.equal(wrong.code, 400);
    assert.equal(db.getUserById(g.user.id).isGuest, true);

    const ok = await call('POST /api/guest/upgrade/verify', { code: sent[0].code }, { token: g.token });
    assert.equal(ok.code, 200);
    assert.equal(ok.data.user.id, g.user.id, '🔴 还是同一个账号');
    assert.equal(ok.data.user.isGuest, false);
    assert.equal(ok.data.user.username, 'bob');
    assert.equal(ok.data.user.gold, 8900, '金币原样（开户 10000 − 买入 1100）');
    assert.equal(jwt.verify(ok.data.token, 'test-secret').isGuest, false);
    assert.equal(sockUser.isGuest, false, '在线连接上的身份一起改了');
    assert.equal(roomGames.r.players[0].username, 'bob');
    assert.equal(roomGames.r.players[0].chips, 11000, '桌上的筹码不碰');

    const login = await call('POST /api/login', { username: 'bob@example.com', password: 'secret1' });
    assert.equal(login.code, 200);
    assert.equal(login.data.user.id, g.user.id);
    // 旧的游客令牌还认得这个账号（同一个 id），但已经不是游客，不能再走一次保存
    const again = await call('POST /api/guest/upgrade/send-code', { username: 'bob2', email: 'bob2@example.com', password: 'secret2' }, { token: g.token });
    assert.equal(again.code, 403);
    assert.equal(again.data.k, 'notGuest');
});

test('🔴 正式账号拿着令牌调「保存账号」两个接口都被拒，资料一个字不变', async (t) => {
    const { db, call, auth, sent } = harness(t);
    const alice = db.createUser('alice', await bcrypt.hash('alicepwd', 4), false, 'alice@example.com');
    const token = auth.signToken(alice);
    const a = await call('POST /api/guest/upgrade/send-code', { username: 'evil', email: 'evil@example.com', password: 'evilpwd' }, { token });
    assert.equal(a.code, 403);
    assert.equal(a.data.k, 'notGuest');
    assert.equal(sent.length, 0, '连验证码都不该发');
    const b = await call('POST /api/guest/upgrade/verify', { code: '123456' }, { token });
    assert.equal(b.code, 403);
    const after = db.getUserById(alice.id);
    assert.equal(after.username, 'alice');
    assert.equal(after.email, 'alice@example.com');
    assert.equal((await call('POST /api/login', { username: 'alice', password: 'alicepwd' })).code, 200, '原密码照常能登');
    // 没登录更不行
    assert.equal((await call('POST /api/guest/upgrade/send-code', { username: 'x1', email: 'x@example.com', password: 'secret1' })).code, 401);
});

test('保存账号的资料校验和注册是同一套；发码到验码之间用户名被抢 → 报错且仍是游客', async (t) => {
    const { db, call, sent } = harness(t);
    db.createUser('taken', 'h', false, 'taken@example.com');
    const g = (await call('POST /api/guest', { name: 'River47' })).data;
    const cases = [
        [{ username: 'a', email: 'a@example.com', password: 'secret1' }, 'nameLen'],
        [{ username: 'x<y', email: 'a@example.com', password: 'secret1' }, 'nameChars'],
        [{ username: 'Guest_me', email: 'a@example.com', password: 'secret1' }, 'nameReserved'],
        [{ username: 'fine', email: 'not-an-email', password: 'secret1' }, 'badEmail'],
        [{ username: 'fine', email: 'a@example.com', password: '123' }, 'pwdShort'],
        [{ username: 'TAKEN', email: 'a@example.com', password: 'secret1' }, 'nameTaken'],
        [{ username: 'fine', email: 'Taken@example.com', password: 'secret1' }, 'emailTakenHint'],
        [{ username: { toString: 1 }, email: [], password: 5 }, 'signupFields'],
    ];
    for (const [body, k] of cases) {
        const r = await call('POST /api/guest/upgrade/send-code', body, { token: g.token });
        assert.equal(r.data.k, k, JSON.stringify(body));
        // 注册接口对同样的输入给同样的结论
        assert.equal((await call('POST /api/register/send-code', body)).data.k, k, '注册：' + JSON.stringify(body));
    }
    assert.equal(sent.length, 0);

    assert.equal((await call('POST /api/guest/upgrade/send-code', { username: 'racer', email: 'racer@example.com', password: 'secret1' }, { token: g.token })).code, 200);
    db.createUser('racer', 'h', false, 'someone@example.com');     // 验码之前被别人抢注
    const v = await call('POST /api/guest/upgrade/verify', { code: sent[0].code }, { token: g.token });
    assert.equal(v.code, 409);
    assert.equal(v.data.k, 'nameTaken');
    const still = db.getUserById(g.user.id);
    assert.equal(still.isGuest, true);
    assert.equal(still.email, null);
});

// ───────────────────────── 限制与提醒（结构关卡）─────────────────────────

test('🔴 游客用不了的功能，服务端每一处都真的拦了（界面藏按钮不算数）', () => {
    const account = codeOf(read('src/http/register-account-routes.js'));
    assert.match(account, /app\.post\('\/api\/checkin', requireAuth, \(req, res\) => \{\s*const u = req\.authUser;\s*if \(u\.isGuest\) return res\.status\(403\)\.json\(NEED_ACCOUNT\)/, '签到');
    assert.match(account, /app\.post\('\/api\/feedback', requireAuth, \(req, res\) => \{\s*if \(req\.authUser\.isGuest\) return res\.status\(403\)\.json\(NEED_ACCOUNT\)/, '反馈');
    assert.match(codeOf(read('src/voice/voice-module.js')), /app\.post\('\/api\/voice', requireAuth, membersOnly, voiceUploadGate/, '语音：先拦游客，再占上传名额');
    const friends = codeOf(read('src/socket/events/friend-events.js'));
    for (const ev of ['friend_search', 'friend_request', 'friend_respond', 'friend_block', 'friend_unblock', 'friend_remove', 'friend_note']) {
        assert.match(friends, new RegExp(`memberOn\\('${ev}'`), ev + ' 要走 memberOn');
        assert.doesNotMatch(friends, new RegExp(`socket\\.on\\('${ev}'`), ev + ' 不能再直接 socket.on');
    }
    assert.match(friends, /if \(user\.isGuest\) \{ socket\.emit\('server_msg', \{ k: 'guest\.needAccount' \}\); return; \}/);
    assert.match(friends, /if \(target\.isGuest\) \{ socket\.emit\('server_msg', \{ k: 'friend\.targetGuest' \}\); return; \}/, '也不能向游客发申请');
});

test('游客同时只能开 1 个房间，正式账号 3 个', () => {
    const lobby = codeOf(read('src/socket/events/lobby-events.js'));
    const body = /(const MAX_ROOMS_GUEST[\s\S]*?\nfunction roomLimitReached[\s\S]*?\n\})/.exec(lobby)[1];
    const fn = new Function('MAX_ROOMS_PER_OWNER', 'MAX_ROOMS_TOTAL', body + '\nreturn roomLimitReached;')(3, 300);
    const rooms = (owner, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [owner + i, { ownerUserId: owner }]));
    assert.equal(fn(rooms('g', 0), { id: 'g', isGuest: true }), null);
    assert.equal(fn(rooms('g', 1), { id: 'g', isGuest: true }), 'room.guestOneRoom');
    assert.equal(fn(rooms('m', 2), { id: 'm', isGuest: false }), null);
    assert.equal(fn(rooms('m', 3), { id: 'm', isGuest: false }), 'room.tooManyMine');
    assert.equal((lobby.match(/const limit = roomLimitReached\(roomGames, user\)/g) || []).length, 2, 'SNG 和现金桌建房都要查');
});

test('🔴 游客退出登录前必须先说清楚后果，而且「取消 / 点外面」= 不退出', () => {
    const auth = codeOf(read('public/js/10-auth.js'));
    const fn = /async function doLogout\(\) \{[\s\S]*?\n\}/.exec(auth)[0];
    const guard = fn.indexOf('if (isGuest)'), wipe = fn.indexOf("localStorage.removeItem('token')");
    assert.ok(guard > 0 && guard < wipe, '确认要在清令牌之前');
    assert.match(fn, /const sure = await uiConfirm\([\s\S]*?danger: true \}\);\s*if \(!sure\) return;/);
});

test('提醒保存账号的四处都接上了', () => {
    const html = read('index.html');
    assert.match(html, /id="guest-banner" class="guest-only guest-banner"/, '① 大厅常驻提示');
    assert.match(read('public/js/20-socket.js'), /socket\.on\('hole_cards', \(cards\) => \{\s*noteGuestHand\(\);/, '② 每发一手牌记一次');
    assert.match(codeOf(read('public/js/30-room.js')), /const leftTable = !!currentRoom;[\s\S]{0,80}if \(leftTable\) setTimeout\(maybeNudgeGuest/, '② 从牌桌回大厅时提醒');
    assert.match(codeOf(read('public/js/10-auth.js')), /if \(hands < GUEST_NUDGE_HANDS \|\| Date\.now\(\) - last < 86400000\) return;/, '② 打够几手才提醒、一天最多一次');
    for (const id of ['checkin-btn', 'voice-btn']) assert.match(html, new RegExp(`class="[^"]*member-only[^"]*" id="${id}"`), '③ ' + id + ' 对游客隐藏');
    const css = read('public/css/10-auth-user.css');
    assert.match(css, /body:not\(\.is-guest\) \.guest-only \{ display: none !important; \}/);
    assert.match(css, /body\.is-guest \.member-only \{ display: none !important; \}/);
    assert.match(read('public/js/99-bootstrap.js'), /\{ id: 'save-account-modal',\s*close: 'closeSaveAccount' \}/);
    // 两个主按钮各一个元素：JS 不去改挂着 data-i18n 的按钮文字（切语言会被盖回去）
    assert.match(html, /id="sa-send"[^>]*data-i18n="btn\.sendCode"/);
    assert.match(html, /id="sa-done"[^>]*data-i18n="sa\.done"/);
    assert.doesNotMatch(codeOf(read('public/js/10-auth.js')), /getElementById\('sa-(send|done)'\)\.textContent/);
});

test('打开页面时从令牌里认出「我是游客」；保存账号后立刻不是', () => {
    assert.match(codeOf(read('public/js/99-bootstrap.js')), /setGuest\(payload\.isGuest\);/);
    const auth = codeOf(read('public/js/10-auth.js'));
    assert.match(auth, /localStorage\.setItem\('token', data\.token\);\s*if \(socket\) socket\.auth = \{ token: data\.token \};[\s\S]{0,120}setGuest\(false\);/);
    assert.match(auth, /function onAuthSuccess[\s\S]*?setGuest\(user\.isGuest\);/);
});

// ───────────────────────── 示例牌局 ─────────────────────────

test('示例牌局的账是平的：没有重复的牌，各家投入 = 底池 = 赢家拿走的', () => {
    const ctx = vm.createContext({ L: (zh) => zh, fmtChips: (n) => String(n), myUserId: null, console });
    vm.runInContext(read('public/js/42-replay.js') + '\nthis.demoHand = demoHand; this.buildReplayFrames = buildReplayFrames;', ctx);
    const h = ctx.demoHand();
    const cards = [...h.seats.flatMap(s => s.hole), ...h.community];
    assert.equal(new Set(cards).size, cards.length, '同一张牌不能出现两次');
    for (const c of cards) assert.match(c, /^([2-9TJQKA])[SHDC]$/);
    const frames = ctx.buildReplayFrames(h);
    const last = frames[frames.length - 1];
    const start = h.seats.reduce((s, x) => s + x.startChips, 0);
    assert.equal(last.players.reduce((s, p) => s + p.stack, 0), start, '筹码总数前后一致');
    const won = h.results.reduce((s, r) => s + r.won, 0);
    assert.equal(last.pot, won, '底池 = 赢家拿走的');
    for (const r of h.results) {
        assert.equal(last.players.find(p => p.userId === r.userId).stack, r.endChips, r.userId + ' 的结束筹码与回放算出来的一致');
    }
    for (const f of frames) for (const p of f.players) assert.ok(p.stack >= 0 && p.bet >= 0, '任何一帧都不该出现负数');
    const hero = last.players.find(p => p.userId === h.heroId);
    assert.ok(hero.isMe, '示例从 heroId 那一家的视角看');
});
