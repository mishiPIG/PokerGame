'use strict';
const { bind } = require('./room-context');
const { nameOf } = require('../../account/display-name');

// ===== 一键邀请牌友（2026-09-14，第 2 批）=====
// 产品约束（用户定的，别改）：
//   · 【不替代】复制房间码 —— 两条路并存。跨设备 / 发微信还是得靠码。
//   · 双向确认：房主发邀请 → 对方同意了才进来。
//   · 【只有房主能邀请】。被邀请进来的玩家既拿不到房间码（服务端只在
//     emitRoomInviteInfo 里发，而那里第一行就是 ownerUserId 校验），
//     也不能再邀请自己的牌友 —— 否则「房主控制谁能进」这条就形同虚设：
//     一个被拉进来的人可以再拉一串陌生人，而房主毫不知情。
//
// 🔴 服务端【必须】存一份待办邀请。光靠客户端只给房主显示按钮是假闸 ——
//    任何人都能自己 emit 一个 invite_respond。没有 FRIEND_INVITES 里的那条记录就不放行。
const FRIEND_INVITES = new Map();          // `${roomId}:${被邀请者}` -> { from, at }
const INVITE_TTL_MS = 3 * 60 * 1000;       // 过期就作废，别让一条邀请永远挂着
const inviteKey = (roomId, userId) => `${roomId}:${userId}`;
function sweepInvites() {
    const cutoff = Date.now() - INVITE_TTL_MS;
    for (const [k, v] of FRIEND_INVITES) if (v.at < cutoff) FRIEND_INVITES.delete(k);
}
function registerInviteEvents(context, handleJoinRoom) {
    const { socket, user, io, db, roomGames, canAuthorizeNewUser, findRoomByJoinCode,
        findRoomByInviteToken, codeAttemptLimited, recordCodeFailure, clearUserCodeFailures,
        authorize, emitRoomInviteInfo, createRoomInvite, persistence } = bind(context);
    // byCode 保留在形参外：旧页面即使发送 byCode:true，也只能按未授权用户观战。
    socket.on('join_room', (payload = {}) => handleJoinRoom(payload?.roomId));

    socket.on('join_by_code', (payload = {}) => {
        const code = String(payload?.code || '').trim();
        if (codeAttemptLimited(socket, user.id)) {
            socket.emit('invite_error', { source: 'code', k: 'invite.tooMany' });
            return;
        }
        const match = findRoomByJoinCode(code);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            recordCodeFailure(socket, user.id);
            socket.emit('invite_error', { source: 'code', k: 'invite.badCode' });
            return;
        }
        const [roomId] = match;
        clearUserCodeFailures(user.id);
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('join_by_invite', (payload = {}) => {
        const token = String(payload?.token || '').trim();
        const match = findRoomByInviteToken(token);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            socket.emit('invite_error', { source: 'link', k: 'invite.badLink' });
            return;
        }
        const [roomId] = match;
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('get_room_invite', () => {
        const game = socket.currentRoom && roomGames[socket.currentRoom];
        if (!game || game.ownerUserId !== user.id) return;
        emitRoomInviteInfo(socket, game);
    });

    socket.on('set_entry_locked', (payload = {}) => {
        const locked = payload?.locked;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id || typeof locked !== 'boolean') return;
        game.invite.entryLocked = locked;
        persistence.commit(roomId, 'entry_lock_changed', user.id, { locked });
        emitRoomInviteInfo(socket, game);
        io.in(roomId).emit('server_msg', { k: locked ? 'host.entryLocked' : 'host.entryOpen' });
    });

    // 目标现在在哪。只邀请【在大厅】的人：正在别的牌桌的人要先从那张桌摘下来，
    // 牵扯离座/结算一整条链路；产品上也不该把人从一手牌里拽走。
    function whereIs(userId) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id === userId) return { socket: s, roomId: s.currentRoom || null };
        }
        return null;
    }
    function notifyUser(userId, k, p) {
        for (const s of io.sockets.sockets.values()) if (s.user?.id === userId) s.emit('server_msg', { k, p });
    }

    socket.on('invite_friend', ({ userId } = {}) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        // 🔴 整条功能的闸就是这一行。客户端那个 .owner-only 只是别让人看见按钮而已。
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', { k: 'invite.onlyOwner' }); return; }
        if (!userId || typeof userId !== 'string' || userId === user.id) return;
        // 只能邀请【已经是牌友】的人 —— 否则这就成了一个骚扰任意用户的接口
        if (db.friends.edgeStatus(user.id, userId) !== 'accepted') {
            socket.emit('server_msg', { k: 'invite.notFriend' }); return;
        }
        const at = whereIs(userId);
        if (!at) { socket.emit('server_msg', { k: 'invite.offline' }); return; }
        if (at.roomId === roomId) { socket.emit('server_msg', { k: 'invite.alreadyHere' }); return; }
        if (at.roomId) { socket.emit('server_msg', { k: 'invite.busy' }); return; }
        // 房主自己锁了入场就【不绕过】。静默放行会变成「我明明锁了，他怎么进来的」，
        // 而解锁只要点一下，把话说清楚比替他做主好。
        if (game.invite?.entryLocked) { socket.emit('server_msg', { k: 'invite.locked' }); return; }
        if (!canAuthorizeNewUser(game, userId)) { socket.emit('server_msg', { k: 'invite.cantJoin' }); return; }

        sweepInvites();
        const key = inviteKey(roomId, userId);
        if (FRIEND_INVITES.has(key)) { socket.emit('server_msg', { k: 'invite.pending' }); return; }
        FRIEND_INVITES.set(key, { from: user.id, at: Date.now() });

        at.socket.emit('friend_invite', {
            roomId,
            roomName: game.config?.name || roomId,
            roomType: game.roomType,
            fromName: nameOf(user),
            sb: game.config?.sb || 0,
            bb: game.config?.bb || 0,
            expiresAt: Date.now() + INVITE_TTL_MS,
            // ⚠️ 【绝不带 joinCode】。被邀请者从头到尾不该知道房间码，
            //    否则他转手发给别人，房主控制入场那条就没了。
        });
        const target = db.getUserById(userId);
        socket.emit('server_msg', { k: 'invite.sent', p: { name: nameOf(target || {}) } });
    });

    socket.on('invite_respond', ({ roomId, accept } = {}) => {
        if (!roomId || typeof roomId !== 'string') return;
        sweepInvites();
        const key = inviteKey(roomId, user.id);
        const pending = FRIEND_INVITES.get(key);
        // 🔴 没有这条记录 = 根本没人邀请过你。自己伪造一个 invite_respond 是进不来的。
        if (!pending) { socket.emit('server_msg', { k: 'invite.expired' }); return; }
        FRIEND_INVITES.delete(key);
        const game = roomGames[roomId];
        if (!game) { socket.emit('server_msg', { k: 'invite.gone' }); return; }
        if (!accept) { notifyUser(pending.from, 'invite.declined', { name: nameOf(user) }); return; }
        // 从发出邀请到现在可能已经开赛/坐满了，落地前再查一次
        if (!canAuthorizeNewUser(game, user.id)) { socket.emit('server_msg', { k: 'invite.cantJoin' }); return; }
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
        notifyUser(pending.from, 'invite.accepted', { name: nameOf(user) });
    });

    socket.on('reset_room_invite', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id) return;
        const locked = !!game.invite?.entryLocked;
        const version = (game.invite?.version || 0) + 1;
        const oldCode = game.invite?.joinCode || '';
        game.invite = createRoomInvite(roomId, oldCode);
        game.invite.entryLocked = locked;
        game.invite.version = version;
        persistence.commit(roomId, 'invite_reset', user.id, { version });
        emitRoomInviteInfo(socket, game);
        socket.emit('server_msg', { k: 'invite.reset' });
    });


}
module.exports = { registerInviteEvents };
