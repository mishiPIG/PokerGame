#!/usr/bin/env node
'use strict';
/**
 * 清空指向已下线旧头像（/avatars/aN.svg）的用户 avatar 字段。
 *
 * 背景：2026-08-08 旧头像 a1–a12 被移除（玩家反映太丑）。用户表里存的是 URL 字符串，
 * 文件没了就会变成裂图。清成 null 后，客户端自然回退到「首字母色块」（等同于选了"无"）。
 *
 * 幂等：可重复执行。用法：
 *   node scripts/clear-legacy-avatars.js            查看会影响多少人（不改数据）
 *   node scripts/clear-legacy-avatars.js --apply    实际执行
 */
const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

const apply = process.argv.includes('--apply');
const dbPath = process.env.POKER_DB_PATH || undefined;
const db = createDatabaseService({ databasePath: dbPath, baseDir: path.resolve(__dirname, '..'), allowCreate: false });

const LEGACY = /^\/avatars\/a\d+\.svg$/;
const users = db.getAllUsers();
const hit = users.filter(u => u.avatar && LEGACY.test(u.avatar));

console.log(`用户总数 ${users.length}，其中使用旧头像的 ${hit.length} 人：`);
hit.forEach(u => console.log(`  ${u.username}  ${u.avatar}`));

if (!hit.length) { console.log('无需处理 ✅'); process.exit(0); }
if (!apply) { console.log('\n（预览模式，未改动。加 --apply 才真正执行）'); process.exit(0); }

let done = 0;
for (const u of hit) { db.setAvatar(u.id, null); done++; }
const left = db.getAllUsers().filter(u => u.avatar && LEGACY.test(u.avatar)).length;
console.log(`\n已清空 ${done} 人的旧头像，剩余 ${left} 人 ${left === 0 ? '✅' : '❌'}`);
process.exit(left === 0 ? 0 : 1);
