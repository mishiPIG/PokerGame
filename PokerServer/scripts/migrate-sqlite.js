#!/usr/bin/env node
'use strict';

const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

// --quick：只做迁移（打开数据库时自动应用），跳过整库完整性 / 外键检查。
// 部署时用它：这一步在停机窗口里，而整库检查在生产 200MB 的库上要 ~25 秒（2026-11-14 实测停机 29 秒）。
// 跳过是安全的 —— 部署前快照会在服务启动之后完整校验一遍（scripts/deploy-remote.sh 第 4 步）。
const quick = process.argv.includes('--quick');
const databasePath = process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.POKER_DB_PATH;
if (!databasePath) {
    console.error('用法: node scripts/migrate-sqlite.js /path/to/pokerdojo.sqlite');
    process.exitCode = 1;
} else {
    const service = createDatabaseService({
        databasePath,
        baseDir: path.resolve(__dirname, '..'),
        allowCreate: false
    });
    try {
        console.log(JSON.stringify(quick ? { databasePath, migrated: true } : {
            databasePath,
            integrity: service.integrityCheck(),
            foreignKeyErrors: service.foreignKeyCheck()
        }, null, 2));
    } finally {
        service.close();
    }
}
