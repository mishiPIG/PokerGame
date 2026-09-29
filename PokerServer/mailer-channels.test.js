'use strict';

// 发信通道（2026-09-29）。
//
// 守的是一件事：【验证码把额度烧光时，告警必须还能发出来】。
// 原来全站共用一个免费 163（每天 50 封），验证码一旦耗尽额度，
// 同一天的备份/审计/崩溃告警也一起哑掉 —— 最需要喊的时候恰好发不出声。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('./mailer');

// 假的 nodemailer：按 auth.user 区分是哪个通道，记下每一封
function fakeTransports({ failFor = new Set() } = {}) {
    const sent = [];
    const createTransport = (opts) => ({
        async sendMail(msg) {
            if (failFor.has(opts.auth.user)) {
                const e = new Error('550 User has exceeded the daily limit'); e.responseCode = 550; throw e;
            }
            sent.push({ via: opts.auth.user, ...msg });
        },
    });
    return { sent, createTransport };
}
const quietLog = { log() {}, error() {} };
const flush = () => new Promise(r => setImmediate(r));

const MAIN = { host: 'smtp.163.com', port: 465, user: 'main@163.com', pass: 'x', alertTo: 'admin@example.com' };
const WITH_CODES = { ...MAIN, codes: { host: 'smtp.provider.example', port: 465, user: 'codes-user', pass: 'y', from: '德扑道场 <noreply@pokerdojo.space>' } };

test('🔴 配了 codes 块：验证码走 codes，告警和反馈留在主通道', async () => {
    const f = fakeTransports();
    const m = createMailer({ readConfig: () => WITH_CODES, createTransport: f.createTransport, log: quietLog });
    await m.sendCode('p@example.com', '123456', 'register');
    await m.sendAlert('测试', 'body');
    await m.sendFeedback({ username: 'u', userId: 'id', ts: 0, text: 't' });
    assert.deepEqual(f.sent.map(x => x.via), ['codes-user', 'main@163.com', 'main@163.com']);
    assert.equal(f.sent[0].from, '德扑道场 <noreply@pokerdojo.space>', '验证码要用已验证域名的发件人');
});

test('没配 codes 块：全部走主通道（向后兼容，现有 mail.json 不用改就能跑）', async () => {
    const f = fakeTransports();
    const m = createMailer({ readConfig: () => MAIN, createTransport: f.createTransport, log: quietLog });
    await m.sendCode('p@example.com', '123456', 'register');
    await m.sendAlert('测试', 'body');
    assert.deepEqual(f.sent.map(x => x.via), ['main@163.com', 'main@163.com']);
});

test('codes 块缺密码：退回主通道，而不是让验证码直接发不出去', async () => {
    const f = fakeTransports();
    const cfg = { ...MAIN, codes: { user: 'codes-user' } };
    const m = createMailer({ readConfig: () => cfg, createTransport: f.createTransport, log: quietLog });
    await m.sendCode('p@example.com', '123456', 'register');
    assert.equal(f.sent[0].via, 'main@163.com');
});

test('🔴 验证码通道额度耗尽：原错误要抛回去（注册接口靠它回「发送失败」），且告警从主通道发出', async () => {
    const f = fakeTransports({ failFor: new Set(['codes-user']) });
    const m = createMailer({ readConfig: () => WITH_CODES, createTransport: f.createTransport, log: quietLog });
    await assert.rejects(m.sendCode('p@example.com', '123456', 'register'), /daily limit/);
    await flush();
    assert.equal(f.sent.length, 1, '应当恰好发出一封告警');
    assert.equal(f.sent[0].via, 'main@163.com', '🔴 告警必须走主通道，不能和验证码一起哑掉');
    assert.equal(f.sent[0].to, 'admin@example.com');
    assert.match(f.sent[0].text, /550/);
});

test('🔴 告警要节流：一小时内连续失败只报一次，过了一小时再报', async () => {
    const f = fakeTransports({ failFor: new Set(['codes-user']) });
    let t = 1_000_000;
    const m = createMailer({ readConfig: () => WITH_CODES, createTransport: f.createTransport, log: quietLog, now: () => t });
    for (let i = 0; i < 20; i++) {
        await assert.rejects(m.sendCode(`p${i}@example.com`, '1', 'register'));
        t += 60_000;
    }
    await flush();
    assert.equal(f.sent.length, 1, '20 分钟内 20 次失败只该有 1 封告警');
    t += 60 * 60 * 1000;
    await assert.rejects(m.sendCode('late@example.com', '1', 'register'));
    await flush();
    assert.equal(f.sent.length, 2, '过了一小时要再报一次 —— 否则你不知道它还没好');
});

test('共用通道时额度耗尽：告警也发不出，但不许把错误吞掉或抛成别的', async () => {
    const f = fakeTransports({ failFor: new Set(['main@163.com']) });
    const errs = [];
    const m = createMailer({ readConfig: () => MAIN, createTransport: f.createTransport, log: { log() {}, error: (...a) => errs.push(a.join(' ')) } });
    await assert.rejects(m.sendCode('p@example.com', '1', 'register'), /daily limit/);
    await flush();
    assert.ok(errs.some(e => e.includes('告警也没发出去')), '至少要在错误日志里留下「告警也哑了」');
});

test('验证码邮件中英双语（海外玩家收到纯中文邮件认不出哪串是验证码）', async () => {
    const f = fakeTransports();
    const m = createMailer({ readConfig: () => MAIN, createTransport: f.createTransport, log: quietLog });
    await m.sendCode('p@example.com', '654321', 'reset');
    assert.match(f.sent[0].subject, /重置密码/);
    assert.match(f.sent[0].subject, /password reset/i);
    assert.match(f.sent[0].text, /你的验证码是：654321/);
    assert.match(f.sent[0].text, /is: 654321/);
});

test('没配置发信：开发回退，不抛', async () => {
    const m = createMailer({ readConfig: () => null, createTransport: () => { throw new Error('不该被调用'); }, log: quietLog });
    assert.deepEqual(await m.sendCode('p@example.com', '1', 'register'), { dev: true });
    assert.deepEqual(await m.sendAlert('s', 'b'), { dev: true });
    assert.equal(m.isConfigured(), false);
});
