'use strict';

// 牌友系统（2026-09-13，第 1 批：列表 + 双向确认 + 备注 + 「上次一起玩的人」）。
//
// 产品名叫「好友开房」，但在此之前全库连 friend 这个词都没有 —— 想一起玩的唯一路径是
// 「房主复制房间码 → 切到微信发 → 对方切回来输码」，每局重来一遍。
//
// ⚠️ 第 1 批【不含】一键邀请。等这批有人用了再接，那条要沿用「只有房主能邀」的闸
//    （见 lobby-service 的 emitRoomInviteInfo：服务端本来就只把 joinCode 发给房主）。

function registerFriendEvents(context) {
    const { socket, user, io, db, runtime } = context;
    const { roomGames } = runtime;

    // 某人现在在哪：离线 / 在大厅 / 在某张牌桌。
    // 靠 io 里该用户的 socket 有没有 currentRoom —— 不另存一份在线表，
    // 免得断线/重连时两边对不上（那种不一致最后总会以「显示在线其实早走了」暴露出来）。
    function presenceOf(userId) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id !== userId) continue;
            const roomId = s.currentRoom;
            if (roomId && roomGames[roomId]) return { online: true, roomId };
            return { online: true, roomId: null };
        }
        return { online: false, roomId: null };
    }

    function withPresence(list) {
        return list.map(f => ({ ...f, ...presenceOf(f.userId) }));
    }

    function sendList(target = socket) {
        const uid = target.user?.id;
        if (!uid) return;
        target.emit('friend_list', {
            friends: withPresence(db.friends.listFriends(uid)),
            incoming: db.friends.listIncoming(uid),
            outgoing: db.friends.listOutgoing(uid),
        });
    }

    // 对方也在线时，顺手刷新他那份列表（否则他要手动重开面板才看得到新申请）
    function pushTo(userId) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id === userId) sendList(s);
        }
    }

    socket.on('friend_list', () => sendList());

    // 「上次一起玩的人」：零新数据，全从牌谱查（已排除掉已有关系的人）
    socket.on('friend_recent', () => {
        try {
            socket.emit('friend_recent', { list: withPresence(db.friends.recentTablemates(user.id)) });
        } catch (e) {
            console.error('[friend] recentTablemates 失败', e);
            socket.emit('friend_recent', { list: [] });
        }
    });

    socket.on('friend_request', ({ userId } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (!db.getUserById(userId)) { socket.emit('server_msg', { k: 'friend.noUser' }); return; }
        const result = db.friends.request(user.id, userId);
        const msg = { self: 'friend.self', already: 'friend.already', pending: 'friend.pending',
                      accepted: 'friend.accepted', requested: 'friend.requested' }[result];
        if (msg) socket.emit('server_msg', { k: msg });
        sendList();
        pushTo(userId);
    });

    socket.on('friend_respond', ({ userId, accept } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (accept) {
            if (!db.friends.accept(user.id, userId)) { socket.emit('server_msg', { k: 'friend.noRequest' }); return; }
            socket.emit('server_msg', { k: 'friend.accepted' });
        } else {
            db.friends.remove(user.id, userId);       // 拒绝 = 两行一起删，不留单边关系
        }
        sendList();
        pushTo(userId);
    });

    socket.on('friend_remove', ({ userId } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        db.friends.remove(user.id, userId);
        sendList();
        pushTo(userId);
    });

    // ⚠️ 备注是【私有】的：只写我这一行，并且【绝不 pushTo 对方】——
    //    他不该知道我给他记了「爱诈唬」。friend-repository 那边只更新我这一行，
    //    这里再守一次「不往对方推」，两层都有测试锁着。
    socket.on('friend_note', ({ userId, note } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (!db.friends.setNote(user.id, userId, note)) {
            socket.emit('server_msg', { k: 'friend.noteFailed' });
            return;
        }
        sendList();
    });
}

module.exports = { registerFriendEvents };
