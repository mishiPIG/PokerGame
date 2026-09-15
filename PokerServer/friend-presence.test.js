'use strict';

// 牌友在线状态的推送（2026-09-15）。
//
// 大厅那行「N 位牌友在线」只有在【牌友一上线/下线我就收到新列表】时才成立。
// 服务端原来只在「自己连上」和「加/删好友」时推，也就是说：
//   · 牌友早走了，我这边一直亮着
//   · 牌友刚上线，我这边看不见
// 而「谁在线」是约局的第一步 —— 它一旦不准，玩家就再也不会信它。
// **一个不可信的状态指示比没有更糟，因为它还在骗人。**
//
// 另一半同样重要：【不是牌友的人上下线不许惊动我】。
// 全服广播在几十人时看不出问题，人一多就是每秒几十条无用推送。

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerFriendEvents } = require('./src/socket/events/friend-events');

function world() {
    const sockets = new Map();                  // socketId -> socket
    const io = { sockets: { sockets } };
    const edges = new Map();                    // `${a}:${b}` -> status

    const db = {
        getUserById: id => ({ id, username: id, displayName: id, friendCode: '12345678' }),
        friends: {
            listFriends: uid => [...edges.entries()]
                .filter(([k, v]) => k.startsWith(uid + ':') && v === 'accepted')
                .map(([k]) => ({ userId: k.split(':')[1], displayName: k.split(':')[1] })),
            listIncoming: () => [], listOutgoing: () => [],
            edgeStatus: (a, b) => edges.get(`${a}:${b}`) || 'none',
            request: () => 'requested', accept: () => true, remove: () => true,
            setNote: () => true, recentTablemates: () => [],
        },
    };
    const beFriends = (a, b) => { edges.set(`${a}:${b}`, 'accepted'); edges.set(`${b}:${a}`, 'accepted'); };

    let seq = 0;
    function connect(userId) {
        const handlers = new Map();
        const s = {
            id: 's' + (++seq), user: { id: userId }, currentRoom: null,
            lists: [],                                   // 收到的 friend_list
            on: (ev, fn) => handlers.set(ev, fn),
            emit(ev, payload) { if (ev === 'friend_list') this.lists.push(payload); },
            fire(ev, p) { handlers.get(ev)?.(p); },
        };
        sockets.set(s.id, s);
        registerFriendEvents({ socket: s, user: s.user, io, db, runtime: { roomGames: {} } });
        return s;
    }
    function disconnect(s) {
        // socket.io 是先把 socket 从表里摘掉再 emit disconnect，这里照同样的顺序，
        // 而服务端代码里那个 exceptSocket 让两种时序都对。
        sockets.delete(s.id);
        s.fire('disconnect');
    }
    const seenOnline = (s, uid) => {
        const last = s.lists[s.lists.length - 1];
        return last?.friends.find(f => f.userId === uid)?.online;
    };
    return { connect, disconnect, beFriends, seenOnline };
}

test('🔴 牌友上线 → 我【不用做任何事】就收到新列表', () => {
    const w = world();
    w.beFriends('a', 'b');
    const A = w.connect('a');
    const before = A.lists.length;
    w.connect('b');
    assert.ok(A.lists.length > before, 'B 上线了，A 那边一条推送都没有');
    assert.equal(w.seenOnline(A, 'b'), true, 'B 已连上，A 却看不到他在线');
});

test('🔴 牌友下线 → 我这边必须跟着灭，不能一直亮着', () => {
    const w = world();
    w.beFriends('a', 'b');
    const A = w.connect('a');
    const B = w.connect('b');
    assert.equal(w.seenOnline(A, 'b'), true);

    const before = A.lists.length;
    w.disconnect(B);
    assert.ok(A.lists.length > before, 'B 走了，A 那边没收到推送');
    assert.equal(w.seenOnline(A, 'b'), false,
        'B 已经走了 A 那边还亮着 —— 这行字就是在骗人，比不显示更糟');
});

test('不是牌友的人上下线，不许惊动我（别把它做成全服广播）', () => {
    const w = world();
    w.beFriends('a', 'b');
    const A = w.connect('a');
    w.connect('b');
    const before = A.lists.length;

    const C = w.connect('stranger');
    w.disconnect(C);
    assert.equal(A.lists.length, before, '陌生人上下线也在给 A 推 —— 人一多就是每秒几十条无用推送');
});

test('一个牌友都没有的人，上线不触发任何推送', () => {
    const w = world();
    const A = w.connect('a');           // 无牌友
    const B = w.connect('b');
    assert.deepEqual(B.lists.length, 1, '只该有自己连上时那一份');
    assert.deepEqual(A.lists.length, 1);
});
