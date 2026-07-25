'use strict';

function registerConnectionEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction } = tableService;
    // 网络延迟测量：回声
    socket.on('latency_ping', (t) => socket.emit('latency_pong', t));

    // 设置头像：持久化 + 更新在座玩家 + 重广播
    socket.on('set_avatar', ({ avatar }) => {
        if (avatar && typeof avatar !== 'string') return;
        db.setAvatar(user.id, avatar || null);
        user.avatar = avatar || null;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const p = game.players.find(pl => pl.userId === user.id);
            if (p) { p.avatar = avatar || null; broadcastState(roomId); }
        }
        socket.emit('profile', { avatar: avatar || null });
    });


}

module.exports = { registerConnectionEvents };
