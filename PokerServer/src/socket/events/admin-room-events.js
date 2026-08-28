'use strict';
const { bind } = require('./room-context');

// 管理员专用的房间管理动作：不用房间码直接进入、强制解散任意房间。
// 均校验 user.isAdmin（socket.user 来自 JWT，带 isAdmin）。
function registerAdminRoomEvents(context, handleJoinRoom) {
    const { socket, user, io, roomGames, PHASES, authorize, endCashTable, broadcastState } = bind(context);
    const dissolveSngRoom = context.tableService.dissolveSngRoom;

    // 不用房间码直接进入任意房间（授予下场资格，绕过 entryLocked/容量等校验）。
    socket.on('admin_join_room', ({ roomId } = {}) => {
        if (!user.isAdmin) { socket.emit('server_msg', '⚠️ 无管理员权限'); return; }
        const game = roomId && roomGames[roomId];
        if (!game) { socket.emit('invite_error', { source: 'code', message: '房间不存在' }); return; }
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    // 强制解散任意房间：复用房主解散逻辑——进行中则等本手打完；现金桌结算筹码+排名，SNG 发奖+排名。
    socket.on('admin_dissolve_room', ({ roomId } = {}) => {
        if (!user.isAdmin) { socket.emit('server_msg', '⚠️ 无管理员权限'); return; }
        const game = roomId && roomGames[roomId];
        if (!game) { socket.emit('server_msg', '⚠️ 房间不存在'); return; }
        const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
        if (inHand) {
            if (game.pendingDissolve) { socket.emit('server_msg', `⚠️ 房间 ${roomId} 已在等本手结束后解散`); return; }
            game.pendingDissolve = true;
            io.in(roomId).emit('server_msg', '🛑 管理员已结束比赛，本手打完后解散');
            broadcastState(roomId);
            socket.emit('server_msg', `已安排解散房间 ${roomId}（本手打完生效）`);
            return;
        }
        if (game.roomType === 'cash') {
            io.in(roomId).emit('server_msg', '🛑 管理员解散了本房');
            endCashTable(roomId, '管理员解散');
        } else {
            dissolveSngRoom(roomId);
        }
        socket.emit('server_msg', `✅ 已解散房间 ${roomId}`);
    });
}

module.exports = { registerAdminRoomEvents };
