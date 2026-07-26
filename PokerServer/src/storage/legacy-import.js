'use strict';

const fs = require('fs');
const crypto = require('crypto');

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
}

function readJsonLines(file) {
    if (!file || !fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const records = [];
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
            records.push(JSON.parse(lines[index]));
        } catch (error) {
            throw new Error(`${file}:${index + 1} JSON 解析失败: ${error.message}`);
        }
    }
    return records;
}

function alreadyImported(service, kind, hash) {
    return !!service.raw.prepare(`
        SELECT 1 FROM legacy_imports WHERE source_kind = ? AND source_sha256 = ?
    `).get(kind, hash);
}

function markImported(service, kind, file, hash, rows) {
    service.raw.prepare(`
        INSERT INTO legacy_imports(
            source_kind, source_path, source_sha256, imported_rows, imported_at_ms
        ) VALUES (?, ?, ?, ?, ?)
    `).run(kind, file, hash, rows, Date.now());
}

function importDataJson(service, file) {
    if (!file || !fs.existsSync(file)) return { rows: 0, skipped: true };
    const hash = sha256File(file);
    if (alreadyImported(service, 'users', hash)) return { rows: 0, alreadyImported: true, hash };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const users = Object.values(parsed.users || {});
    service.raw.transaction(() => {
        for (const user of users) {
            service.importUser(user);
            for (const message of user.messages || []) service.addMessage(user.id, message);
        }
        markImported(service, 'users', file, hash, users.length);
    })();
    return {
        rows: users.length,
        messages: users.reduce((sum, user) => sum + (user.messages || []).length, 0),
        hash
    };
}

function importHandsJsonl(service, file) {
    if (!file || !fs.existsSync(file)) return { rows: 0, skipped: true };
    const hash = sha256File(file);
    if (alreadyImported(service, 'hands', hash)) return { rows: 0, alreadyImported: true, hash };
    const records = readJsonLines(file);
    service.raw.transaction(() => {
        for (const record of records) service.appendHand(record);
        markImported(service, 'hands', file, hash, records.length);
    })();
    return { rows: records.length, hash };
}

function importFeedbackJsonl(service, file) {
    if (!file || !fs.existsSync(file)) return { rows: 0, skipped: true };
    const hash = sha256File(file);
    if (alreadyImported(service, 'feedback', hash)) return { rows: 0, alreadyImported: true, hash };
    const records = readJsonLines(file);
    service.raw.transaction(() => {
        for (const record of records) service.appendFeedback(record);
        markImported(service, 'feedback', file, hash, records.length);
    })();
    return { rows: records.length, hash };
}

function importLegacy(service, sources) {
    return {
        users: importDataJson(service, sources.data),
        hands: importHandsJsonl(service, sources.hands),
        feedback: importFeedbackJsonl(service, sources.feedback)
    };
}

module.exports = {
    importLegacy,
    importDataJson,
    importHandsJsonl,
    importFeedbackJsonl,
    readJsonLines,
    sha256File
};
