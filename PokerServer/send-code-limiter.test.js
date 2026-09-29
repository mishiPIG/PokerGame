'use strict';

// 验证码按 IP 限流（2026-09-29）。
// 发信额度是全站共用的；只按邮箱限流的话，换一堆假邮箱就能把当天额度烧光。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSendCodeLimiter } = require('./src/ops/send-code-limiter');

test('同一 IP 在窗口内超过上限被挡，别的 IP 不受影响', () => {
    let t = 0;
    const l = createSendCodeLimiter({ max: 3, windowMs: 1000, now: () => t });
    assert.ok(l.check('198.51.100.7').ok);
    assert.ok(l.check('198.51.100.7').ok);
    assert.ok(l.check('198.51.100.7').ok);
    const r = l.check('198.51.100.7');
    assert.equal(r.ok, false);
    assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 1000);
    assert.ok(l.check('203.0.113.9').ok, '别人不该被连累');
});

test('窗口滑过去之后恢复', () => {
    let t = 0;
    const l = createSendCodeLimiter({ max: 2, windowMs: 1000, now: () => t });
    l.check('a'); l.check('a');
    assert.equal(l.check('a').ok, false);
    t = 1001;
    assert.ok(l.check('a').ok);
});

test('🔴 取不到 IP（null）不等于不限 —— 统一进同一个桶', () => {
    const l = createSendCodeLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    assert.ok(l.check(null).ok);
    assert.ok(l.check(undefined).ok);
    assert.equal(l.check(null).ok, false, 'null 要是不限，攻击者只要让自己的 IP 取不到就行');
});

test('被挡的请求不再累计（否则被挡的人会被越挡越久）', () => {
    let t = 0;
    const l = createSendCodeLimiter({ max: 1, windowMs: 1000, now: () => t });
    l.check('a');
    for (let i = 0; i < 50; i++) l.check('a');
    t = 1001;
    assert.ok(l.check('a').ok);
});

test('换 IP 刷时内存不会无限长：过期 key 会被清掉', () => {
    let t = 0;
    const l = createSendCodeLimiter({ max: 5, windowMs: 1000, now: () => t, maxKeys: 100 });
    for (let i = 0; i < 100; i++) l.check(`10.0.0.${i}`);
    t = 5000;
    for (let i = 0; i < 5; i++) l.check(`10.0.1.${i}`);
    assert.ok(l.size() <= 10, `旧 key 应已清理，实际 ${l.size()}`);
});

// ═══ 结构关卡：三个发码接口都必须过这道闸 ═══
// 「新加一个发码入口却忘了挂限流」是最可能的回归 —— 这条让它当场挂掉。
const ROUTES = fs.readFileSync(path.join(__dirname, 'src/http/register-auth-routes.js'), 'utf8');
function routeBody(route) {
    const start = ROUTES.indexOf(`app.post('${route}'`);
    assert.ok(start >= 0, `找不到路由 ${route}`);
    const next = ROUTES.indexOf('app.post(', start + 1);
    return ROUTES.slice(start, next < 0 ? undefined : next);
}

test('🔴 所有发码接口都挂了按 IP 的限流', () => {
    const sendRoutes = [...ROUTES.matchAll(/app\.post\('([^']*send-code)'/g)].map(m => m[1]);
    assert.ok(sendRoutes.length >= 3, `应当至少有 3 个发码接口，实际找到 ${sendRoutes.length}`);
    for (const r of sendRoutes) {
        const body = routeBody(r);
        const gate = body.indexOf('ipBlocked(req, res)');
        const send = body.indexOf('mailer.sendCode');
        assert.ok(gate >= 0, `${r} 没有挂 ipBlocked`);
        assert.ok(gate < send, `${r} 的 ipBlocked 必须在发信之前`);
    }
});

test('🔴 找回密码：IP 闸必须在查邮箱之前，否则「被不被限流」会泄露邮箱是否注册过', () => {
    const body = routeBody('/api/forgot/send-code');
    assert.ok(body.indexOf('ipBlocked(req, res)') < body.indexOf('getUserByEmail'));
});

test('🔴 限流用的 IP 必须来自 extractIp（防伪造），不许自己读 X-Forwarded-For', () => {
    assert.match(ROUTES, /sendLimiter\.check\(extractIp\(req\.headers, req\.socket\?\.remoteAddress\)\)/);
    assert.doesNotMatch(ROUTES, /x-forwarded-for/i);
});
