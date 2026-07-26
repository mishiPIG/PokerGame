'use strict';

const EMPTY_GRACE_MS = 180000;

// Shared room-close policy. It deliberately receives the current cash-table
// operations as hooks so it does not own Poker or settlement rules.
function createRoomLifecycle({ io, roomGames, hooks }) {
    const { endCashTable, clearActionTimer, broadcastRoomList, finishRoom } = hooks;

    function scheduleEmptyCleanup(roomId) {
        const game = roomGames[roomId];
        if (!game) return;
        clearTimeout(game.emptyCleanupTimer);
        game.emptyCleanupTimer = setTimeout(() => {
            const g = roomGames[roomId];
            if (!g || g.tournamentOver) return;
            const room = io.sockets.adapter.rooms.get(roomId);
            if (room && room.size > 0) return;
            const hasChips = (g.vacatedPlayers || []).some(v => (v.chips || 0) > 0) || g.players.some(p => (p.chips || 0) > 0);
            if (hasChips) endCashTable(roomId, '房间空置已关闭');
            else {
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
