'use strict';

// Keeps room-entry and reconnection policy in the room domain. Socket event files
// only bind transport events to this service; emitted events and payloads are kept
// byte-for-byte compatible with the original handler.
function createMembershipService({ io, runtime, tableService, config }) {
    const { roomGames, lobbySockets } = runtime;
    const { PHASES } = config;
    const {
        listRooms, authorize, broadcastState, emitStraddleOffer, broadcastRoomList,
        liveCount, scheduleNextHand, joinAsSpectator, seatPlayer, startActionTimer
    } = tableService;

    function joinRoom(socket, user, roomId) {
        roomId = String(roomId || '');
        const game = roomGames[roomId];
        if (!game) { socket.emit('server_msg', { k: 'room.gone' }); socket.emit('room_list', listRooms(user.id)); return; }
        clearTimeout(game.emptyCleanupTimer);

        const isKnownMember = game.authorized?.has(user.id)
            || game.players.some(p => p.userId === user.id)
            || (game.vacatedPlayers || []).some(v => v.userId === user.id);
        if (isKnownMember) {
            socket.playRoom = roomId;
            authorize(roomId, user.id);
        } else if (socket.playRoom === roomId) {
            socket.playRoom = null;
        }

        const existing = game.players.find(p => p.userId === user.id);
        if (existing) {
            existing.socketId = socket.id;
            existing.away = false;
            // 人回来了 → 撤掉「全员离线自动解散」的待执行计时，避免还在玩的房残留待解散状态
            if (game.emptyCleanupTimer) { clearTimeout(game.emptyCleanupTimer); game.emptyCleanupTimer = null; }
            if (existing.reserveTimer) { clearTimeout(existing.reserveTimer); existing.reserveTimer = null; }
            if (existing.reserved || existing.standing) {
                existing.reserved = false; existing.standing = false;
                if (existing.chips > 0) existing.sittingOut = false;
            }
            lobbySockets.delete(socket.id);
            socket.join(roomId);
            socket.currentRoom = roomId;
            socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
            socket.emit('server_msg', '🔄 重新连接成功');
            if (game.holeCards[user.id]) {
                socket.emit('hole_cards', game.holeCards[user.id].map(c => ({ suit: c.suit, rank: c.rank })));
            }
            if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN
                && game.actionOnIdx >= 0 && game.players[game.actionOnIdx]?.userId === user.id) {
                startActionTimer(roomId);
            } else if ((game.roomType === 'cash' || game.roomType === 'sng') && game.status === 'running' && !existing.sittingOut
                && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2) {
                scheduleNextHand(roomId);   // 续局（含：全员掉线暂停后，有人重连即恢复发牌；SNG 也适用）
            }
            broadcastState(roomId);
            emitStraddleOffer(game, socket);
            broadcastRoomList();
            return;
        }

        if (game.roomType === 'cash') {
            joinAsSpectator(roomId, socket);
            return;
        }
        if (!isKnownMember) { joinAsSpectator(roomId, socket); return; }
        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', { k: 'room.full' }); return; }
        if (game.status === 'running') { socket.emit('server_msg', { k: 'room.started' }); return; }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) { socket.emit('server_msg', { k: 'room.handInProgress' }); return; }
        seatPlayer(roomId, socket, user);
    }

    return { joinRoom };
}

module.exports = { createMembershipService };
