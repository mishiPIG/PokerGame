'use strict';

// 账号删除 + 牌谱匿名化（2026-09-16）。
//
// 这是全项目**唯一不可撤销**的操作，而且要过应用商店审核，所以下面每一条
// 都是「错了就再也补不回来」的那种，而且两个方向都得守：
//   · 删得不够 → 个人数据还留在库里（而且是删过之后才发现）
//   · 删过头   → 把【同桌其他人】的牌谱也毁了（本项目最宝贵的数据资产）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatabaseService } = require('./src/storage/database-service');

let seq = 0;
function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerdel-'));
    const dbPath = path.join(dir, 'd' + (++seq) + '.sqlite');
    const svc = createDatabaseService({ databasePath: dbPath, allowCreate: true });
    const raw = new Database(dbPath);
    const mk = (name) => svc.createUser(name, 'hash-' + name, false, name + '@t.local');

    let handNo = 0;
    const mkHand = (matchId, seats) => {
        const id = 'h' + (++handNo);
        const payload = {
            ts: Date.now(), matchId, handSeq: handNo,
            seats: seats.map((s, i) => ({
                userId: s.id, username: s.username, seat: i, avatar: 'b1.svg',
                startChips: 1000, hole: ['As', 'Kd'],
            })),
            actions: seats.map(s => ({ userId: s.id, street: 'preflop', action: 'call', amount: 20 })),
            results: seats.map(s => ({ userId: s.id, won: 0, endChips: 1000 })),
        };
        raw.prepare('INSERT INTO hands(id, match_id, room_code, hand_seq, mode, started_at_ms,'
            + ' completed_at_ms, sb, bb, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(id, matchId, '1234', handNo, 'cash', Date.now(), Date.now(), 10, 20,
                JSON.stringify(payload));
        seats.forEach((s, i) => raw.prepare('INSERT INTO hand_players(hand_id, user_id,'
            + ' username_snapshot, seat, start_chips, end_chips, won, hole_json)'
            + ' VALUES (?,?,?,?,?,?,?,?)').run(id, s.id, s.username, i, 1000, 1000, 0, '[]'));
        return id;
    };
    const mkMatch = (id, owner) => raw.prepare('INSERT INTO matches(id, room_code, room_type,'
        + ' status, owner_user_id, name, config_json, created_at_ms, updated_at_ms)'
        + ' VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, '1234', 'cash', 'ended', owner.id, '房间', '{}', Date.now(), Date.now());

    return { svc, raw, mk, mkHand, mkMatch, del: svc.accountDeletion };
}

// 一步删完：身份 + 牌谱（测试里手数少，直接擦干净）
function deleteFully(f, userId) {
    const r = f.del.anonymizeIdentity(userId);
    assert.equal(r.ok, true, '身份销毁应当成功');
    let guard = 0;
    while (f.del.pendingHandCount(userId, r.handle) > 0 && guard++ < 50) {
        f.del.scrubHandBatch(userId, r.handle, 100);
    }
    return r.handle;
}

test('🔴 删号之后：邮箱 / 用户名 / id / 搜索 都再也找不到这个人', () => {
    const f = fixture();
    const alice = f.mk('alice');
    assert.ok(f.svc.getUserByEmail('alice@t.local'), '删之前当然查得到');

    deleteFully(f, alice.id);

    assert.ok(!f.svc.getUserByEmail('alice@t.local'), '邮箱还能查到人');
    assert.ok(!f.svc.getUserByUsername('alice'), '用户名还能查到人');
    assert.ok(!f.svc.getUserById(alice.id), '按 id 还能查到人');
    assert.ok(!f.svc.findByCodeOrName('alice'), '搜索还搜得到');
});

test('🔴 个人数据要真的从库里消失，不能只是「查不到」', () => {
    const f = fixture();
    const alice = f.mk('alice');
    const row = () => f.raw.prepare('SELECT * FROM users WHERE id = ?').get(alice.id);
    const before = row();
    assert.ok(before.email && before.password_hash && before.friend_code);

    deleteFully(f, alice.id);

    const after = row();
    assert.equal(after.email, null, '邮箱还在');
    assert.equal(after.display_name, null);
    assert.equal(after.avatar, null);
    assert.equal(after.friend_code, null, '牌友号还在 —— 别人还能靠它找到这个号');
    assert.equal(after.gold, 0, '余额没作废');
    assert.equal(after.is_admin, 0);
    assert.notEqual(after.password_hash, before.password_hash, '密码哈希原样留着');
    assert.ok(after.deleted_at_ms > 0);
    assert.match(after.username, /^已注销#/);
});

test('🔴 匿名代号必须随机 —— 从原用户名哈希出来的能被暴力反查，那不叫匿名', () => {
    const f = fixture();
    const handles = new Set();
    for (let i = 0; i < 20; i++) handles.add(deleteFully(f, f.mk('same' + i).id));
    assert.equal(handles.size, 20, '代号撞车了（唯一索引会炸，而且能看出谁是谁）');

    // 同一个用户名注销两次必须拿到不同代号 —— 否则「同名→同代号」本身
    // 就是一条能把匿名记录连回真人的线索。
    const h1 = deleteFully(f, f.mk('bob').id);
    const h2 = deleteFully(f, f.mk('bob').id);   // 用户名和邮箱都已释放，能重新注册
    assert.notEqual(h1, h2, '同名注销两次拿到同一个代号 = 可反查');
});

test('🔴 牌谱里【同桌其他人】的名字一个字都不能动', () => {
    const f = fixture();
    const alice = f.mk('alice');
    const bob = f.mk('bob');
    f.mkMatch('m1', alice);
    const hid = f.mkHand('m1', [
        { id: alice.id, username: 'alice' },
        { id: bob.id, username: 'bob' },
    ]);

    const handle = deleteFully(f, alice.id);

    const p = JSON.parse(f.raw.prepare('SELECT payload_json p FROM hands WHERE id = ?').get(hid).p);
    const aSeat = p.seats.find(s => s.userId === alice.id);
    const bSeat = p.seats.find(s => s.userId === bob.id);
    assert.equal(aSeat.username, handle, 'alice 的名字没被换掉');
    assert.equal(aSeat.avatar, null, '头像也是个人数据');
    assert.equal(bSeat.username, 'bob', '🔴 把 bob 的名字也改了 —— 毁了别人的牌谱');
    assert.equal(bSeat.avatar, 'b1.svg', 'bob 的头像也被动了');
});

test('🔴 牌局本身必须留下 —— 一手牌是好几个人共同的记录', () => {
    const f = fixture();
    const alice = f.mk('alice');
    const bob = f.mk('bob');
    f.mkMatch('m1', alice);
    f.mkHand('m1', [{ id: alice.id, username: 'alice' }, { id: bob.id, username: 'bob' }]);
    f.mkHand('m1', [{ id: alice.id, username: 'alice' }, { id: bob.id, username: 'bob' }]);

    deleteFully(f, alice.id);

    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM hands').get().n, 2, '牌局被删了');
    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM hand_players WHERE user_id = ?')
        .get(bob.id).n, 2, 'bob 的参与记录被连累删掉了');
    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM hand_players WHERE user_id = ?')
        .get(alice.id).n, 2,
    '注销者的行也要留着 —— 删了那手牌人数就对不上，筹码守恒审计会开始误报');
});

test('名字快照两张表都要换（hand_players / match_players）', () => {
    const f = fixture();
    const alice = f.mk('alice');
    f.mkMatch('m1', alice);
    f.mkHand('m1', [{ id: alice.id, username: 'alice' }]);
    f.raw.prepare('INSERT INTO match_players(match_id, user_id, username_snapshot, seat,'
        + ' player_status, joined_at_ms) VALUES (?,?,?,?,?,?)')
        .run('m1', alice.id, 'alice', 0, 'left', Date.now());

    const handle = deleteFully(f, alice.id);

    assert.equal(f.raw.prepare('SELECT username_snapshot s FROM hand_players WHERE user_id = ?')
        .get(alice.id).s, handle);
    assert.equal(f.raw.prepare('SELECT username_snapshot s FROM match_players WHERE user_id = ?')
        .get(alice.id).s, handle);
});

test('🔴 好友关系两个方向都删，连对方写的备注一起 —— 那也是关于他的个人数据', () => {
    const f = fixture();
    const alice = f.mk('alice');
    const bob = f.mk('bob');
    f.svc.friends.request(alice.id, bob.id);
    f.svc.friends.accept(bob.id, alice.id);
    f.svc.friends.setNote(bob.id, alice.id, '爱诈唬');
    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM friendships').get().n, 2);

    deleteFully(f, alice.id);

    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM friendships').get().n, 0,
        '单边关系残留 —— bob 那边还挂着一个已注销的人和一条关于他的备注');
});

test('站内信删掉；反馈留正文，但联系方式和 UA 必须清掉', () => {
    const f = fixture();
    const alice = f.mk('alice');
    f.raw.prepare('INSERT INTO user_messages(id, user_id, message_type, text, is_read,'
        + ' created_at_ms) VALUES (?,?,?,?,?,?)')
        .run('msg1', alice.id, 'admin', '第 3 名 +200', 0, Date.now());
    f.raw.prepare('INSERT INTO feedback(id, user_id, username, text, contact, user_agent,'
        + ' status, created_at_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run('fb1', alice.id, 'alice', '加注条在手机上很卡', 'alice@真实邮箱.com',
            'Mozilla/5.0 iPhone', 'open', Date.now());

    const handle = deleteFully(f, alice.id);

    assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM user_messages WHERE user_id = ?')
        .get(alice.id).n, 0, '站内信是发给他个人的，该跟着走');
    const fb = f.raw.prepare('SELECT * FROM feedback WHERE id = ?').get('fb1');
    assert.equal(fb.contact, null, '🔴 联系方式是实打实的个人数据（玩家会填邮箱/微信/手机）');
    assert.equal(fb.user_agent, null, 'UA 是设备指纹');
    assert.equal(fb.username, handle);
    assert.equal(fb.text, '加注条在手机上很卡', 'bug 报告正文该留着 —— 问题还没修呢');
});

test('🔴 重复删同一个号：第二次必须拒绝，绝不能把代号再换一遍', () => {
    const f = fixture();
    const alice = f.mk('alice');
    const handle = deleteFully(f, alice.id);

    const again = f.del.anonymizeIdentity(alice.id);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'ALREADY_DELETED');
    assert.equal(f.raw.prepare('SELECT username u FROM users WHERE id = ?').get(alice.id).u, handle,
        '代号被改了 —— 牌谱里已经写成旧代号，一改就对不上了');
    assert.equal(f.del.anonymizeIdentity('no-such-user').reason, 'NOT_FOUND');
});

test('🔴 擦牌谱分批、可重放、断了能接着擦（否则重启会留下永远擦不完的半成品）', () => {
    const f = fixture();
    const alice = f.mk('alice');
    f.mkMatch('m1', alice);
    for (let i = 0; i < 7; i++) f.mkHand('m1', [{ id: alice.id, username: 'alice' }]);

    const r = f.del.anonymizeIdentity(alice.id);
    assert.equal(f.del.pendingHandCount(alice.id, r.handle), 7);

    assert.equal(f.del.scrubHandBatch(alice.id, r.handle, 3), 3);   // 擦 3 手就「断电」
    assert.equal(f.del.pendingHandCount(alice.id, r.handle), 4, '剩下的要能被认出来');

    const pend = f.del.pendingScrubUsers();                          // 重启后的清扫
    assert.equal(pend.length, 1);
    assert.equal(pend[0].userId, alice.id);
    assert.equal(pend[0].pending, 4);

    while (f.del.pendingHandCount(alice.id, r.handle) > 0) f.del.scrubHandBatch(alice.id, r.handle, 3);
    assert.equal(f.del.pendingScrubUsers().length, 0, '擦完了就不该再被清扫认领');
    assert.equal(f.del.scrubHandBatch(alice.id, r.handle, 10), 0, '再擦一次不该出事（幂等）');

    const all = f.raw.prepare('SELECT payload_json p FROM hands').all();
    assert.ok(all.every(h => !h.p.includes('"alice"')), '还有牌谱里留着真名');
});

test('钱包流水留下 —— 那是经济审计的证据链，而且只有 user_id、不含身份信息', () => {
    const f = fixture();
    const alice = f.mk('alice');
    f.svc.wallet.adjust({ userId: alice.id, delta: -110, type: 'cash_buyin', operationKey: 'k1' });

    deleteFully(f, alice.id);

    // 注册本身就会记一笔赠币流水，加上这次买入一共两笔 —— 两笔都必须留下。
    const types = f.raw.prepare(
        'SELECT transaction_type t FROM wallet_transactions WHERE user_id = ? ORDER BY created_at_ms')
        .all(alice.id).map(r => r.t);
    assert.deepEqual(types, ['initial_balance', 'cash_buyin'],
        '流水被删了 —— 筹码守恒审计会从此对不上账');
});
