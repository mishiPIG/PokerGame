'use strict';

// 账号资料在库里变了之后，把【内存里】认识这个人的地方一起改过来（2026-11-17，游客保存账号时用）。
//
// 为什么需要：socket.user 是建连接时从库里读出来的一份拷贝，牌桌上的座位对象又各自抄了一份用户名。
// 游客在牌桌上点「保存账号」后，库里已经是正式账号了，这些拷贝却还停在「游客 / guest_xxx」——
// 不改的话他要断线重连一次才能加牌友、签到，而这一手打完落库的名字也还是旧的。
// 只改【身份字段】，筹码 / 座位 / 牌局状态一概不碰。
function refreshLiveUser({ io, roomGames, user }) {
    if (!user) return;
    const fields = { username: user.username, email: user.email, isGuest: user.isGuest, upgradedAtMs: user.upgradedAtMs };
    for (const socket of io?.sockets?.sockets?.values?.() || []) {
        // Object.assign 到同一个对象上：各个事件处理器闭包里拿着的就是这个 socket.user
        if (socket.user?.id === user.id) Object.assign(socket.user, fields);
    }
    for (const game of Object.values(roomGames || {})) {
        for (const list of [game.players, game.vacatedPlayers, game.statsHistory]) {
            for (const p of list || []) if (p && p.userId === user.id) p.username = user.username;
        }
    }
}

module.exports = { refreshLiveUser };
