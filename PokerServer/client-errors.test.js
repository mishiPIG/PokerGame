'use strict';

// 客户端报错上报（2026-09-16）。
//
// 这个端点**故意不鉴权**（登录页本身也会出错，而那正是最看不到的一类），
// 代价是它必须当成敌对输入处理。下面守的全是「不挡就会出事」的那几条：
// 一个渲染循环里的错误一秒能抛几百次；字段是玩家可控的字符串；IP 是唯一的配额单位。
//
// 刻意**不落库**：错误日志不是数据资产（牌谱才是），不值得为它加表、加迁移、加清理 cron。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientErrorSink, MAX_BUFFER, MAX_PER_IP_PER_MIN, DEDUPE_MS } = require('./src/ops/client-errors');

// 可控时钟：限流/去重全是时间窗口，用真时钟测会变成 flaky
function sinkAt() {
    let t = 1_000_000;
    const sink = createClientErrorSink({ now: () => t });
    return { sink, tick: ms => { t += ms; }, at: () => t };
}
const err = (msg, over = {}) => ({ message: msg, source: 'a.js', line: 1, col: 2, ...over });

test('正常一条：记下来，带上前端构建号和用户名', () => {
    const { sink } = sinkAt();
    const r = sink.record(err('x is not defined', { build: 'abc1234', stack: 'Error: x\n  at f' }),
        { ip: '1.2.3.4', username: 'admin1' });
    assert.equal(r.accepted, true);
    const [e] = sink.list();
    assert.equal(e.message, 'x is not defined');
    assert.equal(e.build, 'abc1234');
    assert.equal(e.username, 'admin1');
    assert.equal(e.kind, 'error');
});

test('🔴 同一条错误在循环里刷 500 次，只占一条（带计数）', () => {
    // 不去重的话，一个 render 循环里的错误能瞬间把缓冲和 pm2 日志冲干净，
    // 把【别的】错误挤出去 —— 那才是真正的损失。
    const { sink } = sinkAt();
    for (let i = 0; i < 500; i++) sink.record(err('boom'), { ip: '1.1.1.1' });
    assert.equal(sink.size(), 1);
    assert.equal(sink.list()[0].count, 500);
});

test('🔴 按 IP 限流：一分钟最多 N 条不同错误', () => {
    const { sink, tick } = sinkAt();
    for (let i = 0; i < MAX_PER_IP_PER_MIN; i++) {
        assert.equal(sink.record(err('e' + i), { ip: '9.9.9.9' }).accepted, true);
    }
    const over = sink.record(err('e-over'), { ip: '9.9.9.9' });
    assert.equal(over.accepted, false);
    assert.equal(over.reason, 'rate');

    // 别的 IP 不受影响 —— 限流单位是 IP，不是全局
    assert.equal(sink.record(err('other'), { ip: '8.8.8.8' }).accepted, true);

    // 窗口过了就恢复
    tick(61_000);
    assert.equal(sink.record(err('later'), { ip: '9.9.9.9' }).accepted, true);
});

test('去重窗口过了，同一条错误会重新记 —— 说明它还在发生', () => {
    const { sink, tick } = sinkAt();
    sink.record(err('recurring'), { ip: '1.1.1.1' });
    tick(DEDUPE_MS + 1000);
    sink.record(err('recurring'), { ip: '1.1.1.1' });
    assert.equal(sink.size(), 2, '过了窗口应该是新的一条，否则看不出它一直在复发');
});

test('🔴 字段硬截断：message/stack/ua 都是玩家可控的字符串', () => {
    const { sink } = sinkAt();
    sink.record({
        message: 'M'.repeat(5000), stack: 'S'.repeat(9000),
        ua: 'U'.repeat(5000), source: 'F'.repeat(5000), build: 'B'.repeat(500),
    }, { ip: '1.1.1.1' });
    const e = sink.list()[0];
    assert.ok(e.message.length <= 300, 'message 没截断');
    assert.ok(e.stack.length <= 1500, 'stack 没截断');
    assert.ok(e.ua.length <= 200, 'ua 没截断');
    assert.ok(e.source.length <= 200, 'source 没截断');
    assert.ok(e.build.length <= 40, 'build 没截断');
});

test('空 message 不记 —— 不然探测脚本一按就是一条', () => {
    const { sink } = sinkAt();
    assert.equal(sink.record({ message: '' }, { ip: '1.1.1.1' }).reason, 'empty');
    assert.equal(sink.record({}, { ip: '1.1.1.1' }).reason, 'empty');
    assert.equal(sink.size(), 0);
});

test('🔴 什么烂输入都不许抛 —— 上报通道自己崩了是最讽刺的事', () => {
    const { sink } = sinkAt();
    for (const bad of [null, undefined, 'a string', 42, [], { message: { nested: true } }]) {
        assert.doesNotThrow(() => sink.record(bad, { ip: '1.1.1.1' }));
    }
    assert.doesNotThrow(() => sink.record(err('ok'), undefined));
});

test('缓冲有上限，新的挤掉旧的', () => {
    const { sink, tick } = sinkAt();
    for (let i = 0; i < MAX_BUFFER + 50; i++) {
        sink.record(err('e' + i), { ip: 'ip' + i });        // 换 IP 绕开限流，这里测的是缓冲
        tick(1);
    }
    assert.equal(sink.size(), MAX_BUFFER);
    assert.equal(sink.list()[0].message, 'e' + (MAX_BUFFER + 49), '最新的应该排在最前');
});

test('list() 不泄漏内部指纹字段', () => {
    const { sink } = sinkAt();
    sink.record(err('x'), { ip: '1.1.1.1' });
    assert.ok(!('_fp' in sink.list()[0]));
});

test('未登录也能上报 —— 登录页出错正是最看不到的那一类', () => {
    const { sink } = sinkAt();
    const r = sink.record(err('login page broke'), { ip: '1.1.1.1' });
    assert.equal(r.accepted, true);
    assert.equal(sink.list()[0].username, null);
});
