'use strict';
const { bind } = require('./room-context');
function registerInviteEvents(context, handleJoinRoom) {
    const { socket, user, io, roomGames, canAuthorizeNewUser, findRoomByJoinCode,
        findRoomByInviteToken, codeAttemptLimited, recordCodeFailure, clearUserCodeFailures,
        authorize, emitRoomInviteInfo, createRoomInvite, persistence } = bind(context);
    // byCode 保留在形参外：旧页面即使发送 byCode:true，也只能按未授权用户观战。
    socket.on('join_room', (payload = {}) => handleJoinRoom(payload?.roomId));

    socket.on('join_by_code', (payload = {}) => {
        const code = String(payload?.code || '').trim();
        if (codeAttemptLimited(socket, user.id)) {
            socket.emit('invite_error', { source: 'code', message: '尝试次数过多，请稍后再试' });
            return;
        }
        const match = findRoomByJoinCode(code);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            recordCodeFailure(socket, user.id);
            socket.emit('invite_error', { source: 'code', message: '房间码无效或当前不可加入' });
            return;
        }
        const [roomId] = match;
        clearUserCodeFailures(user.id);
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('join_by_invite', (payload = {}) => {
        const token = String(payload?.token || '').trim();
        const match = findRoomByInviteToken(token);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            socket.emit('invite_error', { source: 'link', message: '邀请已失效或当前不可加入' });
            return;
        }
        const [roomId] = match;
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('get_room_invite', () => {
        const game = socket.currentRoom && roomGames[socket.currentRoom];
        if (!game || game.ownerUserId !== user.id) return;
        emitRoomInviteInfo(socket, game);
    });

    socket.on('set_entry_locked', (payload = {}) => {
        const locked = payload?.locked;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id || typeof locked !== 'boolean') return;
        game.invite.entryLocked = locked;
        persistence.commit(roomId, 'entry_lock_changed', user.id, { locked });
        emitRoomInviteInfo(socket, game);
        io.in(roomId).emit('server_msg', locked ? '🔒 房主已锁定新玩家入场' : '🔓 房主已开放新玩家入场');
    });

    socket.on('reset_room_invite', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id) return;
        const locked = !!game.invite?.entryLocked;
        const version = (game.invite?.version || 0) + 1;
        const oldCode = game.invite?.joinCode || '';
        game.invite = createRoomInvite(roomId, oldCode);
        game.invite.entryLocked = locked;
        game.invite.version = version;
        persistence.commit(roomId, 'invite_reset', user.id, { version });
        emitRoomInviteInfo(socket, game);
        socket.emit('server_msg', '🔄 邀请链接和房间码已重置');
    });


}
module.exports = { registerInviteEvents };
