#!/usr/bin/env node
'use strict';

// 备份看门狗（2026-09-16）。
//
// 🔴 为什么需要它：备份脚本本身已经很扎实——生成一致性快照、**并且立刻校验那份
//    备份文件**，不 ok 就失败退出。但它失败之后，只往 backup.log 里写一行，**没人读**。
//    2026-09-08 就这么静默失败了整整 11 天（CRLF 把 shebang 弄坏了），
//    那 11 天里备份为零，唯一的保险是人工做的那份异地副本。
//
//    **一个只写日志、没人读的检查，等于没有检查。** 这个脚本就是去读它的那个人。
//
// 刻意【不复用】backup-cron.sh 的任何helper：看门狗要能在「备份脚本自己坏掉」时
// 仍然说得出话。它只认硬事实——磁盘上那个文件，以及那个文件能不能打开。
//
// 用法：node tools/check-backups.js <备份目录> [--max-age-hours 26] [--min-keep 3] [--mail]
// 退出码：0 一切正常；1 有问题（cron 可据此告警）

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
const flag = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const MAX_AGE_H = flag('max-age-hours', 26);   // 日备份 + 2 小时余量：晚一点不告警，缺了才告警
const MIN_KEEP = flag('min-keep', 3);
// 异地副本阈值必须【跟实际拉取频率对得上】。现在是【每周】拉一次（本机计划任务），
// 所以阈值取 8 天 = 一周 + 1 天余量（本机不是 24/7，计划任务开了「错过就补跑」，
// 但补跑也得等开机）。
// ⚠️ 阈值定得比拉取间隔短的话，它会【每周都报一次】——
//    告警一旦变吵就会被忽略，那才是真正的危险。
//    以后把拉取改成每天，记得把这个值一起改小（比如 48）。
const OFFSITE_MAX_H = flag('offsite-max-age-hours', 192);
const offsiteMarker = (() => { const i = args.indexOf('--offsite-marker'); return i >= 0 ? args[i + 1] : null; })();
const WANT_MAIL = args.includes('--mail');

if (!dir) {
    console.error('用法: node tools/check-backups.js <备份目录> [--max-age-hours 26] [--min-keep 3] [--mail]');
    process.exit(2);
}

const problems = [];
const notes = [];

function main() {
    if (!fs.existsSync(dir)) { problems.push(`备份目录不存在：${dir}`); return; }

    // 只认每日备份，不认 predeploy 那些——部署很频繁，拿它们当数据就会
    // 「天天都有新备份」，而每日 cron 早死了都看不出来。
    const files = fs.readdirSync(dir)
        .filter(f => /^pokerdojo-\d{8}_\d{6}\.sqlite$/.test(f))
        .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) { problems.push(`${dir} 里一份每日备份都没有`); return; }
    notes.push(`共 ${files.length} 份每日备份`);

    if (files.length < MIN_KEEP) {
        problems.push(`只剩 ${files.length} 份每日备份（期望至少 ${MIN_KEEP} 份）——轮转或备份可能有问题`);
    }

    // ⓪ 异地副本还在不在拉。
    //    🔴 服务器本机这 14 份，整机丢失（实例误删 / 区域故障 / 账号问题）会一起没。
    //    异地副本是这条链路上最后的保险，而它跑在本机上、本机不会自己喊——
    //    所以由这台 24/7 且能发信的服务器替它喊。
    if (offsiteMarker) {
        if (!fs.existsSync(offsiteMarker)) {
            problems.push(`异地副本从来没拉过（找不到 ${offsiteMarker}）`);
        } else {
            const ts = Number(String(fs.readFileSync(offsiteMarker)).trim()) * 1000;
            const h = (Date.now() - ts) / 3600000;
            notes.push(`异地副本：${h.toFixed(1)} 小时前拉过`);
            if (!ts || h > OFFSITE_MAX_H) {
                problems.push(`异地副本已 ${h.toFixed(1)} 小时没拉（阈值 ${OFFSITE_MAX_H}h）`
                    + ' —— 本机的定时拉取可能停了；现在所有备份都只在这一台机器上');
            }
        }
    }

    // ① 新鲜度：最容易出、也最致命的一种失败就是「它早就不跑了」
    const newest = files[0];
    const ageH = (Date.now() - newest.mtime) / 3600000;
    notes.push(`最新：${newest.name}（${ageH.toFixed(1)} 小时前）`);
    if (ageH > MAX_AGE_H) {
        problems.push(`最新备份是 ${ageH.toFixed(1)} 小时前的（阈值 ${MAX_AGE_H}h）——每日备份很可能已经停了`);
    }

    // ② 那份文件真的能打开吗。WAL 下复制出来的坏备份平时看不出来，
    //    等真要恢复时才发现——那时就晚了。
    let db;
    try {
        db = new Database(newest.full, { readonly: true, fileMustExist: true });
        const integ = db.pragma('integrity_check')[0].integrity_check;
        if (integ !== 'ok') { problems.push(`最新备份完整性不是 ok：${integ}`); return; }
    } catch (e) {
        problems.push(`最新备份打不开：${e.message}`);
        return;
    }

    // ③ 内容合理性：「备份成功但是个空库」比没有备份更危险——
    //    它看起来一切正常，直到你拿它去恢复。
    try {
        const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
        const hands = db.prepare('SELECT COUNT(*) n FROM hands').get().n;
        notes.push(`内容：用户 ${users} · 牌谱 ${hands}`);
        if (users === 0) problems.push('最新备份里一个用户都没有——这不是备份，是个空壳');

        // 牌谱只增不减。比上一份少 = 备的可能是另一个库、或者数据被截断了。
        if (files[1]) {
            const prev = new Database(files[1].full, { readonly: true, fileMustExist: true });
            const prevHands = prev.prepare('SELECT COUNT(*) n FROM hands').get().n;
            prev.close();
            if (hands < prevHands) {
                problems.push(`牌谱数在倒退：${files[1].name} 有 ${prevHands} 手，最新这份只有 ${hands} 手`);
            }
        }
    } catch (e) {
        problems.push(`读最新备份的内容失败：${e.message}`);
    } finally {
        db.close();
    }
}

(async () => {
    main();
    const head = problems.length ? `❌ 备份异常（${problems.length} 项）` : '✅ 备份正常';
    const body = [head, '', ...problems.map(p => '  · ' + p), problems.length ? '' : null, ...notes.map(n => '  ' + n)]
        .filter(l => l !== null).join('\n');
    console.log(body);

    if (problems.length && WANT_MAIL) {
        try {
            // ⚠️ 必须 await：process.exit() 会在异步邮件发出前结束进程，
            //    那样告警就是哑的（审计那条 cron 踩过这个坑）。
            const mailer = require('../mailer');
            await mailer.sendAlert('备份异常', body + `\n\n目录：${dir}\n时间：${new Date().toISOString()}`);
            console.log('[check-backups] 告警邮件已发出');
        } catch (e) {
            console.error('[check-backups] 告警邮件发送失败：', e.message);
        }
    }
    process.exit(problems.length ? 1 : 0);
})();
