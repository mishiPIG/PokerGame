'use strict';

const { registerConnectionEvents } = require('./events/connection-events');
const { registerRoomEvents } = require('./events/room-events');
const { registerTableControlEvents } = require('./events/table-control-events');
const { registerPokerCardEvents } = require('./events/poker-card-events');
const { registerSocialEvents } = require('./events/social-events');
const { registerPokerActionEvents } = require('./events/poker-action-events');
const { registerDisconnectEvents } = require('./events/disconnect-events');

function registerSocketHandlers(deps) {
    const { io, db, runtime, tableService } = deps;
    io.on('connection', (socket) => {
        const user = socket.user;
        const rawOn = socket.on.bind(socket);
        socket.on = (event, handler) => rawOn(event, (...args) => {
            if (runtime.shuttingDown && event !== 'disconnect') {
                socket.emit('server_msg', '⚠️ 服务正在安全重启，请稍后重新连接');
                return undefined;
            }
            const handleError = error => {
                console.error(`[socket-error] event=${event} userId=${user.id}`, error?.stack || error);
                const roomId = socket.currentRoom;
                const game = roomId && runtime.roomGames[roomId];
                if (game) {
                    game.paused = true;
                    game.recoveryError = {
                        event,
                        message: String(error?.message || error),
                        at: Date.now()
                    };
                    try {
                        tableService.persistence.commit(roomId, 'operation_failed', user.id, {
                            event,
                            message: game.recoveryError.message
                        });
                    } catch (persistError) {
                        console.error('[socket-error] failed to persist paused state', persistError?.stack || persistError);
                    }
                }
                socket.emit('server_msg', '⚠️ 本次操作失败，牌桌已安全暂停，请稍后重试或重新连接');
            };
            try {
                const result = handler(...args);
                if (result && typeof result.then === 'function') result.catch(handleError);
                return result;
            } catch (error) {
                handleError(error);
                return undefined;
            }
        });
        // 单会话：同一账号新开页面/设备连接 → 踢掉该账号之前的连接（最新生效）。
        // 否则底牌是私发给单个 socketId 的，多标签会导致其中一个页面看不到自己的手牌。
        for (const [, s] of io.sockets.sockets) {
            if (s !== socket && s.user && s.user.id === user.id) {
                s.emit('session_kicked', { reason: '你的账号在新的页面或设备打开，此页面已断开（同一账号只能在一个页面使用）' });
                s.disconnect(true);
            }
        }
        console.log(`[+] ${user.username} 上线`);
        socket.emit('gold_update', { gold: user.gold });
        socket.emit('profile', { avatar: db.getUserById(user.id)?.avatar || null });

        const context = { ...deps, socket, user };
        registerConnectionEvents(context);
        registerRoomEvents(context);
        registerTableControlEvents(context);
        registerPokerCardEvents(context);
        registerSocialEvents(context);
        registerPokerActionEvents(context);
        registerDisconnectEvents(context);
    });
}

module.exports = { registerSocketHandlers };
