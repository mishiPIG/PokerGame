'use strict';

// 公开桌 / 私密桌 + 房主踢人（2026-09-15）。
//
// 背景：2026-07-18 那批「防陌生人捣乱」把【所有】房间都做成了事实上的私密桌——
// 大厅列表点进去只能观战，下场必须输房主私发的四位码。判断是对的，但它和后来做的
// 「发现」页撞了：那一页列着一堆谁也进不去的房间，**比空着更糟，空着只是冷清，
// 看得见摸不着是明确的挫败**。
//
// 所以这批的做法是：私密桌的行为【一行都不改】，只给公开桌【新开一条】授权路径。
// 这份文件守的就是那条分界线——**一个 bug 让陌生人坐进朋友局，比冷启动严重得多**。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLobbyService } = require('./src/rooms/lobby-service');
const { createMembershipService } = require('./src/rooms/membership-service');

const PHASES = { WAITING: 'waiting', SHOWDOWN: 'showdown', PREFLOP: 'preflop' };

function world() {
    const roomGames = {};
    const runtime = { roomGames, lobbySockets: new Set() };
    const io = {
        sockets: { sockets: new Map() },
        in: () => ({ emit() {} }),
    };
    const lobby = createLobbyService({ io, runtime, config: { PHASES } });

    const calls = [];
    const tableService = {
        ...lobby,
        broadcastState() {}, emitStraddleOffer() {}, broadcastRoomList() {},
        liveCount: () => 0, scheduleNextHand() {}, startActionTimer() {},
        joinAsSpectator: (roomId, s) => { calls.push(['spectate', s.user.id, roomId]); s.currentRoom = roomId; },
        seatPlayer: () => true,
    };
    const membership = createMembershipService({ io, runtime, tableService, config: { PHASES } });

    function room(id, extra = {}) {
        const { visibility, ...rest } = extra;
        roomGames[id] = {
            roomType: 'cash', status: 'waiting', phase: PHASES.WAITING,
            ownerUserId: 'host', players: [], vacatedPlayers: [],
            authorized: new Set(['host']), kicked: new Set(),
            invite: { joinCode: '4321', entryLocked: false },
            // visibility 故意可以【完全不存在】——生产里现有的房间就都没有这个字段
            config: visibility === undefined
                ? { maxPlayers: 6 }
                : { maxPlayers: 6, visibility },
            ...rest,
        };
        return roomGames[id];
    }
    function guest(id) {
        return {
            id: 's_' + id, user: { id }, currentRoom: null, playRoom: null,
            join() {}, leave() {}, emit() {},
        };
    }
    const enter = (s, roomId) => membership.joinRoom(s, s.user, roomId);
    return { room, guest, enter, lobby, roomGames };
}

// ═══════ 私密桌：一行都不许松 ═══════
test('🔴 私密桌：从列表点进来【只能观战】，拿不到下场资格', () => {
    const w = world();
    w.room('r1', { visibility: 'private' });
    const g = w.guest('stranger');
    w.enter(g, 'r1');
    assert.equal(g.playRoom, null, '私密桌居然给了下场资格——陌生人能直接坐进朋友局');
    assert.equal(g.currentRoom, 'r1', '观战本身还是要进得去的');
});

test('🔴 老房间没有 visibility 字段 → 必须按私密处理', () => {
    // 生产上现有的房间都是这样。默认值判错的后果是【存量房间全变公开】。
    const w = world();
    w.room('r2');                       // config 里根本没有 visibility
    const g = w.guest('stranger');
    w.enter(g, 'r2');
    assert.equal(g.playRoom, null, '缺字段被当成了公开——存量房间会全部敞开');
});

test('🔴 客户端说什么都不算：判据只看房间自己的 visibility', () => {
    const w = world();
    w.room('r3', { visibility: 'private' });
    const g = w.guest('stranger');
    // 旧版页面会发 byCode:true；join_room 连这个参数都故意不接
    g.playRoom = 'r3';                  // 攻击者直接把本地状态设好
    w.enter(g, 'r3');
    assert.equal(g.playRoom, null, '进私密桌时必须把冒充的下场资格清掉');
});

// ═══════ 公开桌：该放的要放，该拦的还得拦 ═══════
test('公开桌：从列表点进来就能坐下', () => {
    const w = world();
    const game = w.room('r4', { visibility: 'public' });
    const g = w.guest('stranger');
    w.enter(g, 'r4');
    assert.equal(g.playRoom, 'r4');
    assert.ok(game.authorized.has('stranger'));
});

test('公开桌锁了入场 → 还是进不去（房主的刹车优先）', () => {
    const w = world();
    const game = w.room('r5', { visibility: 'public' });
    game.invite.entryLocked = true;
    const g = w.guest('stranger');
    w.enter(g, 'r5');
    assert.equal(g.playRoom, null);
});

test('公开的 SNG 已开赛 → 进不去', () => {
    const w = world();
    w.room('r6', { visibility: 'public', roomType: 'sng', status: 'running' });
    const g = w.guest('stranger');
    w.enter(g, 'r6');
    assert.equal(g.playRoom, null);
});

// ═══════ 踢人名单：所有路径都要认 ═══════
test('🔴 被请出去的人，【任何】路径都不许再放进来', () => {
    const w = world();
    const game = w.room('r7', { visibility: 'public' });
    game.authorized.add('troll');       // 他之前进来过
    game.kicked.add('troll');

    // ① 授权判定本身
    assert.equal(w.lobby.canAuthorizeNewUser(game, 'troll'), false,
        'kicked 的判断必须排在 authorized 之前——他进来过，所以 authorized 里有他');
    // ② 公开桌直接点进来
    const g = w.guest('troll');
    w.enter(g, 'r7');
    assert.equal(g.playRoom, null, '被踢的人从公开桌又进来了');
    // 连门都不该进得来：只拦「坐不下」的话，他还能回来观战 + 在聊天里接着刷
    assert.equal(g.currentRoom, null, '被踢的人还能走回来观战 —— 那就不叫「请出房间」');
    // ③ 四位码 / 邀请链接 / 牌友邀请 —— 它们全都过 canAuthorizeNewUser，上面①已覆盖
    assert.equal(w.lobby.canAuthorizeNewUser(game, 'other'), true, '别把没被踢的人一起挡了');
});

test('房间摘要要下发 visibility，缺字段的按私密报', () => {
    const w = world();
    w.room('r8', { visibility: 'public' });
    w.room('r9');
    assert.equal(w.lobby.roomSummary('r8', 'x').visibility, 'public');
    assert.equal(w.lobby.roomSummary('r9', 'x').visibility, 'private');
});
