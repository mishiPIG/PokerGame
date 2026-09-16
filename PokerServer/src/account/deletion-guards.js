'use strict';

// 注销前的「你还在牌局里吗」检查（2026-09-16）。
//
// 为什么单拿出来写成纯函数：它原本写在路由的闭包里，而闭包里的东西没办法单测 ——
// 本项目吃过好几次「闸写了但从来没生效」的亏（sizeFor 拼错那次测试还一路全绿）。
//
// 为什么这道闸必须有：玩家的筹码只存在内存的 roomGames 里，结算才会换回金币。
// 坐着的时候把号抹了，那桌的座位对象就指向一个已不存在的人，
// 他的筹码凭空消失，而且广播时的外键写入会报错把牌桌静默 paused。
// 站起围观（vacatedPlayers）同理 —— 那些筹码也还没结算。

function findBlockingRoom(roomGames, userId) {
    for (const [roomId, game] of Object.entries(roomGames || {})) {
        if (!game) continue;
        const seated = (game.players || []).some(p => p && p.userId === userId);
        const vacated = (game.vacatedPlayers || []).some(p => p && p.userId === userId);
        if (seated || vacated) return roomId;
    }
    return null;
}

module.exports = { findBlockingRoom };
