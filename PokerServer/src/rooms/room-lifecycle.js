'use strict';

// 空房宽限：到点【再查一次】房里还有没有连接，有人连着就不解散。可用 env 覆盖以便测试。
const EMPTY_GRACE_MS = Number(process.env.EMPTY_GRACE_MS) || 180000;

// Shared room-close policy. It deliberately receives the current cash-table
// operations as hooks so it does not own Poker or settlement rules.
function createRoomLifecycle({ io, roomGames, hooks }) {
    const { endCashTable, clearActionTimer, broadcastRoomList, finishRoom, dissolveNow } = hooks;

    function scheduleEmptyCleanup(roomId) {
        const game = roomGames[roomId];
        if (!game) return;
        clearTimeout(game.emptyCleanupTimer);
        game.emptyCleanupTimer = setTimeout(() => {
            const g = roomGames[roomId];
            if (!g || g.tournamentOver) return;
            const room = io.sockets.adapter.rooms.get(roomId);
            if (room && room.size > 0) return;
            // 🔴 还在一手牌里：不能当场结算 —— 结算只按 chips 兑出，已经下进池里的筹码会凭空消失。
            //    挂上「本手打完再解散」，交给局间那唯一的入口去做（cash-match-service.runNextHand）。
            //    房里没人时行动计时器会快速代打（见 hand-service.startActionTimer），这手很快就能打完。
            const inHand = g.phase && g.phase !== 'waiting' && g.phase !== 'showdown';
            // 记成 'empty' 而不是 true：有人回来时要能撤销（房主点的「本手后解散」不能被撤销）
            if (inHand) { g.pendingDissolve = g.pendingDissolve || 'empty'; return; }
            const hasChips = (g.vacatedPlayers || []).some(v => (v.chips || 0) > 0) || g.players.some(p => (p.chips || 0) > 0);
            if (hasChips) {
                // SNG 不能走现金结算：奖池要给筹码领先者 + 公布排名（dissolveNow 按房型路由）
                if (g.roomType === 'sng' && dissolveNow) dissolveNow(roomId);
                else endCashTable(roomId, '房间空置已关闭');
            } else {
                clearTimeout(g.levelTimer); clearTimeout(g.nextHandTimer); clearTimeout(g.runoutTimer);
                clearTimeout(g.tableTimer); clearActionTimer(g);
                if (finishRoom) finishRoom(roomId, 'cancelled');
                delete roomGames[roomId]; broadcastRoomList();
            }
        }, EMPTY_GRACE_MS);
    }

    return { scheduleEmptyCleanup };
}

module.exports = { createRoomLifecycle };
