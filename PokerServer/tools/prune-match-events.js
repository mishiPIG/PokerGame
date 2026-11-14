#!/usr/bin/env node
'use strict';
// 一次性清理：删掉 match_events 里没有信息量的事件行（2026-11-14，用户确认「没用就可以删」）。
//
//   state_committed      每次广播一条，payload 恒为 {}            （全量排查时 12.4 万行，占 63%）
//   next_hand_scheduled  每手结束排下一手时一条，只记了个时间戳    （3 万行）
//
// 这两种从 1.11.0 起已经不再写入（match-repository 的 SILENT_EVENTS）。
// 没有任何代码读 match_events：重启恢复靠 active_match_states，钱靠 wallet_transactions，牌局靠 hands。
// 有内容的事件（结算、补码、straddle、多次发牌…）不动。
//
// 用法：POKER_DB_PATH=<库路径> node tools/prune-match-events.js [--dry-run]
// 服务运行中也可以跑：按 2000 行一批删，每批之间停一下，不长时间占着写锁、不影响牌局。
// 删掉的空间会被后续写入复用；文件本身不会变小（要变小得 VACUUM，那需要停服，不值得）。

const Database = require('better-sqlite3');

const dbPath = process.env.POKER_DB_PATH || process.argv.find(a => a.endsWith('.sqlite'));
const dryRun = process.argv.includes('--dry-run');
const TYPES = ['state_committed', 'next_hand_scheduled'];
if (!dbPath) { console.error('用法：POKER_DB_PATH=<库路径> node tools/prune-match-events.js [--dry-run]'); process.exit(2); }

const db = new Database(dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
const placeholders = TYPES.map(() => '?').join(',');
const before = db.prepare(`SELECT event_type, COUNT(*) c FROM match_events WHERE event_type IN (${placeholders}) GROUP BY event_type`).all(...TYPES);
const total = db.prepare('SELECT COUNT(*) c FROM match_events').get().c;
console.log(`match_events 共 ${total} 行，其中要删：`, before.map(r => `${r.event_type} ${r.c}`).join('、') || '（没有）');
if (dryRun || !before.length) { db.close(); process.exit(0); }

const del = db.prepare(`DELETE FROM match_events WHERE rowid IN (SELECT rowid FROM match_events WHERE event_type IN (${placeholders}) LIMIT 2000)`);
let removed = 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) {
    const n = del.run(...TYPES).changes;
    removed += n;
    if (n === 0) break;
    sleep(20);
}
const after = db.prepare('SELECT COUNT(*) c FROM match_events').get().c;
console.log(`已删 ${removed} 行，match_events 剩 ${after} 行`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
