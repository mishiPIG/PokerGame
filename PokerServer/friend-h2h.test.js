'use strict';

// 牌友之间的对战战绩（2026-09-15，全时段 · 只算现金桌）。
//
// 口径上有两处是【想清楚才这么定的】，别在维护时顺手改掉：
//   ① 给的是「同桌那些手里，双方各自净多少」，不是「我从他身上赢了多少」。
//      后者在多人桌上这张表根本算不出来（要按池子逐笔归属）。
//   ② 净额公式和 stats.js 的生涯战绩【完全一致】（endChips - startChips）。
//      同一个 App 里两个「净盈亏」对不上，比不精确更糟。
//
// 只算现金桌是用户定的：SNG 是锦标赛记分牌，和现金筹码不是一个东西，
// 混在一起这个数就没意义了。生产里真有纯 SNG 玩家（zsh，12,428 手全是 SNG）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabaseService } = require('./src/storage/database-service');

let seq = 0;
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerh2h-'));
    const dbPath = path.join(dir, `h${++seq}.sqlite`);
    const db = createDatabaseService({ databasePath: dbPath, allowCreate: true });
    for (const n of ['me', 'rival', 'third']) db.createUser(n, 'x', false, `${n}@t.local`);
    const id = n => db.getUserByUsername(n).id;

    // 直接往牌谱表里写：这里要测的是聚合口径，不是发牌流程
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO matches(id, room_code, room_type, status, owner_user_id, name,
        config_json, invite_json, state_version, created_at_ms, updated_at_ms)
        VALUES ('m1','1111','cash','finished',?, 'T','{}','{}',1,1,1)`).run(id('me'));
    let hseq = 0;
    function hand(mode, seats) {          // seats: [[username, net], ...]
        const hid = 'h' + (++hseq);
        raw.prepare(`INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms,
            completed_at_ms, sb, bb, ante, payload_json)
            VALUES (?, 'm1','1111', ?, ?, ?, ?, 10, 20, 0, '{}')`).run(hid, hseq, mode, hseq * 1000, hseq * 1000);
        seats.forEach(([name, net], i) => {
            raw.prepare(`INSERT INTO hand_players(hand_id, user_id, username_snapshot, seat,
                start_chips, end_chips, won, hole_json) VALUES (?,?,?,?,?,?,?,'[]')`)
                .run(hid, id(name), name, i, 1000, 1000 + net, net > 0 ? 1 : 0);
        });
    }
    return { db, id, hand, close: () => raw.close() };
}

test('同桌那些手里，双方各自的净都要算出来', () => {
    const f = fixture();
    f.hand('cash', [['me', +300], ['rival', -300]]);
    f.hand('cash', [['me', -100], ['rival', +100]]);
    f.hand('cash', [['me', +50], ['rival', -50]]);
    const rows = f.db.friends.headToHead(f.id('me'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, f.id('rival'));
    assert.equal(rows[0].handsTogether, 3);
    assert.equal(rows[0].myNet, 250);
    assert.equal(rows[0].theirNet, -250);
    assert.equal(rows[0].myWins, 2, '赢下的手数按 won 标记算');
    f.close();
});

test('🔴 SNG 的手一律不算（记分牌和现金筹码不是一个东西）', () => {
    const f = fixture();
    f.hand('cash', [['me', +100], ['rival', -100]]);
    f.hand('sng',  [['me', +99999], ['rival', -99999]]);   // 锦标赛记分牌，不该混进来
    const rows = f.db.friends.headToHead(f.id('me'));
    assert.equal(rows[0].handsTogether, 1, 'SNG 的手被算进去了');
    assert.equal(rows[0].myNet, 100, 'SNG 的记分牌污染了现金净额');
    f.close();
});

test('纯 SNG 玩家的对战榜是空的（生产里真有这种人）', () => {
    const f = fixture();
    f.hand('sng', [['me', +500], ['rival', -500]]);
    assert.deepEqual(f.db.friends.headToHead(f.id('me')), []);
    f.close();
});

test('多人桌：每个同桌的人各算一行，而我的净在每一行里都是【那些手的】全额', () => {
    const f = fixture();
    // 三人桌一手：我 +200（这 200 里有多少来自谁，这张表算不出来）
    f.hand('cash', [['me', +200], ['rival', -150], ['third', -50]]);
    // 再和 rival 单独打一手
    f.hand('cash', [['me', -30], ['rival', +30]]);
    const rows = f.db.friends.headToHead(f.id('me'));
    const by = Object.fromEntries(rows.map(r => [r.userId, r]));
    assert.equal(by[f.id('rival')].handsTogether, 2);
    assert.equal(by[f.id('rival')].myNet, 170);
    assert.equal(by[f.id('third')].handsTogether, 1);
    assert.equal(by[f.id('third')].myNet, 200,
        '和 third 同桌只有那一手，我在那手里净 +200 —— 这正是「同桌那些手」的定义');
    f.close();
});

test('和我没同桌过的人不出现', () => {
    const f = fixture();
    f.hand('cash', [['rival', +10], ['third', -10]]);      // 我没参与
    assert.deepEqual(f.db.friends.headToHead(f.id('me')), []);
    f.close();
});

test('按同桌手数从多到少排', () => {
    const f = fixture();
    f.hand('cash', [['me', 0], ['third', 0]]);
    f.hand('cash', [['me', 0], ['rival', 0]]);
    f.hand('cash', [['me', 0], ['rival', 0]]);
    const rows = f.db.friends.headToHead(f.id('me'));
    assert.deepEqual(rows.map(r => r.handsTogether), [2, 1]);
    f.close();
});
