'use strict';
// 浏览器安全策略（CSP）+ 转义关卡 —— 2026-11-14，头像注入事件之后加的两道防线。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { contentSecurityPolicy } = require('./src/http/security-headers');
const { check, interpolations, bareParts, RISKY } = require('./tools/check-escape');

const directives = (csp) => Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test('🔴 图片 / 网络请求只准走本站 —— 注入的代码偷数据靠的就是这两条往外站发', () => {
    const d = directives(contentSecurityPolicy('pokerdojo.space'));
    for (const k of ['img-src', 'connect-src', 'media-src', 'font-src', 'default-src']) {
        assert.ok(d[k], `缺 ${k}`);
        for (const v of d[k]) {
            assert.ok(
                ["'self'", 'data:', 'blob:', 'wss://pokerdojo.space', 'ws://pokerdojo.space'].includes(v),
                `${k} 里出现了 ${v} —— 放行任何外站来源都会重新打开「把数据送出去」的口子`
            );
        }
    }
    assert.ok(!d['connect-src'].includes('wss:') && !d['connect-src'].includes('https:'), '不能写裸协议（等于放行所有站点）');
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.deepEqual(d['frame-ancestors'], ["'none'"]);
    assert.ok(d['report-uri'], '违规要能上报，否则下一次有人试我们还是不知道');
});

test('Host 头里的怪东西不会被拼进策略', () => {
    for (const bad of ['evil.com; script-src *', 'a b', 'x"y', '']) {
        const csp = contentSecurityPolicy(bad);
        assert.match(csp, /connect-src 'self';/, `Host=${JSON.stringify(bad)} 不该出现在 connect-src 里`);
    }
    assert.match(contentSecurityPolicy('10.76.106.91:3000'), /connect-src 'self' wss:\/\/10\.76\.106\.91:3000 ws:\/\/10\.76\.106\.91:3000;/);
});

test('页面本身不依赖任何外站资源（否则加了策略会白屏）', () => {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const ext = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
    assert.deepEqual(ext, [], '外站资源要么搬到本站，要么加进策略的白名单');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, '不许有内联 <script> 块');
});

test('server.js 在静态资源之前挂上策略', () => {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const at = src.indexOf('registerSecurityHeaders({');
    assert.ok(at > 0, 'server.js 没有挂 registerSecurityHeaders');
    assert.ok(at < src.indexOf('express.static('), '必须在 express.static 之前，静态页面才会带上这个头');
});

test('🔴 转义关卡：当前代码零违规', () => {
    assert.deepEqual(check(), []);
});

test('转义关卡能抓到原来那四处写法（反向对照）', () => {
    const flagged = (code) => {
        for (const it of interpolations(code)) {
            if (!it.html) continue;
            const bare = it.inHandler ? bareParts(it.expr.replace(/escapeHtml\(/g, '(')) : bareParts(it.expr);
            if (RISKY.test(bare)) return true;
        }
        return false;
    };
    // 当初的漏洞
    assert.equal(flagged('x = `<img class="avatar-img" src="${p.avatar}" onerror="this.style.display=\'none\'">`'), true);
    assert.equal(flagged('x = `<td>${u.username}</td>`'), true);
    assert.equal(flagged('x = `<div>${a.displayName || a.username}</div>`'), true);
    // 放进内联事件的 JS 字符串里，转义了也不算数（属性值会先被解码回原字符）
    assert.equal(flagged('x = `<button onclick="f(\'${escapeHtml(d.username)}\')">`'), true);
    // 正确写法
    assert.equal(flagged('x = `<img src="${escapeHtml(p.avatar)}">`'), false);
    assert.equal(flagged('x = `<button data-user="${escapeHtml(d.username)}" onclick="f(this.dataset.user)">`'), false);
    assert.equal(flagged('x = `<b>${email ? escapeHtml(email) : L(\'未绑定\', \'Not set\')}</b>`'), false);
    assert.equal(flagged('x = `${p.username} 加入`'), false, '不是 HTML 的模板串（toast 文案）不管');
});

test('npm run check 里跑着转义关卡', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.check, /tools\/check-escape\.js/);
});

test('用户名 / 房间名不收能拼出 HTML 或跳出 JS 字符串的字符', () => {
    const auth = fs.readFileSync(path.join(__dirname, 'src/http/register-auth-routes.js'), 'utf8');
    assert.match(auth, /\/\[<>"'`&\\\\\]\/\.test\(username\)/, '注册时要拒绝这些字符');
    const lobby = fs.readFileSync(path.join(__dirname, 'src/socket/events/lobby-events.js'), 'utf8');
    assert.equal((lobby.match(/name:\s+cleanRoomName\(cfg\.name\)/g) || []).length, 2, 'SNG 和现金桌的房间名都要过 cleanRoomName');
    const clean = eval(/const cleanRoomName = (.+);/.exec(lobby)[1]);   // eslint-disable-line no-eval
    assert.equal(clean(`x');alert(1)//<b>`), 'x);alert(1)//b');
    assert.equal(clean('  周五局  '), '周五局');
});
