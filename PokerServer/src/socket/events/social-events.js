'use strict';

function registerSocialEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction } = tableService;
    // 桌内文字聊天：广播给同房间（含观众）。限频 + 长度限制
    socket.on('chat_msg', ({ text }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        text = (text || '').toString().slice(0, 120).trim();
        if (!text) return;
        const now = Date.now();
        if (now - (socket._lastChat || 0) < 600) return;   // 限频 0.6s
        socket._lastChat = now;
        io.in(roomId).emit('chat_broadcast', { userId: user.id, displayName: user.displayName || user.username, text, ts: now });
    });

    // 表情/互动：在发送者座位上方冒一个大表情（可带目标=扔给某人）。限频
    socket.on('emote', ({ emote, targetUserId }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        if (typeof emote !== 'string' || emote.length > 8) return;
        const now = Date.now();
        if (now - (socket._lastEmote || 0) < 800) return;   // 限频 0.8s
        socket._lastEmote = now;
        io.in(roomId).emit('emote_broadcast', { userId: user.id, emote, targetUserId: targetUserId || null });
    });

    // 点头像看「本局」数据（VPIP/PFR/3bet/ATS…）：按当前房间聚合，摊牌信息公开可见
    socket.on('req_player_stats', ({ targetUserId }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        const uid = targetUserId || user.id;
        socket.emit('player_stats', { userId: uid, stats: stats.computeUserStats(uid, null, roomId) });
    });

    // 重连/刷新后只恢复尚在 10 秒展示期内的语音气泡，不构成聊天历史。
    socket.on('voice_sync', (roomId) => {
        roomId = String(roomId || '');
        if (socket.currentRoom !== roomId || !roomGames[roomId]) return;
        syncRecentVoices(socket, roomId);
    });


}

module.exports = { registerSocialEvents };
