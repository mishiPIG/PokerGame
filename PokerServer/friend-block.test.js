'use strict';

// 拉黑（2026-09-15）。003 迁移里 status 的 CHECK 本来就含 'blocked'，一直没用上。
//
// 这功能的难点全在「对方能不能看出来」：
// 一旦让他看出自己被拉黑了，要么换个号再来、要么把事情闹大，拉黑就白做了。
// 所以被拉黑的人发申请时，服务端【什么都不写】却回一个和成功一样的结果 ——
// 他看到的是「申请发出去了、对方没理」，和真被忽略没有区别。
//
// ⚠️ 但绝不能用「只写他那一行 pending」去把戏做全套：那会留下一条单边关系，
//    正是 friend-repository 开头那条铁律（成对写入）要杜绝的东西。宁可少写，不留半条。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDatabaseService } = require('./src/storage/database-service');

let seq = 0;
function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerblock-'));
    const db = createDatabaseService({ databasePath: path.join(dir, `b${++seq}.sqlite`), allowCreate: true });
    const mk = name => db.createUser(name, 'x', false, `${name}@t.local`);
    return { db, mk };
}
const idOf = (db, name) => db.getUserByUsername(name).id;

test('拉黑 = 关系两边都断，只留我这一行 blocked', () => {
    const { db, mk } = freshDb();
    mk('a'); mk('b');
    const A = idOf(db, 'a'), B = idOf(db, 'b');
    db.friends.request(A, B);
    db.friends.accept(B, A);
    assert.equal(db.friends.listFriends(A).length, 1);
    assert.equal(db.friends.listFriends(B).length, 1);

    db.friends.block(A, B);
    assert.equal(db.friends.listFriends(A).length, 0, 'A 这边该断了');
    assert.equal(db.friends.listFriends(B).length, 0, 'B 那边也得断——不能留单边关系');
    assert.equal(db.friends.edgeStatus(A, B), 'blocked');
    assert.equal(db.friends.edgeStatus(B, A), null, 'B 那一行必须是【干净的没有】');
    assert.deepEqual(db.friends.listBlocked(A).map(f => f.userId), [B]);
    assert.deepEqual(db.friends.listBlocked(B), [], 'B 不该知道自己上了谁的名单');
});

test('🔴 被拉黑的人再发申请：什么都没写进去，而他【看不出来】', () => {
    const { db, mk } = freshDb();
    mk('a'); mk('b');
    const A = idOf(db, 'a'), B = idOf(db, 'b');
    db.friends.block(A, B);

    const result = db.friends.request(B, A);
    assert.equal(result, 'requested', '回一个和成功一样的结果 —— 让他以为是被忽略了');
    assert.equal(db.friends.listIncoming(A).length, 0, '🔴 申请居然进了 A 的待处理列表');
    assert.equal(db.friends.listOutgoing(B).length, 0, '不许留半条关系（成对写入那条铁律）');
    assert.equal(db.friends.edgeStatus(B, A), null);
});

test('我拉黑的人，我自己想加回来得先解除（这一侧没必要瞒自己）', () => {
    const { db, mk } = freshDb();
    mk('a'); mk('b');
    const A = idOf(db, 'a'), B = idOf(db, 'b');
    db.friends.block(A, B);
    assert.equal(db.friends.request(A, B), 'youBlocked');
    assert.equal(db.friends.listOutgoing(A).length, 0);

    assert.equal(db.friends.unblock(A, B), true);
    assert.equal(db.friends.edgeStatus(A, B), null);
    assert.equal(db.friends.request(A, B), 'requested', '解除之后一切照常');
    assert.equal(db.friends.listIncoming(B).length, 1);
});

test('解除一个没拉黑的人 = 什么都不做（别误删好友关系）', () => {
    const { db, mk } = freshDb();
    mk('a'); mk('b');
    const A = idOf(db, 'a'), B = idOf(db, 'b');
    db.friends.request(A, B);
    db.friends.accept(B, A);
    assert.equal(db.friends.unblock(A, B), false);
    assert.equal(db.friends.listFriends(A).length, 1, '🔴 unblock 把好友关系删掉了');
});

test('拉黑的人不会再出现在「一起玩过」里', () => {
    // recentTablemates 排除的是「friendships 里已有任何关系的人」，blocked 也是一种关系。
    const { db, mk } = freshDb();
    mk('a'); mk('b');
    const A = idOf(db, 'a'), B = idOf(db, 'b');
    db.friends.block(A, B);
    assert.equal(db.friends.recentTablemates(A).some(f => f.userId === B), false);
});

test('不能拉黑自己', () => {
    const { db, mk } = freshDb();
    mk('a');
    const A = idOf(db, 'a');
    assert.equal(db.friends.block(A, A), false);
    assert.equal(db.friends.listBlocked(A).length, 0);
});
