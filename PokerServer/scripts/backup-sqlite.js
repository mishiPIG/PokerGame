#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

async function main() {
    const source = process.argv[2] || process.env.POKER_DB_PATH;
    const destination = process.argv[3];
    if (!source || !destination) {
        throw new Error('用法: node scripts/backup-sqlite.js SOURCE.sqlite BACKUP.sqlite');
    }
    if (!fs.existsSync(source)) throw new Error(`数据库不存在: ${source}`);
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true, mode: 0o700 });
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
        await db.backup(destination);
    } finally {
        db.close();
    }
    const check = new Database(destination, { readonly: true, fileMustExist: true });
    try {
        const integrity = check.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`备份完整性检查失败: ${integrity}`);
    } finally {
        check.close();
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
    console.log(JSON.stringify({
        source,
        destination,
        bytes: fs.statSync(destination).size,
        sha256,
        integrity: 'ok'
    }));
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
