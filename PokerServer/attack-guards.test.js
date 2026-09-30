'use strict';
// 防攻击第一批（2026-09-30）：登录限流 / 每 IP 连接数 / 事件限频 / 取 IP 不许信可伪造的头。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFailureLimiter } = require('./src/ops/failure-limiter');
const { registerSocketGuard } = require('./src/ops/socket-guard');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('失败计数：到上限才挡；窗口过了自动放开；clear 只清自己', () => {
    let t = 1_000_000;
    const l = createFailureLimiter({ max: 3, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) { assert.equal(l.check('a').ok, true); l.fail('a'); }
    const r = l.check('a');
    assert.equal(r.ok, false);
    assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 60_000);
    assert.equal(l.check('b').ok, true, '别的 key 不受影响');
    t += 60_001;
    assert.equal(l.check('a').ok, true, '窗口过了就放开');
    l.fail('a'); l.fail('a'); l.fail('a'); l.clear('a');
    assert.equal(l.check('a').ok, true);
});

// ── socket 护栏：用假的 io / socket 把它跑起来 ──
function fakeIo() {
    const mws = [], conns = [];
    return {
        use: (fn) => mws.push(fn),
        on: (ev, fn) => { if (ev === 'connection') conns.push(fn); },
        async connect(headers, address) {
            const handlers = {}, sockMws = [];
            const s = {
                handshake: { headers, address }, data: {}, user: { username: 'x' }, disconnected: false,
                use: (fn) => sockMws.push(fn), on: (ev, fn) => { handlers[ev] = fn; },
                disconnect() { this.disconnected = true; handlers.disconnect && handlers.disconnect(); },
                // 模拟一个入站事件：返回它有没有被放行
                emitIn(ev) { let passed = false; sockMws.forEach(m => m([ev], () => { passed = true; })); return passed; },
            };
            for (const m of mws) { const err = await new Promise(r => m(s, r)); if (err) return { rejected: err }; }
            conns.forEach(c => c(s));
            return s;
        },
    };
}
const quiet = { warn() {} };

test('🔴 每 IP 连接数有上限；断开会释放名额', async () => {
    const io = fakeIo();
    const g = registerSocketGuard(io, { maxPerIp: 3, log: quiet });
    const viaCaddy = (ip) => ({ 'x-forwarded-for': ip });
    const socks = [];
    for (let i = 0; i < 3; i++) socks.push(await io.connect(viaCaddy('203.0.113.9'), '127.0.0.1'));
    const fourth = await io.connect(viaCaddy('203.0.113.9'), '127.0.0.1');
    assert.ok(fourth.rejected, '第 4 条应被拒');
    assert.ok(!(await io.connect(viaCaddy('203.0.113.10'), '127.0.0.1')).rejected, '别的 IP 不受影响');
    socks[0].disconnect();
    assert.equal(g.connectionsOf('203.0.113.9'), 2);
    assert.ok(!(await io.connect(viaCaddy('203.0.113.9'), '127.0.0.1')).rejected, '断开一条后可以再连');
});

test('🔴 连接数按真实 IP 算：左边塞假 IP 绕不过去；直连忽略 XFF', async () => {
    const io = fakeIo();
    registerSocketGuard(io, { maxPerIp: 2, log: quiet });
    await io.connect({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }, '127.0.0.1');
    await io.connect({ 'x-forwarded-for': '2.2.2.2, 203.0.113.9' }, '127.0.0.1');
    assert.ok((await io.connect({ 'x-forwarded-for': '3.3.3.3, 203.0.113.9' }, '127.0.0.1')).rejected);
    // 直连 3000：自带的 XFF 一律不信，按真实对端算
    await io.connect({ 'x-forwarded-for': '4.4.4.4' }, '198.51.100.7');
    await io.connect({ 'x-forwarded-for': '5.5.5.5' }, '198.51.100.7');
    assert.ok((await io.connect({ 'x-forwarded-for': '6.6.6.6' }, '198.51.100.7')).rejected);
});

test('本机无代理头（本地测试 / 探针）不计连接数', async () => {
    const io = fakeIo();
    registerSocketGuard(io, { maxPerIp: 2, log: quiet });
    for (let i = 0; i < 10; i++) assert.ok(!(await io.connect({}, '127.0.0.1')).rejected);
});

test('🔴 事件令牌桶：正常节奏放行；狂刷先丢、持续狂刷断开', async () => {
    let t = 0;
    const io = fakeIo();
    registerSocketGuard(io, { burst: 10, refillPerSec: 5, kickAfterDrops: 20, now: () => t, log: quiet });
    const s = await io.connect({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    for (let i = 0; i < 10; i++) assert.equal(s.emitIn('player_action'), true, '突发 10 个以内放行');
    assert.equal(s.emitIn('player_action'), false, '第 11 个被丢');
    t += 1000;   // 1 秒回 5 个
    for (let i = 0; i < 5; i++) assert.equal(s.emitIn('chat_msg'), true);
    for (let i = 0; i < 25; i++) s.emitIn('chat_msg');
    assert.equal(s.disconnected, true, '持续狂刷应被断开');
});

test('🔴 结构：护栏挂在鉴权之前；消息体积有上限', () => {
    const src = read('server.js');
    const g = src.indexOf('registerSocketGuard(io)'), a = src.indexOf('auth.registerSocketAuth(io)');
    assert.ok(g > 0 && a > 0 && g < a, '护栏必须在 JWT 鉴权之前注册（被挡的连接不该碰数据库）');
    assert.match(src, /maxHttpBufferSize:\s*\d/);
});

test('🔴 结构：登录限流挡在 bcrypt 之前；账号维度不看账号存不存在；不存在也做同样耗时的比对', () => {
    const src = read('src/http/register-auth-routes.js');
    const i = src.indexOf("app.post('/api/login'");
    const body = src.slice(i, src.indexOf('\n});', i));
    const check = body.indexOf('.check('), cmp = body.indexOf('bcrypt.compare');
    assert.ok(check > 0 && cmp > check, '限流检查必须在 bcrypt 之前');
    assert.match(body, /user \? user\.password_hash : DUMMY_HASH/, '账号不存在也要比对一次，别用响应快慢泄露哪些用户名注册过');
    assert.doesNotMatch(body, /if \(!user\) return res\.status\(401\)/, '不能在比对前就对「不存在」提前返回');
});

test('🔴 除了 client-ip.js，没有任何地方自己去读 X-Forwarded-For', () => {
    // 这个洞已经出现过两次（登录来源统计、猜房间码限流）——都是自己读了那个客户端能伪造的头。
    // 只看代码：解释这个坑的注释里当然会出现这个词（关卡对着自己的说明报警，只会逼人去削弱它）
    const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const bad = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.js') && !p.endsWith(path.join('ops', 'client-ip.js')) && /x-forwarded-for/i.test(code(fs.readFileSync(p, 'utf8')))) bad.push(path.relative(__dirname, p));
    });
    walk(path.join(__dirname, 'src'));
    if (/x-forwarded-for/i.test(code(read('server.js')))) bad.push('server.js');
    assert.deepEqual(bad, [], '取来源 IP 一律用 extractIp()');
});
