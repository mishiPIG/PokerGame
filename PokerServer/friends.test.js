'use strict';

// 牌友系统（2026-09-13，第 1 批：列表 + 双向确认 + 备注 + 「上次一起玩的人」）。
//
// 关系存【两行】（A→B、B→A 各一行），所以最容易出的错是【只写了一半】——
// 留下「我把你删了、你那边还挂着我」这种单边关系，而且平时完全看不出来。
// 下面每条关系变更都从【两个人各自的视角】断言一次。
//
// 另一条底线是【备注私有】：我给你记的「爱诈唬」绝不能让你看见。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDatabaseService } = require('./src/storage/database-service');

let seq = 0;
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerfriends-'));
    // ⚠️ 路径要自己留着：db 服务对象上并没有暴露 databasePath，
    //    第一版用 db.databasePath 取到 undefined，造牌谱的 INSERT 写到别处去了。
    const dbPath = path.join(dir, `t${++seq}.sqlite`);
    const db = createDatabaseService({ databasePath: dbPath, allowCreate: true });
    const mk = (name) => db.createUser(name, 'x', false, `${name}@t.local`);
    return { db, mk, dbPath };
}

test('申请 → 同意：两边的列表都要变（关系必须是对称的）', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');

    assert.equal(db.friends.request(a.id, b.id), 'requested');
    // 我这边是「已发出」，他那边是「待处理」——两个视角都要对
    assert.deepEqual(db.friends.listOutgoing(a.id).map(f => f.userId), [b.id]);
    assert.deepEqual(db.friends.listIncoming(b.id).map(f => f.userId), [a.id]);
    assert.deepEqual(db.friends.listFriends(a.id), []);
    assert.deepEqual(db.friends.listFriends(b.id), []);

    assert.equal(db.friends.accept(b.id, a.id), true);
    assert.deepEqual(db.friends.listFriends(a.id).map(f => f.userId), [b.id]);
    assert.deepEqual(db.friends.listFriends(b.id).map(f => f.userId), [a.id]);
    assert.deepEqual(db.friends.listIncoming(b.id), []);
    assert.deepEqual(db.friends.listOutgoing(a.id), []);
    db.close();
});

test('🔴 删除必须把两行一起删 —— 绝不能留下单边关系', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    db.friends.request(a.id, b.id);
    db.friends.accept(b.id, a.id);

    db.friends.remove(a.id, b.id);
    assert.deepEqual(db.friends.listFriends(a.id), []);
    assert.deepEqual(db.friends.listFriends(b.id), [], '对方那边也必须清掉，否则他列表里挂着一个已经不是好友的人');
    assert.equal(db.friends.edgeStatus(a.id, b.id), null);
    assert.equal(db.friends.edgeStatus(b.id, a.id), null);
    db.close();
});

test('拒绝申请 = 两行一起删，之后还能重新申请', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    db.friends.request(a.id, b.id);
    db.friends.remove(b.id, a.id);                       // 拒绝走的是同一条路径
    assert.equal(db.friends.edgeStatus(a.id, b.id), null);
    assert.equal(db.friends.request(a.id, b.id), 'requested', '被拒后应该还能再申请');
    db.close();
});

test('对方已经在申请我时，我再点「加」直接成为好友（不必两人各点一次）', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    db.friends.request(a.id, b.id);
    assert.equal(db.friends.request(b.id, a.id), 'accepted');
    assert.deepEqual(db.friends.listFriends(a.id).map(f => f.userId), [b.id]);
    assert.deepEqual(db.friends.listFriends(b.id).map(f => f.userId), [a.id]);
    db.close();
});

test('重复申请 / 加自己 / 凭空同意 都要被挡住', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    assert.equal(db.friends.request(a.id, a.id), 'self');
    assert.equal(db.friends.request(a.id, b.id), 'requested');
    assert.equal(db.friends.request(a.id, b.id), 'pending', '重复申请不该再写一遍');
    db.friends.accept(b.id, a.id);
    assert.equal(db.friends.request(a.id, b.id), 'already');
    // 没有待处理申请时不许凭空建立关系
    const c = mk('carol');
    assert.equal(db.friends.accept(a.id, c.id), false);
    assert.deepEqual(db.friends.listFriends(a.id).map(f => f.userId), [b.id]);
    db.close();
});

test('🔴 备注是私有的：只有写的人看得到，对方永远读不到', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    db.friends.request(a.id, b.id);
    db.friends.accept(b.id, a.id);

    assert.equal(db.friends.setNote(a.id, b.id, '爱诈唬'), true);
    assert.equal(db.friends.listFriends(a.id)[0].note, '爱诈唬');
    assert.equal(db.friends.listFriends(b.id)[0].note, '',
        '对方查自己的列表时读的是他那一行，绝不能看到我给他记了什么');
    db.close();
});

test('非好友不能写备注（备注长在好友关系上）', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    assert.equal(db.friends.setNote(a.id, b.id, '路人'), false);
    db.friends.request(a.id, b.id);
    assert.equal(db.friends.setNote(a.id, b.id, '还没同意'), false, '申请中还不算好友');
    db.close();
});

test('备注超长会被截断，不会把数据库塞爆', () => {
    const { db, mk } = freshDb();
    const a = mk('alice'), b = mk('bob');
    db.friends.request(a.id, b.id);
    db.friends.accept(b.id, a.id);
    db.friends.setNote(a.id, b.id, 'x'.repeat(500));
    const { MAX_NOTE } = require('./src/storage/friend-repository');
    assert.equal(db.friends.listFriends(a.id)[0].note.length, MAX_NOTE);
    db.close();
});

test('🔴 「一起玩过」排除掉已经有关系的人，否则会让人重复申请', () => {
    const { db, mk, dbPath } = freshDb();
    const a = mk('alice'), b = mk('bob'), c = mk('carol');
    // 造一手三人同桌的牌谱
    const now = Date.now();
    const sqlite = require('better-sqlite3')(dbPath);
    sqlite.prepare(`INSERT INTO matches(id, room_code, room_type, status, owner_user_id, name,
        config_json, invite_json, state_version, started_at_ms, created_at_ms, updated_at_ms)
        VALUES ('m1','1234','cash','finished',?, 'x','{}','{}',1,?,?,?)`).run(a.id, now, now, now);
    sqlite.prepare(`INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms,
        completed_at_ms, sb, bb, payload_json) VALUES ('h1','m1','1234',1,'cash',?,?,10,20,'{}')`).run(now, now);
    for (const u of [a, b, c]) {
        sqlite.prepare(`INSERT INTO hand_players(hand_id, user_id, username_snapshot, seat,
            start_chips, end_chips, won, hole_json) VALUES ('h1',?,?,0,100,100,0,'[]')`).run(u.id, u.username);
    }
    sqlite.close();

    let mates = db.friends.recentTablemates(a.id).map(m => m.userId).sort();
    assert.deepEqual(mates, [b.id, c.id].sort(), '同桌的另外两人都该出现，且不含我自己');

    db.friends.request(a.id, b.id);
    mates = db.friends.recentTablemates(a.id).map(m => m.userId);
    assert.deepEqual(mates, [c.id], '已经申请过的人不该再出现在「一起玩过」里');
    db.close();
});

test('🔴 迁移可重复执行，且不动存量数据', () => {
    // 生产上是对着真实库跑的，跑第二遍必须无害。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerfriends-mig-'));
    const p = path.join(dir, 'm.sqlite');
    let db = createDatabaseService({ databasePath: p, allowCreate: true });
    const a = db.createUser('alice', 'x', false, 'a@t.local');
    const b = db.createUser('bob', 'x', false, 'b@t.local');
    db.friends.request(a.id, b.id);
    db.close();

    db = createDatabaseService({ databasePath: p, allowCreate: false });   // 再打开 = 再跑一遍迁移
    assert.equal(db.integrityCheck(), 'ok');
    assert.deepEqual(db.friends.listOutgoing(a.id).map(f => f.userId), [b.id], '存量关系必须还在');
    db.close();
});
