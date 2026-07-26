'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureParent(databasePath) {
    if (databasePath === ':memory:') return;
    const dir = path.dirname(databasePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function applyMigrations(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version       INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
        )
    `);
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => /^\d+[-_].+\.sql$/.test(name))
        .sort();
    const mark = db.prepare('INSERT INTO schema_migrations(version, name, applied_at_ms) VALUES (?, ?, ?)');
    for (const file of files) {
        const version = Number.parseInt(file, 10);
        if (applied.has(version)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        db.transaction(() => {
            db.exec(sql);
            mark.run(version, file, Date.now());
        })();
        console.log(`[db] migration applied version=${version} name=${file}`);
    }
}

function openSqlite(databasePath, { allowCreate = true } = {}) {
    if (databasePath !== ':memory:' && !allowCreate && !fs.existsSync(databasePath)) {
        throw new Error(`DATABASE_NOT_FOUND:${databasePath}`);
    }
    ensureParent(databasePath);
    const db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
    if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    applyMigrations(db);
    return db;
}

module.exports = { openSqlite, applyMigrations };
