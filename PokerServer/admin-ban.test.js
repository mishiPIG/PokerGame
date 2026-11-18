'use strict';
// 管理员功能扩充（2026-11-18）：封禁 / 解封、实时在线、任意一手完整回放。
//
// 封禁最怕的是【有一道门没关上】：登录、HTTP 接口、socket 连接是三条互不相干的路，
// 只拦一条的话，被封的人照样能从另外两条进来。所以三条每条都单独断言一次。
// 其次是【封过头】：封禁必须可撤销，解封后账号、金币原样回来（游客没有密码，尤其不能丢号）。
// 真库（临时文件）、真鉴权、真路由处理器，只有 req / res / socket 是假的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createDatabaseService } = require('./src/storage/database-service');
const { createAuth } = require('./src/auth');
const { registerAuthRoutes } = require('./src/http/register-auth-routes');
const { registerAdminRoutes } = require('./src/http/register-admin-routes');

function tempDb(t) {
    const file = path.join(os.tmpdir(), `ban-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = createDatabaseService({ databasePath: file, allowCreate: true });
    t.after(() => { try { db.close?.(); } catch { /* */ } for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true }); });
    return db;
}

function fakeSocket(user) {
    return { user, emitted: [], disconnected: false, currentRoom: null,
        emit(ev, d) { this.emitted.push([ev, d]); }, disconnect() { this.disconnected = true; } };
}

function harness(t) {
    const db = tempDb(t);
    const auth = createAuth({ db, jwt, jwtSecret: 'test-secret' });
    const routes = {};
    const app = { post: (p, ...h) => { routes['POST ' + p] = h; }, get: (p, ...h) => { routes['GET ' + p] = h; } };
    const io = { sockets: { sockets: new Map() }, use(fn) { this.mw = fn; } };
    const roomGames = {};
    const mailer = { sendCode: async () => {}, isConfigured: () => true };
    registerAuthRoutes({ app, db, bcrypt, mailer, signToken: auth.signToken, userPayload: auth.userPayload, requireAuth: auth.requireAuth, io, roomGames });
    registerAdminRoutes({ app, db, requireAdmin: auth.requireAdmin, roomGames, io, clientErrors: { list: () => [] } });
    auth.registerSocketAuth(io);
    let ipn = 0;
    async function call(route, body, { token, params = {} } = {}) {
        const req = { body, params, query: {}, headers: token ? { authorization: 'Bearer ' + token } : {}, socket: { remoteAddress: '198.51.100.' + (++ipn % 200) } };
        const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; this.done = true; return this; } };
        for (const h of routes[route]) {
            let nexted = false;
            await h(req, res, () => { nexted = true; });
            if (res.done || !nexted) break;
        }
        return res;
    }
    // HTTP 那道门：直接跑真 requireAuth（/api/me 等接口都挂在它后面）
    const authed = (token) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
        auth.requireAuth({ headers: { authorization: 'Bearer ' + token } }, res, () => {}); return res; };
    const socketAuth = (token) => new Promise(r => { const s = { handshake: { auth: { token } } }; io.mw(s, err => r({ err, s })); });
    const mk = (name, { admin = false } = {}) => {
        const u = db.createUser(name, bcrypt.hashSync('pw123456', 4), admin, `${name}@example.test`);
        return { user: db.getUserById(u.id), token: auth.signToken(db.getUserById(u.id)) };
    };
    return { db, auth, call, io, roomGames, socketAuth, mk, authed };
}

test('🔴 封禁后三道门都关上：登录、HTTP 接口、socket 连接；解封后全部恢复', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    const bob = h.mk('bob');
    assert.equal((await h.call('POST /api/admin/ban', { username: 'bob', reason: '刷屏' }, { token: admin.token })).code, 200);

    const login = await h.call('POST /api/login', { username: 'bob', password: 'pw123456' });
    assert.equal(login.code, 403); assert.equal(login.data.k, 'banned');
    const me = h.authed(bob.token);
    assert.equal(me.code, 403, '封禁前签发的令牌也不能再用'); assert.equal(me.data.k, 'banned');
    const sock = await h.socketAuth(bob.token);
    assert.ok(sock.err && sock.err.message === 'banned', 'socket 鉴权拒绝，错误代号让客户端按语言显示');

    assert.equal((await h.call('POST /api/admin/unban', { username: 'bob' }, { token: admin.token })).code, 200);
    assert.equal((await h.call('POST /api/login', { username: 'bob', password: 'pw123456' })).code, 200);
    assert.equal((h.authed(bob.token)).code, 200, '旧令牌解封后照样能用');
    assert.equal((await h.socketAuth(bob.token)).err, undefined);
});

test('🔴 密码错的时候不透露「这个号被封了」', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    h.mk('bob');
    await h.call('POST /api/admin/ban', { username: 'bob', reason: 'x' }, { token: admin.token });
    const r = await h.call('POST /api/login', { username: 'bob', password: 'wrong-password' });
    assert.equal(r.code, 401); assert.equal(r.data.k, 'badLogin');
});

test('封禁可撤销：金币和账号原样，游客解封后凭原令牌回来', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    const g = await h.call('POST /api/guest', { name: 'River' });
    const guest = g.data.user;
    const before = h.db.getUserById(guest.id).gold;
    assert.equal((await h.call('POST /api/admin/ban', { username: guest.username, reason: '捣乱' }, { token: admin.token })).code, 200);
    assert.ok(h.db.getUserById(guest.id).bannedAtMs, '封禁中');
    assert.equal(h.db.getAllUsers().find(u => u.id === guest.id).banReason, '捣乱', '管理面板看得到原因');
    await h.call('POST /api/admin/unban', { username: guest.username }, { token: admin.token });
    const after = h.db.getUserById(guest.id);
    assert.equal(after.gold, before); assert.equal(after.bannedAtMs, null); assert.equal(after.banReason, null);
    assert.equal(h.authed(g.data.token).code, 200);
});

test('在线的立刻断开；正坐在牌桌上的按「主动离开」快速代打，别人不受影响', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    const bob = h.mk('bob'), amy = h.mk('amy');
    const sb = fakeSocket(bob.user), sa = fakeSocket(amy.user);
    h.io.sockets.sockets.set('1', sb); h.io.sockets.sockets.set('2', sa);
    h.roomGames.r1 = { players: [{ userId: bob.user.id, chips: 900 }, { userId: amy.user.id, chips: 1100 }] };
    const r = await h.call('POST /api/admin/ban', { username: 'bob', reason: 'x' }, { token: admin.token });
    assert.equal(r.data.kicked, 1);
    assert.ok(sb.disconnected); assert.deepEqual(sb.emitted[0], ['account_banned', undefined]);
    assert.equal(sa.disconnected, false);
    assert.equal(h.roomGames.r1.players[0].leftByChoice, true);
    assert.equal(h.roomGames.r1.players[0].chips, 900, '不在这里动钱：筹码留在桌上，收桌时照常兑回');
    assert.equal(h.roomGames.r1.players[1].leftByChoice, undefined);
});

test('不能封自己、不能封管理员、必须写原因、普通用户调不了', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    h.mk('other', { admin: true });
    const bob = h.mk('bob');
    assert.equal((await h.call('POST /api/admin/ban', { username: 'boss', reason: 'x' }, { token: admin.token })).code, 400);
    assert.equal((await h.call('POST /api/admin/ban', { username: 'other', reason: 'x' }, { token: admin.token })).code, 400);
    assert.equal((await h.call('POST /api/admin/ban', { username: 'bob', reason: '  ' }, { token: admin.token })).code, 400);
    assert.equal((await h.call('POST /api/admin/ban', { username: 'bob', reason: 'x' }, { token: bob.token })).code, 403);
    assert.equal(h.db.getUserById(bob.user.id).bannedAtMs, null);
});

test('实时在线：按账号聚合，分出在座 / 观战 / 大厅', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    const a = h.mk('a'), b = h.mk('b'), c = h.mk('c');
    const sa = fakeSocket(a.user), sb = fakeSocket(b.user), sc = fakeSocket(c.user);
    sa.currentRoom = 'r1'; sb.currentRoom = 'r1';
    [sa, sb, sc].forEach((s, i) => h.io.sockets.sockets.set(String(i), s));
    h.roomGames.r1 = { config: { name: '周五局' }, roomType: 'cash', phase: 'flop', players: [{ userId: a.user.id, chips: 1500, folded: false }] };
    const r = await h.call('GET /api/admin/online', {}, { token: admin.token });
    assert.equal(r.data.total, 3);
    const byName = Object.fromEntries(r.data.users.map(u => [u.username, u]));
    assert.equal(byName.a.where, 'seated'); assert.equal(byName.a.inHand, true); assert.equal(byName.a.chips, 1500);
    assert.equal(byName.b.where, 'watching'); assert.equal(byName.c.where, 'lobby');
    assert.equal(r.data.users[0].username, 'a', '在座的排在最前');
    assert.equal((await h.call('GET /api/admin/online', {}, { token: a.token })).code, 403);
});

test('🔴 任意一手的完整记录只给管理员，且确实是全量（含每家底牌）', async (t) => {
    const h = harness(t);
    const admin = h.mk('boss', { admin: true });
    const a = h.mk('a'), b = h.mk('b');
    const rec = { roomId: 'r9', handSeq: 3, mode: 'cash', ts: Date.now(), sb: 10, bb: 20,
        seats: [{ userId: a.user.id, username: 'a', seat: 0, startChips: 1000, hole: ['AS', 'KS'] },
                { userId: b.user.id, username: 'b', seat: 1, startChips: 1000, hole: ['7D', '2C'] }],
        actions: [{ userId: b.user.id, street: 'preflop', action: 'fold' }],
        results: [{ userId: a.user.id, endChips: 1010, won: 30 }, { userId: b.user.id, endChips: 990, won: 0, folded: true }],
        community: [], fair: { serverSeed: 'seed123' } };
    const { handId } = h.db.appendHand(rec);
    const r = await h.call('GET /api/admin/hand/:handId', {}, { token: admin.token, params: { handId } });
    assert.equal(r.code, 200);
    assert.deepEqual(r.data.seats.map(s => s.hole), [['AS', 'KS'], ['7D', '2C']], '弃牌那家的底牌也在');
    assert.equal(r.data.handId, handId);
    assert.equal((await h.call('GET /api/admin/hand/:handId', {}, { token: a.token, params: { handId } })).code, 403);
    assert.equal((await h.call('GET /api/admin/hand/:handId', {}, { token: admin.token, params: { handId: 'nope' } })).code, 404);
});

test('客户端：被封时显示提示，但【不清令牌】（游客没有密码，清了就再也回不来）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'public/js/20-socket.js'), 'utf8');
    const fn = src.slice(src.indexOf('function showBanned'), src.indexOf("socket.on('account_banned'"));
    assert.ok(fn.length > 0, 'showBanned 存在');
    assert.doesNotMatch(fn, /removeItem\('token'\)/);
    assert.match(src, /if \(err && err\.message === 'banned'\) \{ showBanned\(\); return; \}/, '鉴权拒绝时先认出 banned，别走到清令牌那条路');
    assert.match(fs.readFileSync(path.join(__dirname, 'public/js/42-replay.js'), 'utf8'), /showCards: !!h\.revealAll/, '管理员回放每家的牌都亮着');
});
