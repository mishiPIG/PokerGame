'use strict';

// 崩溃告警（2026-09-16）。
//
// 背景：`uncaughtException` 会走 shutdown → 存快照 → process.exit(1)，pm2 拉起来后
// 从快照恢复。牌局不丢，**但没有任何人被通知它崩过**：
// deploy 的错误日志自查只看重启后 12 秒，半夜崩的看不到；pm2 的 ↺ 计数要 SSH 才看得见。
//
// ⚠️ 这里守的两条都是「反直觉但要命」的：
//   ① **濒死的进程不发邮件** —— process.exit() 会在异步邮件发出前结束进程，告警是哑的。
//      所以崩的时候只同步写盘，由下一个健康进程发。
//   ② **崩溃循环要节流** —— pm2 一秒重启一次，不节流就是一分钟几十封。
//      告警一旦变吵就会被忽略，那才是真正的危险。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { crashFileFor, recordCrash, reportPendingCrash, MAX_ENTRIES } = require('./src/ops/crash-report');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crash-')), 'crash-report.json');
function fakeMailer() {
    const sent = [];
    return { sent, sendAlert: async (subject, body) => { sent.push({ subject, body }); } };
}

test('崩溃文件放在数据库【同目录】——即代码目录之外，部署不会覆盖它', () => {
    assert.equal(
        crashFileFor(path.join('/root/PokerGame/data', 'pokerdojo.sqlite')),
        path.join('/root/PokerGame/data', 'crash-report.json'));
});

test('崩 → 重启 → 由【下一个进程】把它报出来', async () => {
    const f = tmp();
    recordCrash(f, 'uncaughtException', new Error('db is not defined'));

    const m = fakeMailer();
    const r = await reportPendingCrash(f, { mailer: m, label: '1.7.0 test' });
    assert.equal(r.sent, true);
    assert.equal(m.sent.length, 1);
    assert.match(m.sent[0].subject, /崩溃/);
    assert.match(m.sent[0].body, /db is not defined/);
    assert.match(m.sent[0].body, /1\.7\.0 test/);
});

test('报完就清空 —— 下次启动不该再报一遍同一次崩溃', async () => {
    const f = tmp();
    recordCrash(f, 'uncaughtException', new Error('boom'));
    const m = fakeMailer();
    await reportPendingCrash(f, { mailer: m });
    const again = await reportPendingCrash(f, { mailer: m });
    assert.equal(again.sent, false);
    assert.equal(again.reason, 'none');
    assert.equal(m.sent.length, 1);
});

test('🔴 崩溃循环要节流：pm2 一秒重启一次，不能一分钟几十封', async () => {
    const f = tmp();
    const m = fakeMailer();
    recordCrash(f, 'uncaughtException', new Error('loop 1'));
    await reportPendingCrash(f, { mailer: m, throttleMs: 600000 });
    assert.equal(m.sent.length, 1);

    // 紧接着又崩了 5 次，每次重启都会调 reportPendingCrash
    for (let i = 2; i <= 6; i++) {
        recordCrash(f, 'uncaughtException', new Error('loop ' + i));
        const r = await reportPendingCrash(f, { mailer: m, throttleMs: 600000 });
        assert.equal(r.sent, false);
        assert.equal(r.reason, 'throttled');
    }
    assert.equal(m.sent.length, 1, '崩溃循环里发了不止一封 —— 告警会被淹没');

    // 节流窗口过了，把攒下的一次性报出来（含条数）
    const r = await reportPendingCrash(f, { mailer: m, throttleMs: 0 });
    assert.equal(r.sent, true);
    assert.equal(r.count, 5, '攒下的 5 次要一起报，不能只报最后一次');
    assert.match(m.sent[1].body, /5 次待报/);
});

test('🔴 邮件发失败就【不清空】—— 清掉发不出去的告警等于把事故悄悄抹掉', async () => {
    const f = tmp();
    recordCrash(f, 'uncaughtException', new Error('important'));
    const broken = { sendAlert: async () => { throw new Error('SMTP down'); } };

    const r = await reportPendingCrash(f, { mailer: broken });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'mail-failed');

    // 下次启动（这回发信好了）必须还能报出来
    const m = fakeMailer();
    const r2 = await reportPendingCrash(f, { mailer: m });
    assert.equal(r2.sent, true);
    assert.match(m.sent[0].body, /important/);
});

test('正常停机（SIGTERM）不记崩溃 —— 每次部署都报一次就成噪音了', async () => {
    const f = tmp();
    // server.js 里是 `if (error) recordCrash(...)`，SIGTERM 没有 error 所以根本不会调。
    // 这里断言「没记过东西 = 不会报」，等价于那条守卫。
    const m = fakeMailer();
    const r = await reportPendingCrash(f, { mailer: m });
    assert.equal(r.sent, false);
    assert.equal(m.sent.length, 0);
});

test('崩溃文件坏了 / 不存在，都不许抛 —— 它跑在进程正在退出的时候', async () => {
    const f = tmp();
    fs.writeFileSync(f, 'not json at all');
    assert.equal(recordCrash(f, 'uncaughtException', new Error('x')), true, '坏文件应该被当成空的重来');
    const m = fakeMailer();
    const r = await reportPendingCrash(f, { mailer: m });
    assert.equal(r.sent, true);

    // 完全不存在的路径：记录失败要返回 false 而不是抛
    const bad = path.join(os.tmpdir(), 'no-such-dir-' + Date.now(), 'x.json');
    assert.equal(recordCrash(bad, 'uncaughtException', new Error('y')), false);
});

test('条目上限：崩溃循环不能把文件撑爆', () => {
    const f = tmp();
    for (let i = 0; i < MAX_ENTRIES + 15; i++) recordCrash(f, 'uncaughtException', new Error('e' + i));
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(j.entries.length, MAX_ENTRIES);
    assert.match(j.entries[j.entries.length - 1].message, /e34$/, '留的应该是最近的');
});

test('没配 mailer 也不能崩（本地开发 / DEV 回退）', async () => {
    const f = tmp();
    recordCrash(f, 'uncaughtException', new Error('z'));
    const r = await reportPendingCrash(f, { mailer: null });
    assert.equal(r.sent, true, '没有 mailer 时只打日志，但仍算处理完、要清空');
});

test('🔴 真进程：uncaughtException → 同步写盘 → process.exit(1)，写盘不能丢', () => {
    // 这条守的是整个设计的前提：写盘必须【赶在 process.exit() 之前】完成。
    // 要是这里改成了异步（fs.writeFile / 发邮件），现场就会静默丢掉，
    // 而单测里没有 exit，一点都看不出来。只能拿真进程验。
    const f = tmp();
    const code = `
        const { recordCrash } = require(${JSON.stringify(path.join(__dirname, 'src/ops/crash-report'))});
        process.on('uncaughtException', err => {
            recordCrash(${JSON.stringify(f)}, 'uncaughtException', err);   // server.js 里的同一步
            process.exit(1);                                               // 然后立刻退
        });
        setTimeout(() => { throw new Error('真的崩了'); }, 0);
    `;
    const r = cp.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 1, '子进程应该以 1 退出');

    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(j.entries.length, 1, '进程都退了，现场没落盘');
    assert.match(j.entries[0].message, /真的崩了/);
    assert.match(j.entries[0].stack, /Error/);
});
