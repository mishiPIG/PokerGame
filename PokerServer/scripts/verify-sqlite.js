#!/usr/bin/env node
'use strict';

const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

const databasePath = process.argv[2] || process.env.POKER_DB_PATH;
if (!databasePath) {
    console.error('用法: node scripts/verify-sqlite.js /path/to/pokerdojo.sqlite');
    process.exitCode = 1;
} else {
    const service = createDatabaseService({
        databasePath,
        baseDir: path.resolve(__dirname, '..'),
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
