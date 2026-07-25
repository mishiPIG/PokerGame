'use strict';

function registerDisconnectEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction } = tableService;
    socket.on('disconnect', () => {
        console.log(`[-] ${user.username} 下线`);
        lobbySockets.delete(socket.id);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        const player = game.players[idx];
        // 只有「当前生效的那个 socket」掉线才影响玩家：被单会话踢掉的旧标签页断开时，
        // player.socketId 可能已指向新页面，此时不应把在玩的玩家误标记为掉线。
        if (player.socketId && player.socketId !== socket.id) return;
        player.away = true;   // 标记掉线（座位保留，可重连）

        io.to(roomId).emit('server_msg', `🔌 ${user.username} 掉线（保留座位，可重连）`);

        // ⚠️ 不再「掉线即立即弃牌」！socket.io 网络抖动/传输切换会瞬断重连，
        // 立即弃牌会误杀正常玩家（表现为「闪回大厅再进来就成了弃牌」）。
        // 改为交给行动计时器兜底：
        //  · 若正轮到掉线者：保留当前计时不动，给重连留出时间；到点 onActionTimeout
        //    会「无注则自动过牌(留在局里)、有注才弃牌」——比无条件弃牌合理得多。
        //  · 若没轮到他：留在本局，等轮到他时 startActionTimer 见 away 走快速超时自动处理。
        // 重连(join_room)会把 away 置回 false 并（若轮到他）重启计时。
        broadcastState(roomId);
    });
}

module.exports = { registerDisconnectEvents };
