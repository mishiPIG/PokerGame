'use strict';

// 备份看门狗（2026-09-16）。
//
// 备份脚本本身很扎实：生成一致性快照、并且【立刻校验那份备份文件】，不 ok 就失败退出。
// 但它失败之后只往 backup.log 里写一行，**没人读** —— 2026-09-08 就这么静默失败了
// 整整 11 天（CRLF 把 shebang 弄坏了），那 11 天里备份为零。
// **一个只写日志、没人读的检查，等于没有检查。** tools/check-backups.js 就是去读它的那个人。
//
// 而看门狗自己更要验反向：**一个分不清好坏的看门狗比没有更糟**，
// 它会让人以为有人在看着。下面每一种坏法都必须叫得出来。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Database = require('better-sqlite3');

const TOOL = path.join(__dirname, 'tools', 'check-backups.js');

function run(dir) {
    const r = cp.spawnSync(process.execPath, [TOOL, dir], { encoding: 'utf8', cwd: __dirname });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function mkdb(file, { users = 3, hands = 10 } = {}) {
    const db = new Database(file);
    db.exec('CREATE TABLE users(id TEXT); CREATE TABLE hands(id TEXT);');
    for (let i = 0; i < users; i++) db.prepare('INSERT INTO users VALUES (?)').run('u' + i);
    for (let i = 0; i < hands; i++) db.prepare('INSERT INTO hands VALUES (?)').run('h' + i);
    db.close();
}
const stamp = d => `pokerdojo-${d}.sqlite`;
function setAge(file, hours) {
    const t = new Date(Date.now() - hours * 3600000);
    fs.utimesSync(file, t, t);
}

// 正常现场：三份，越新牌谱越多，最新的 2 小时前
function fresh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkchk-'));
    const days = [['20260914_040001', 8, 50], ['20260915_040001', 9, 26], ['20260916_040001', 10, 2]];
    for (const [d, hands, age] of days) {
        const f = path.join(dir, stamp(d));
        mkdb(f, { hands });
        setAge(f, age);
    }
    return dir;
}

test('一切正常时不告警（否则告警会变吵，而吵的告警等于没有）', () => {
    const { code, out } = run(fresh());
    assert.equal(code, 0, out);
    assert.match(out, /✅ 备份正常/);
});

test('🔴 每日备份停了 → 必须叫', () => {
    const dir = fresh();
    for (const f of fs.readdirSync(dir)) setAge(path.join(dir, f), 40);
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /很可能已经停了/);
});

test('🔴 一份都没有 → 必须叫', () => {
    const dir = fresh();
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /一份每日备份都没有/);
});

test('🔴 最新那份是坏文件 → 必须叫（WAL 下复制出来的坏备份平时看不出来）', () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, stamp('20260917_040001')), 'this is not a sqlite file');
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /打不开/);
});

test('🔴 备份成功但是个空库 → 必须叫（最危险的一种：看起来一切正常）', () => {
    const dir = fresh();
    mkdb(path.join(dir, stamp('20260917_040001')), { users: 0, hands: 0 });
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /空壳/);
});

test('🔴 牌谱数在倒退 → 必须叫（备到了别的库，或者数据被截断）', () => {
    const dir = fresh();
    mkdb(path.join(dir, stamp('20260917_040001')), { users: 3, hands: 4 });
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /倒退/);
});

test('🔴 只剩一份（轮转异常）→ 必须叫', () => {
    const dir = fresh();
    fs.unlinkSync(path.join(dir, stamp('20260914_040001')));
    fs.unlinkSync(path.join(dir, stamp('20260915_040001')));
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /只剩 1 份/);
});

test('🔴 predeploy 的备份不算数 —— 否则天天部署会掩盖「每日 cron 已死」', () => {
    // 这条是这个看门狗最容易被做废的地方：部署很频繁，predeploy 文件天天在更新，
    // 把它们算进「最新备份」的话，每日备份停了三个月都看不出来。
    const dir = fresh();
    for (const f of fs.readdirSync(dir)) setAge(path.join(dir, f), 40);
    fs.writeFileSync(path.join(dir, 'pokerdojo-predeploy-20260917-120000.sqlite'), 'x');
    const { code, out } = run(dir);
    assert.equal(code, 1, '把 predeploy 当成了每日备份');
    assert.match(out, /很可能已经停了/);
});
