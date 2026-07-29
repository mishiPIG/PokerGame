'use strict';

const { displayNameChangeAllowed, displayNameChangeRemainingMs, normalizeDisplayName } = require('../../account/display-name');

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
        socket.emit('profile', { avatar: avatar || null, displayName: user.displayName, displayNameChangedAtMs: user.displayNameChangedAtMs });
    });

    socket.on('set_display_name', (payload = {}, ack) => {
        payload = payload && typeof payload === 'object' ? payload : {};
        const displayName = normalizeDisplayName(payload.displayName);
        if (!displayName) return ack?.({ ok: false, error: '显示名称须为 2–16 个字符，仅支持中文、字母、数字、空格、_、-、.' });
        const freshUser = db.getUserById(user.id);
        if (freshUser?.displayName === displayName) return ack?.({ ok: true, displayName, displayNameChangedAtMs: freshUser.displayNameChangedAtMs });
        if (!freshUser || !displayNameChangeAllowed(freshUser)) {
            return ack?.({ ok: false, error: '显示名称每 24 小时只能修改一次', remainingMs: displayNameChangeRemainingMs(freshUser) });
        }
        const updated = db.setDisplayName(user.id, displayName);
        Object.assign(user, updated, { displayName: updated.displayName });
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            game.players.filter(p => p.userId === user.id).forEach(p => { p.displayName = updated.displayName; });
            (game.vacatedPlayers || []).filter(p => p.userId === user.id).forEach(p => { p.displayName = updated.displayName; });
            broadcastState(roomId);
        }
        socket.emit('profile', { avatar: user.avatar || null, displayName: updated.displayName, displayNameChangedAtMs: updated.displayNameChangedAtMs });
        ack?.({ ok: true, displayName: updated.displayName, displayNameChangedAtMs: updated.displayNameChangedAtMs });
    });


}

module.exports = { registerConnectionEvents };
