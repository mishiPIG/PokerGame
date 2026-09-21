'use strict';

// 客户端 IP 取值与归一化（2026-09-21）。
//
// 这里错了不会报错，只会让「同 IP 多账号」给出垃圾结论 —— 而那种结论会被拿去判断人。
// 所以三条都要钉死：代理链取最左、IPv6 按 /64 聚合、取不到就是 null（不许编）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractIp, normalizeIp, prefixOf } = require('./src/ops/client-ip');

// ═══ 取值 ═══

test('🔴 走 Caddy 反代时，真实地址在 X-Forwarded-For 里，直连地址永远是 127.0.0.1', () => {
    assert.equal(extractIp({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1'), '203.0.113.9');
});

test('🔴 代理链要取【最左边】那个 —— 取错方向拿到的全是代理自己的地址', () => {
    assert.equal(
        extractIp({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' }, '127.0.0.1'),
        '203.0.113.9');
});

test('没有代理头时退回直连地址', () => {
    assert.equal(extractIp({}, '203.0.113.9'), '203.0.113.9');
});

test('🔴 取不到就返回 null，绝不编一个假的', () => {
    // 编一个（比如 '0.0.0.0'）的话，所有取不到的人会被聚成「同一个 IP」，
    // 然后在多账号清单里显示成一大坨，纯属制造假线索。
    assert.equal(extractIp({}, ''), null);
    assert.equal(extractIp({}, undefined), null);
    assert.equal(extractIp(undefined, undefined), null);
    assert.equal(extractIp({ 'x-forwarded-for': '   ' }, ''), null);
    assert.equal(extractIp({ 'x-forwarded-for': 'not-an-ip' }, ''), null);
});

test('本机地址等于「没穿过代理」，记下来没意义 → null', () => {
    assert.equal(extractIp({}, '127.0.0.1'), null);
    assert.equal(extractIp({}, '::1'), null);
});

test('IPv4-mapped IPv6 要还原成 IPv4，否则同一个人会被拆成两个 IP', () => {
    assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(normalizeIp('::FFFF:203.0.113.9'), '203.0.113.9');
});

test('IPv6 的 zone id 要去掉', () => {
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
});

// ═══ 聚合前缀 ═══

test('IPv4 按 /24 聚合', () => {
    assert.equal(prefixOf('203.0.113.9'), '203.0.113.0/24');
    assert.equal(prefixOf('203.0.113.250'), '203.0.113.0/24');
    assert.notEqual(prefixOf('203.0.113.9'), prefixOf('203.0.114.9'), '不同网段不该聚到一起');
});

test('🔴 IPv6 按 /64 聚合 —— 完整地址会变，同一个人每次都像新 IP', () => {
    // 同一个 /64 下的不同设备/不同隐私扩展地址，必须聚到一起
    const a = prefixOf('2001:db8:85a3:1111:0:0:0:1');
    const b = prefixOf('2001:db8:85a3:1111:abcd:ef01:2345:6789');
    assert.equal(a, b, '同一个 /64 没聚到一起 —— 这个人每次登录都会被当成新来源');
    assert.equal(a, '2001:db8:85a3:1111::/64');

    // 不同 /64 不能聚
    assert.notEqual(prefixOf('2001:db8:85a3:1111::1'), prefixOf('2001:db8:85a3:2222::1'));
});

test('🔴 :: 缩写必须先展开，否则分组数不对、前缀会算错', () => {
    // fe80::1 实际是 fe80:0:0:0:0:0:0:1，前四组是 fe80:0:0:0
    assert.equal(prefixOf('fe80::1'), 'fe80:0:0:0::/64');
    // 开头就是 :: 的
    assert.equal(prefixOf('::1'), '0:0:0:0::/64');
    // 末尾是 :: 的
    assert.equal(prefixOf('2001:db8::'), '2001:db8:0:0::/64');
});

test('前导零要归一，否则同一个前缀会有两种写法', () => {
    assert.equal(prefixOf('2001:0db8:0000:1111::1'), prefixOf('2001:db8:0:1111::1'));
});

test('烂输入不许抛（这条路径挂了会连累注册和登录）', () => {
    for (const bad of [null, undefined, '', 'xxx', '1.2.3', '999.1.1.1', ':::::']) {
        assert.doesNotThrow(() => prefixOf(bad));
        assert.doesNotThrow(() => normalizeIp(bad));
    }
    assert.equal(prefixOf(null), null);
    assert.equal(prefixOf('1.2.3'), null, '不是合法 IPv4 就不该给出前缀');
});
