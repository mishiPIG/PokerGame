#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
    return out;
}

const args = parseArgs(process.argv.slice(2));
const databasePath = args.database || process.env.POKER_DB_PATH;
const outputDir = path.resolve(args.output || '.');
if (!databasePath) {
    console.error('用法: node scripts/export-sqlite-to-legacy.js --database DB --output DIR');
    process.exitCode = 1;
} else {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const service = createDatabaseService({ databasePath, allowCreate: false });
    try {
        const userRows = service.raw.prepare(`
            SELECT id, username, email, password_hash, gold, avatar,
                   is_admin AS isAdmin, last_checkin AS lastCheckin,
                   checkin_streak AS checkinStreak, created_at_ms
            FROM users ORDER BY created_at_ms, id
        `).all();
        const messageQuery = service.raw.prepare(`
            SELECT id, message_type AS type, text, is_read AS read, created_at_ms AS ts
            FROM user_messages WHERE user_id = ? ORDER BY created_at_ms, id
        `);
        const users = {};
        for (const user of userRows) {
            user.isAdmin = !!user.isAdmin;
            user.created_at = new Date(user.created_at_ms).toISOString();
            delete user.created_at_ms;
            user.messages = messageQuery.all(user.id).map(message => ({ ...message, read: !!message.read }));
            users[user.id] = user;
        }
        const hands = service.raw.prepare('SELECT payload_json FROM hands ORDER BY started_at_ms, id')
            .all().map(row => JSON.parse(row.payload_json));
        const feedback = service.raw.prepare(`
            SELECT id, user_id AS userId, username, text, contact, created_at_ms AS ts
            FROM feedback ORDER BY created_at_ms, id
        `).all();
        fs.writeFileSync(path.join(outputDir, 'data.json'), `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(outputDir, 'hands.jsonl'), hands.map(row => JSON.stringify(row)).join('\n') + (hands.length ? '\n' : ''), { mode: 0o600 });
        fs.writeFileSync(path.join(outputDir, 'feedback.jsonl'), feedback.map(row => JSON.stringify(row)).join('\n') + (feedback.length ? '\n' : ''), { mode: 0o600 });
        console.log(JSON.stringify({ outputDir, users: userRows.length, hands: hands.length, feedback: feedback.length }));
    } finally {
        service.close();
    }
}
