#!/usr/bin/env node
'use strict';

// 登录来源保留期清理（2026-09-21）。
//
// IP 属于个人数据，**不能无限期留着**。这个脚本删掉超过保留期的来源记录，
// 以及不再被任何事件引用的地理缓存（那也是一条指向真人的 IP）。
//
// ⚠️ 为什么单独做成 cron 而不是在服务里定时跑：
//    删除是不可逆的，放在服务里意味着「进程活着才会清」——
//    而进程崩了/重启了这件事没人保证。cron 是系统级的，进程死了它照样跑。
//    （同一个理由让备份、审计、存活探针也都走 cron。）
//
// 用法：node tools/prune-login-events.js [--days 180] [--dry-run]
// 退出码：0 正常（--dry-run 也是 0）；1 出错。

const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DAYS = Number(opt('days', 180));
const DRY = args.includes('--dry-run');

if (!(DAYS > 0)) {
    console.error('--days 必须是正数');
    process.exit(1);
}

function main() {
    // 直接用服务里的那套库，避免另写一份 SQL 造成两处口径不一致
    const { createDatabaseService } = require(path.join(__dirname, '../src/storage/database-service'));
    const db = createDatabaseService({ allowCreate: false });
    const cutoff = Date.now() - DAYS * 86400000;

    const before = db.raw.prepare('SELECT COUNT(*) n FROM login_events').get().n;
    const stale = db.raw.prepare('SELECT COUNT(*) n FROM login_events WHERE created_at_ms < ?')
        .get(cutoff).n;

    console.log(`保留期 ${DAYS} 天 · 总记录 ${before} 条 · 超期 ${stale} 条`);
    if (DRY) {
        console.log('(--dry-run，什么都没删)');
        db.close();
        return;
    }
    const removed = db.loginEvents.purgeOlderThan({ days: DAYS });
    const after = db.raw.prepare('SELECT COUNT(*) n FROM login_events').get().n;
    const geo = db.raw.prepare('SELECT COUNT(*) n FROM ip_geo').get().n;
    console.log(`已删除 ${removed} 条，剩余 ${after} 条；地理缓存剩 ${geo} 条`);
    db.close();
}

try {
    main();
} catch (e) {
    console.error('清理失败：' + e.message);
    process.exit(1);
}
