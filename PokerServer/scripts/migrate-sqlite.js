#!/usr/bin/env node
'use strict';

const path = require('path');
const { createDatabaseService } = require('../src/storage/database-service');

const databasePath = process.argv[2] || process.env.POKER_DB_PATH;
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
        console.log(JSON.stringify({
            databasePath,
            integrity: service.integrityCheck(),
            foreignKeyErrors: service.foreignKeyCheck()
        }, null, 2));
    } finally {
        service.close();
    }
}
