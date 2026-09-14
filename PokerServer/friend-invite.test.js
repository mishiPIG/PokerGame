'use strict';

// 牌友系统第 2 批：一键邀请（2026-09-14）。
//
// 用户定的规矩，这份文件的存在就是为了把它锁死：
//   「房主建房，可以复制粘贴邀请码，也可以直接在游戏内部邀请在线好友，被邀请的人
//     同意了之后就可以加入；**加入后的玩家不可以分享房间码和邀请自己的在线好友**。」
//
// 🔴 为什么必须有服务端的待办记录：客户端那个 `.owner-only` 只是「别让人看见按钮」，
//    任何人都能自己 emit 一个 invite_respond。真正的闸有两道：
//      ① invite_friend 校验 ownerUserId
//      ② invite_respond 必须在服务端的 FRIEND_INVITES 里找得到那条记录
//    下面每一条都从【攻击者视角】写：不是「功能能用吗」，是「绕得过去吗」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerInviteEvents } = require('./src/socket/events/invite-events');

// ---------- 最小桩 ----------
function makeSocket(user) {
    const handlers = new Map();
    return {
        user, currentRoom: null, playRoom: null,
        handshake: { headers: {}, address: '127.0.0.1' },
        on: (ev, fn) => handlers.set(ev, fn),
        emit(ev, payload) { this.sent.push([ev, payload]); },
        sent: [],
        fire(ev, payload) {
            const fn = handlers.get(ev);
            assert.ok(fn, `没有注册 ${ev} 处理器`);
            fn(payload);
        },
        got(ev) { return this.sent.filter(([e]) => e === ev).map(([, p]) => p); },
        msgKeys() { return this.got('server_msg').map(m => (m && m.k) || m); },
    };
}

function world() {
    const sockets = new Map();
    const io = { sockets: { sockets }, in: () => ({ emit() {} }) };
    const roomGames = {};
    const joined = [];                       // handleJoinRoom 被调到几次、进了哪间

    const friendship = new Map();            // `${a}:${b}` -> status
    const db = {
        friends: { edgeStatus: (a, b) => friendship.get(`${a}:${b}`) || 'none' },
        getUserById: (id) => ({ id, username: id, displayName: id }),
    };
    const beFriends = (a, b) => { friendship.set(`${a}:${b}`, 'accepted'); friendship.set(`${b}:${a}`, 'accepted'); };

    const tableService = {
        // 与真实语义一致的最小版本：记住谁有下场资格
        authorize: (roomId, userId) => {
            const g = roomGames[roomId];
            if (!g) return;
            (g.authorized || (g.authorized = new Set())).add(userId);
        },
        canAuthorizeNewUser: (game, userId) =>
            !!game && game.status !== 'finished'
            && (game.authorized?.has(userId) || !game.invite?.entryLocked),
        emitRoomInviteInfo() {}, createRoomInvite: () => ({}),
        findRoomByJoinCode: () => null, findRoomByInviteToken: () => null,
        codeAttemptLimited: () => false, recordCodeFailure() {}, clearUserCodeFailures() {},
        persistence: { commit() {} },
    };

    function connect(userId) {
        const s = makeSocket({ id: userId, username: userId, displayName: userId });
        sockets.set(userId, s);
        registerInviteEvents(
            { socket: s, user: s.user, io, db, config: { PHASES: {} }, runtime: { roomGames, lobbySockets: new Set() }, tableService },
            (roomId) => { joined.push([s.user.id, roomId]); s.currentRoom = roomId; }
        );
        return s;
    }

    function makeRoom(roomId, ownerId, extra = {}) {
        roomGames[roomId] = {
            roomType: 'cash', status: 'waiting', ownerUserId: ownerId,
            config: { name: '测试房', sb: 25, bb: 50 },
            invite: { joinCode: '4321', token: 'tok-' + roomId, entryLocked: false, version: 1 },
            players: [], authorized: new Set([ownerId]), ...extra,
        };
        return roomGames[roomId];
    }
    return { connect, makeRoom, beFriends, roomGames, joined };
}

let seq = 0;
const roomId = () => 'r' + (++seq);

// ═══════════ 正常路径先立住，否则下面的「拒绝」可能只是功能根本没通 ═══════════
test('房主邀请 → 牌友同意 → 拿到下场资格并进房', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    const game = w.makeRoom(R, 'host');
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'pal' });
    const inv = pal.got('friend_invite')[0];
    assert.ok(inv, '被邀请的人应该收到 friend_invite');
    assert.equal(inv.roomId, R);
    assert.equal(inv.fromName, 'host');

    pal.fire('invite_respond', { roomId: R, accept: true });
    assert.ok(game.authorized.has('pal'), '同意后必须拿到下场资格');
    assert.equal(pal.playRoom, R, 'playRoom 没设 = 他坐不下去');
    assert.deepEqual(w.joined, [['pal', R]]);
    assert.ok(host.msgKeys().includes('invite.accepted'), '房主该被告知对方同意了');
});

test('拒绝：房主收到通知，且对方【没有】拿到下场资格', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    const game = w.makeRoom(R, 'host');
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'pal' });
    pal.fire('invite_respond', { roomId: R, accept: false });
    assert.ok(!game.authorized.has('pal'));
    assert.equal(pal.playRoom, null);
    assert.deepEqual(w.joined, []);
    assert.ok(host.msgKeys().includes('invite.declined'));
});

// ═══════════ 下面全是「绕得过去吗」 ═══════════
test('🔴 非房主不能邀请人——被邀请进来的玩家也不行', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal'), outsider = w.connect('outsider');
    w.beFriends('host', 'pal');
    w.beFriends('pal', 'outsider');          // pal 和 outsider 是牌友，但 pal 不是房主
    const game = w.makeRoom(R, 'host');
    host.currentRoom = R;

    // pal 被正常邀请进来
    host.fire('invite_friend', { userId: 'pal' });
    pal.fire('invite_respond', { roomId: R, accept: true });
    assert.ok(game.authorized.has('pal'));

    // 🔴 pal 现在在房里、而且和 outsider 是牌友 —— 但他不能再往里拉人
    pal.fire('invite_friend', { userId: 'outsider' });
    assert.deepEqual(outsider.got('friend_invite'), [], '非房主竟然把邀请发出去了');
    assert.ok(pal.msgKeys().includes('invite.onlyOwner'));
    assert.ok(!game.authorized.has('outsider'));
});

test('🔴 没被邀请的人自己 emit invite_respond 进不来（伪造同意）', () => {
    const w = world(), R = roomId();
    w.connect('host');
    const attacker = w.connect('attacker');
    const game = w.makeRoom(R, 'host');

    // 他知道房间号（大厅列表里看得到），于是直接伪造一条「我同意」
    attacker.fire('invite_respond', { roomId: R, accept: true });
    assert.ok(!game.authorized.has('attacker'), '没有待办邀请也放行了 = 闸形同虚设');
    assert.equal(attacker.playRoom, null);
    assert.deepEqual(w.joined, []);
    assert.ok(attacker.msgKeys().includes('invite.expired'));
});

test('🔴 一条邀请只能用一次，不能重放', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    const game = w.makeRoom(R, 'host');
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'pal' });
    pal.fire('invite_respond', { roomId: R, accept: false });   // 先拒绝，邀请作废
    game.authorized.delete('pal');
    pal.sent.length = 0;
    pal.fire('invite_respond', { roomId: R, accept: true });    // 再拿同一条「同意」
    assert.ok(!game.authorized.has('pal'), '同一条邀请被消费了两次');
    assert.ok(pal.msgKeys().includes('invite.expired'));
});

test('🔴 邀请事件里绝不能带房间码', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    w.makeRoom(R, 'host');
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'pal' });
    const inv = pal.got('friend_invite')[0];
    // 被邀请者转手就能把码发给别人 → 房主控制入场那条就没了
    const blob = JSON.stringify(inv);
    assert.ok(!('joinCode' in inv), 'friend_invite 带了 joinCode');
    assert.ok(!blob.includes('4321'), '房间码泄漏进了邀请事件：' + blob);
    assert.ok(!blob.includes('tok-'), '邀请 token 泄漏进了邀请事件：' + blob);

    // 进来之后也拿不到：get_room_invite 只回给房主
    pal.fire('invite_respond', { roomId: R, accept: true });
    pal.sent.length = 0;
    pal.fire('get_room_invite');
    assert.deepEqual(pal.got('room_invite_info'), [], '非房主拿到了房间码');
});

test('只能邀请【已经是牌友】的人，不然这就是个骚扰任意用户的接口', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), stranger = w.connect('stranger');
    w.makeRoom(R, 'host');
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'stranger' });
    assert.deepEqual(stranger.got('friend_invite'), []);
    assert.ok(host.msgKeys().includes('invite.notFriend'));
});

test('不邀请正在别的牌桌的人（不该把人从一手牌里拽走）', () => {
    const w = world(), R = roomId(), OTHER = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    w.makeRoom(R, 'host');
    w.makeRoom(OTHER, 'pal');
    host.currentRoom = R;
    pal.currentRoom = OTHER;

    host.fire('invite_friend', { userId: 'pal' });
    assert.deepEqual(pal.got('friend_invite'), []);
    assert.ok(host.msgKeys().includes('invite.busy'));
});

test('房主自己锁了入场就不绕过——把话说清楚，别替他做主', () => {
    const w = world(), R = roomId();
    const host = w.connect('host'), pal = w.connect('pal');
    w.beFriends('host', 'pal');
    const game = w.makeRoom(R, 'host');
    game.invite.entryLocked = true;
    host.currentRoom = R;

    host.fire('invite_friend', { userId: 'pal' });
    assert.deepEqual(pal.got('friend_invite'), []);
    assert.ok(host.msgKeys().includes('invite.locked'));
});
