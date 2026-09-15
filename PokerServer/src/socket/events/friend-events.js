'use strict';

// 牌友系统（2026-09-13，第 1 批：列表 + 双向确认 + 备注 + 「上次一起玩的人」）。
//
// 产品名叫「好友开房」，但在此之前全库连 friend 这个词都没有 —— 想一起玩的唯一路径是
// 「房主复制房间码 → 切到微信发 → 对方切回来输码」，每局重来一遍。
//
// ⚠️ 第 1 批【不含】一键邀请。等这批有人用了再接，那条要沿用「只有房主能邀」的闸
//    （见 lobby-service 的 emitRoomInviteInfo：服务端本来就只把 joinCode 发给房主）。

const { nameOf } = require('../../account/display-name');

function registerFriendEvents(context) {
    const { socket, user, io, db, runtime } = context;
    const { roomGames } = runtime;

    // 某人现在在哪：离线 / 在大厅 / 在某张牌桌。
    // 靠 io 里该用户的 socket 有没有 currentRoom —— 不另存一份在线表，
    // 免得断线/重连时两边对不上（那种不一致最后总会以「显示在线其实早走了」暴露出来）。
    // exceptSocket：算「下线后的状态」时把正在断开的那条排除掉。
    // socket.io 目前是先把 socket 从表里摘掉再 emit disconnect，所以多数情况下用不上；
    // 但这是库的内部时序，压在上面不划算 —— 排除一下零成本，两种时序都对。
    function presenceOf(userId, exceptSocket) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id !== userId || s.id === exceptSocket) continue;
            const roomId = s.currentRoom;
            if (roomId && roomGames[roomId]) return { online: true, roomId };
            return { online: true, roomId: null };
        }
        return { online: false, roomId: null };
    }

    function withPresence(list, exceptSocket) {
        return list.map(f => ({ ...f, ...presenceOf(f.userId, exceptSocket) }));
    }

    function sendList(target = socket, exceptSocket) {
        const uid = target.user?.id;
        if (!uid) return;
        target.emit('friend_list', {
            myCode: db.getUserById(uid)?.friendCode || '',
            friends: withPresence(db.friends.listFriends(uid), exceptSocket),
            incoming: db.friends.listIncoming(uid),
            outgoing: db.friends.listOutgoing(uid),
            blocked: db.friends.listBlocked(uid),   // 没有「解除」的入口，拉黑就是个陷阱
        });
    }

    // 给某个在线用户弹一条提示（结构化 key，各客户端按自己的语言渲染）
    function notify(userId, k, p) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id === userId) s.emit('server_msg', { k, p });
        }
    }

    // 对方也在线时，顺手刷新他那份列表（否则他要手动重开面板才看得到新申请）
    function pushTo(userId) {
        for (const s of io.sockets.sockets.values()) {
            if (s.user?.id === userId) sendList(s);
        }
    }

    // 我的在线状态变了 → 挨个告诉【在线的】牌友。
    // 🔴 不做这一步，大厅那行「N 位牌友在线」就是一张过期快照：早走的人一直亮着、
    //    刚上线的看不见。而「谁在线」是约局的第一步，它一旦不准，玩家就再也不会信它 ——
    //    一个不可信的状态指示比没有更糟，因为它还在骗人。
    function pushPresenceToFriends(exceptSocket) {
        let friends;
        try { friends = db.friends.listFriends(user.id); } catch { return; }
        if (!friends.length) return;
        const ids = new Set(friends.map(f => f.userId));
        for (const s of io.sockets.sockets.values()) {
            if (s.id !== exceptSocket && s.user && ids.has(s.user.id)) sendList(s, exceptSocket);
        }
    }

    socket.on('friend_list', () => sendList());
    // 连上就推一次：否则「待处理申请」的红点要等玩家主动打开面板才会亮，
    // 那就等于没有提醒（他可能整晚停在「约局」页）。
    sendList();
    pushPresenceToFriends();
    socket.on('disconnect', () => pushPresenceToFriends(socket.id));

    // 对战战绩单独一条事件，【不并进 friend_list】——
    // friend_list 现在是热路径（任何牌友上下线都会推一遍），而这条要扫牌谱（生产实测 ~85ms）。
    // 把它挂上去等于每次有人上线全桌都做一次全表聚合。
    socket.on('friend_h2h', () => {
        try {
            socket.emit('friend_h2h', { list: db.friends.headToHead(user.id) });
        } catch (e) {
            console.error('[friend] headToHead 失败', e);
            socket.emit('friend_h2h', { list: [] });
        }
    });

    // 「上次一起玩的人」：零新数据，全从牌谱查（已排除掉已有关系的人）
    socket.on('friend_recent', () => {
        try {
            socket.emit('friend_recent', { list: withPresence(db.friends.recentTablemates(user.id)) });
        } catch (e) {
            console.error('[friend] recentTablemates 失败', e);
            socket.emit('friend_recent', { list: [] });
        }
    });

    // 搜索加好友：只认【精确匹配】牌友号或用户名。
    // ⚠️ 刻意不做模糊/前缀搜索 —— 那等于让任何人把整个用户库枚举出来。
    // 返回里带上当前关系，客户端好决定显示「加牌友」还是「已是牌友」。
    socket.on('friend_search', ({ q } = {}) => {
        const found = db.findByCodeOrName(q);
        if (!found || found.id === user.id) {
            socket.emit('friend_search', { found: null, self: !!(found && found.id === user.id) });
            return;
        }
        socket.emit('friend_search', {
            found: {
                userId: found.id,
                displayName: found.displayName || found.username,
                avatar: found.avatar || null,
                friendCode: found.friendCode || '',
                status: db.friends.edgeStatus(user.id, found.id),
                ...presenceOf(found.id),
            },
        });
    });

    socket.on('friend_request', ({ userId } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (!db.getUserById(userId)) { socket.emit('server_msg', { k: 'friend.noUser' }); return; }
        const result = db.friends.request(user.id, userId);
        const msg = { self: 'friend.self', already: 'friend.already', pending: 'friend.pending',
                      accepted: 'friend.accepted', requested: 'friend.requested',
                      youBlocked: 'friend.youBlocked' }[result];
        if (msg) socket.emit('server_msg', { k: msg });
        sendList();
        pushTo(userId);
        // 对方在线时给一条明确提示 —— 只在「我的」上点一个小红点太弱，
        // 他可能整晚都停在「约局」页，根本不会注意到。
        if (result === 'requested') notify(userId, 'friend.incomingFrom', { name: nameOf(user) });
        if (result === 'accepted') notify(userId, 'friend.nowFriends', { name: nameOf(user) });
    });

    socket.on('friend_respond', ({ userId, accept } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (accept) {
            if (!db.friends.accept(user.id, userId)) { socket.emit('server_msg', { k: 'friend.noRequest' }); return; }
            socket.emit('server_msg', { k: 'friend.accepted' });
            notify(userId, 'friend.nowFriends', { name: nameOf(user) });
        } else {
            db.friends.remove(user.id, userId);       // 拒绝 = 两行一起删，不留单边关系
        }
        sendList();
        pushTo(userId);
    });

    // 拉黑：解除关系 + 他再也发不进来申请。
    // 刻意【不】做的两件事（等真有人被骚扰了再说）：不阻止他坐同一张公开桌
    // （那要在入座时查每个人的黑名单，链路长，还会产生「我明明能坐却坐不下」的困惑）、
    // 不隐藏我的在线状态。
    socket.on('friend_block', ({ userId } = {}) => {
        if (!userId || typeof userId !== 'string' || userId === user.id) return;
        if (!db.getUserById(userId)) { socket.emit('server_msg', { k: 'friend.noUser' }); return; }
        db.friends.block(user.id, userId);
        socket.emit('server_msg', { k: 'friend.blocked' });
        sendList();
        pushTo(userId);           // 他那边关系没了 —— 和被删好友看起来一模一样
    });

    socket.on('friend_unblock', ({ userId } = {}) => {
        if (!userId || typeof userId !== 'string') return;
        if (db.friends.unblock(user.id, userId)) socket.emit('server_msg', { k: 'friend.unblocked' });
        sendList();
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
