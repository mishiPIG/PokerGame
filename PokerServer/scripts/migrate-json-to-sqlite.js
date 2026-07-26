#!/usr/bin/env node
'use strict';

const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');
const { importLegacy } = require('../src/storage/legacy-import');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        if (key === 'dry-run') out.dryRun = true;
        else out[key] = argv[++i];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const baseDir = path.resolve(__dirname, '..');
const databasePath = args.dryRun ? ':memory:' : (args.database || process.env.POKER_DB_PATH);
if (!databasePath) {
    console.error('缺少 --database 或 POKER_DB_PATH');
    process.exitCode = 1;
} else {
    const service = createDatabaseService({ databasePath, baseDir, allowCreate: true });
    try {
        const report = importLegacy(service, {
            data: args.data || path.join(baseDir, 'data.json'),
            hands: args.hands || path.join(baseDir, 'hands.jsonl'),
            feedback: args.feedback || path.join(baseDir, 'feedback.jsonl')
        });
        const counts = {
            users: service.raw.prepare('SELECT count(*) AS n FROM users').get().n,
            messages: service.raw.prepare('SELECT count(*) AS n FROM user_messages').get().n,
            hands: service.raw.prepare('SELECT count(*) AS n FROM hands').get().n,
            handPlayers: service.raw.prepare('SELECT count(*) AS n FROM hand_players').get().n,
            handActions: service.raw.prepare('SELECT count(*) AS n FROM hand_actions').get().n,
            feedback: service.raw.prepare('SELECT count(*) AS n FROM feedback').get().n
        };
        console.log(JSON.stringify({
            dryRun: !!args.dryRun,
            report,
            counts,
            integrity: service.integrityCheck(),
            foreignKeyErrors: service.foreignKeyCheck().length
        }, null, 2));
    } finally {
        service.close();
    }
}
