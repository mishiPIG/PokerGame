'use strict';

// 崩溃告警（2026-09-16）。
//
// 🔴 先纠正一个长期记错的事实：CLAUDE.md 写着「uncaughtException 只记录不退出」，
//    但实际 `server.js` 的 `uncaughtException` → `shutdown(signal, error)`
//    → **给所有房间存快照 → server.close → process.exit(1)**，然后由 pm2 拉起来、
//    启动时从快照恢复。行为在 SQLite 那批之后就变了（而且这样比「带病继续跑」更好：
//    uncaughtException 之后进程状态本来就不可信）。
//
// 于是问题变成：**它崩过、重启过，而没有任何人被通知。**
//    `deploy.sh` 的发版后错误日志自查只看重启后 12 秒，半夜崩的看不到；
//    pm2 的 ↺ 计数要 SSH 上去才看得见。
//
// ⚠️ 关键设计：**不让濒死的进程去发邮件。**
//    发信是异步的，而 `process.exit()` 会在邮件发出前结束进程 —— 告警会是哑的
//    （审计那条 cron 踩过一模一样的坑）。
//    所以拆成两步：
//      ① 崩的那一刻只做一次【同步】写盘，记下现场；
//      ② 下一个进程启动后（pm2 一秒内就拉起来了），由【健康的】进程把它发出去。
//    额外好处：跨重启也不会丢，而且天然能数出「崩了几次」。

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 20;              // 只留最近 20 条，防崩溃循环把文件撑爆
const DEFAULT_THROTTLE_MS = 10 * 60 * 1000;

function crashFileFor(databasePath) {
    // 跟数据库放一起 = 在代码目录【之外】，部署的 tar 不会覆盖它
    return path.join(path.dirname(databasePath), 'crash-report.json');
}

function readSafe(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        return { entries: Array.isArray(j.entries) ? j.entries : [], lastAlertAt: j.lastAlertAt || 0 };
    } catch {
        return { entries: [], lastAlertAt: 0 };      // 文件不存在 / 坏了都当成空，绝不抛
    }
}

// 崩溃那一刻调用。**必须同步、必须绝不抛异常**——此时进程正在退出，
// 这里再抛一个会把快照那步也带走。
function recordCrash(file, signal, error) {
    try {
        const state = readSafe(file);
        state.entries.push({
            at: Date.now(),
            signal,
            message: String(error?.message || error || '(无 message)').slice(0, 500),
            stack: String(error?.stack || '').slice(0, 4000),
        });
        if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
        fs.writeFileSync(file, JSON.stringify(state));
        return true;
    } catch {
        return false;                                 // 记不下也不能影响退出流程
    }
}

function formatReport(entries, label) {
    const lines = [`❌ 服务进程崩溃并已重启（${entries.length} 次待报）`, '', `环境：${label}`, ''];
    for (const e of entries.slice(-5)) {
        lines.push(`── ${new Date(e.at + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)} (UTC+8) · ${e.signal}`);
        lines.push(`   ${e.message}`);
        if (e.stack) lines.push(e.stack.split('\n').slice(0, 6).map(l => '   ' + l.trim()).join('\n'));
        lines.push('');
    }
    if (entries.length > 5) lines.push(`（只列最近 5 条，共 ${entries.length} 条）`, '');
    lines.push('牌局有快照，重启后会恢复；但崩溃本身要查。先看 pm2 错误日志。');
    return lines.join('\n');
}

// 启动后调用。异步、失败不影响启动。
// 节流：崩溃循环时 pm2 会一秒重启一次，不节流就是一分钟几十封邮件——
// **告警一旦变吵就会被忽略，那才是真正的危险。**
async function reportPendingCrash(file, { mailer, label = 'unknown', throttleMs = DEFAULT_THROTTLE_MS } = {}) {
    const state = readSafe(file);
    if (!state.entries.length) return { sent: false, reason: 'none' };

    const since = Date.now() - (state.lastAlertAt || 0);
    if (state.lastAlertAt && since < throttleMs) {
        return { sent: false, reason: 'throttled', pending: state.entries.length };
    }

    const body = formatReport(state.entries, label);
    console.error('[crash] 上次运行崩溃过：\n' + body);
    try {
        if (mailer?.sendAlert) await mailer.sendAlert('服务进程崩溃', body);
    } catch (e) {
        console.error('[crash] 告警邮件发送失败：', e.message);
        return { sent: false, reason: 'mail-failed', pending: state.entries.length };
    }
    // 发出去了才清空。发失败就留着，下次启动再试——
    // 清空发不出去的告警等于把事故悄悄抹掉。
    try {
        fs.writeFileSync(file, JSON.stringify({ entries: [], lastAlertAt: Date.now() }));
    } catch { /* 清不掉最多重复报一次，不是大问题 */ }
    return { sent: true, count: state.entries.length };
}

module.exports = { crashFileFor, recordCrash, reportPendingCrash, formatReport, MAX_ENTRIES };
