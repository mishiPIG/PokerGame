'use strict';

// 服务端拒绝提示的结构化 i18n（2026-09-09）。
//
// 背景：服务端原本直接 emit 中文原文，英文用户切到 English 后界面是英文、
// 提示却是中文。改为服务端只发 { k, p }，翻译放客户端字典，各客户端按自己
// 的语言渲染。
// ⚠️ 之所以能这么改，是因为这 56 条【全部是 socket.emit 私发给单个玩家】的——
//    不存在「一条广播要同时满足两种语言」的问题。（普通动作播报确实是广播，
//    但客户端本来就只 console.log、不上桌面，不在本次范围内。）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const glob = (dir, re) => fs.readdirSync(dir).filter(f => re.test(f));

function loadI18n(lang) {
    const src = fs.readFileSync(path.join(__dirname, 'public/js/03-i18n.js'), 'utf8');
    const store = {};
    const ctx = {
        console,
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        navigator: { language: 'zh-CN' },
        document: { readyState: 'complete', documentElement: {}, addEventListener() {}, querySelectorAll: () => [] },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    vm.runInContext(`lang = '${lang}'`, ctx);
    return (expr) => vm.runInContext(expr, ctx);
}

test('结构化提示能按当前语言渲染，参数正确代入', () => {
    const zh = loadI18n('zh'), en = loadI18n('en');
    assert.equal(zh("renderServerMsg({k:'act.notYourTurn'})"), '⚠️ 不是你的回合');
    assert.equal(en("renderServerMsg({k:'act.notYourTurn'})"), '⚠️ It is not your turn');
    assert.equal(zh("renderServerMsg({k:'act.betMin',p:{min:200}})"), '⚠️ 下注最少 200');
    assert.equal(en("renderServerMsg({k:'act.betMin',p:{min:200}})"), '⚠️ Minimum bet is 200');
    // 多参数
    assert.match(zh("renderServerMsg({k:'gold.lowBuyin',p:{chips:5000,cost:550,gold:120}})"), /5000.*550.*120/);
    assert.match(en("renderServerMsg({k:'gold.lowBuyin',p:{chips:5000,cost:550,gold:120}})"), /5000.*550.*120/);
});

test('🔴 缺 key / 老格式字符串都不能显示成乱码', () => {
    const zh = loadI18n('zh');
    // 字典里没有这个 key（比如客户端缓存了旧版 JS，服务端已经发新 key）
    // → 宁可什么都不显示，也绝不能弹出 [object Object]
    assert.equal(zh("renderServerMsg({k:'not.a.real.key'})"), '');
    assert.equal(zh("renderServerMsg({})"), '');
    assert.equal(zh("renderServerMsg(null)"), '');
    // 老服务端 / 未迁移的调用点发的仍是字符串 → 原样返回
    assert.equal(zh("renderServerMsg('⚠️ 老格式')"), '⚠️ 老格式');
});

test('🔴 服务端不得再有中文的 ⚠️ 提示字面量', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
    const offenders = [];
    for (const f of walk(path.join(__dirname, 'src'))) {
        const t = fs.readFileSync(f, 'utf8');
        if (/emit\(\s*'server_msg'\s*,\s*['"`]\u26a0/.test(t)) offenders.push(path.relative(__dirname, f));
    }
    assert.deepEqual(offenders, [], '这些文件还在直接 emit 中文提示，英文用户会看到中文：' + offenders.join(', '));
});

test('🔴 服务端用到的每个 key 都必须在中英字典里都有', () => {
    // 漏一条的后果是「玩家点了没反应」——比显示中文更糟，因为完全没有反馈。
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
    const used = new Set();
    for (const f of walk(path.join(__dirname, 'src'))) {
        const t = fs.readFileSync(f, 'utf8');
        for (const m of t.matchAll(/emit\(\s*'server_msg'\s*,\s*\{\s*k:\s*'([^']+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 50, '只扫到 ' + used.size + ' 个 key，抓取逻辑可能失效了');
    const zh = loadI18n('zh');
    // ⚠️ 必须查字典成员，不能用 `t(key, null) == null` 判缺失——t() 找不到时返回 key 本身，
    //    那样写这条断言永远为真、一个缺失都抓不到（第一版就是这么写的）。
    const missZh = [...used].filter(k => !zh(`('srv.${k}' in I18N.zh)`));
    const missEn = [...used].filter(k => !zh(`('srv.${k}' in I18N.en)`));
    assert.deepEqual(missZh, [], '中文字典缺这些 key');
    assert.deepEqual(missEn, [], '英文字典缺这些 key');
});
