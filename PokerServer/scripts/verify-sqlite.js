#!/usr/bin/env node
'use strict';

const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

const baseDir = path.resolve(__dirname, '..');
// 本机未指定路径时检查默认开发库；生产环境必须通过 POKER_DB_PATH 显式指定外置数据库。
const databasePath = process.argv[2] || process.env.POKER_DB_PATH || path.join(baseDir, '.local', 'pokerdojo.sqlite');
{
    const service = createDatabaseService({
        databasePath,
        baseDir,
        allowCreate: false
    });
    try {
        const integrity = service.integrityCheck();
        const foreignKeys = service.foreignKeyCheck();
        const counts = {};
        for (const table of [
            'users', 'wallet_transactions', 'daily_checkins', 'user_messages', 'feedback',
            'matches', 'match_players', 'active_match_states', 'match_events',
            'hands', 'hand_players', 'hand_actions'
        ]) {
            counts[table] = service.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
        }
        console.log(JSON.stringify({ integrity, foreignKeyErrors: foreignKeys, counts }, null, 2));
        if (integrity !== 'ok' || foreignKeys.length) process.exitCode = 2;
    } finally {
        service.close();
    }
}
