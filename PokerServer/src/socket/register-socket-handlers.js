'use strict';

const { registerConnectionEvents } = require('./events/connection-events');
const { registerRoomEvents } = require('./events/room-events');
const { registerTableControlEvents } = require('./events/table-control-events');
const { registerPokerCardEvents } = require('./events/poker-card-events');
const { registerSocialEvents } = require('./events/social-events');
const { registerFriendEvents } = require('./events/friend-events');
const { registerPokerActionEvents } = require('./events/poker-action-events');
const { registerDisconnectEvents } = require('./events/disconnect-events');

const { sanitize } = require('../ops/payload-sanitize');

function registerSocketHandlers(deps) {
    const { io, db, runtime, tableService } = deps;
    io.on('connection', (socket) => {
        const user = socket.user;
        const rawOn = socket.on.bind(socket);
        socket.on = (event, handler) => rawOn(event, (...args) => {
            if (runtime.shuttingDown && event !== 'disconnect') {
                socket.emit('server_msg', { k: 'sys.restarting' });
                return undefined;
            }
            const handleError = error => {
                console.error(`[socket-error] event=${event} userId=${user.id}`, error?.stack || error);
                const roomId = socket.currentRoom;
                const game = roomId && runtime.roomGames[roomId];
                // 🔴 谁的错误才暂停牌桌：只有【这张桌上在座的人 / 房主 / 管理员】。
                //    暂停的本意是「牌局状态可能被改了一半，先停下等人看」——
                //    观战者、路人发的消息出错，牌局状态根本没被他动过，不该停。
                //    原来任何人出错都暂停，于是任何一个观战者构造一条坏消息就能停掉任何一桌（大厅列表里谁都能进去观战）。
                const mayHaveTouchedGame = game && (user.isAdmin || game.ownerUserId === user.id
                    || game.players.some(p => p.userId === user.id));
                if (mayHaveTouchedGame) {
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
                socket.emit('server_msg', { k: 'sys.actionFailed' });
            };
            // 绝大多数处理器的第一个参数是 `({ a, b })` 这样解构的；客户端不带负载时会直接抛 TypeError，
            // 而下面的 handleError 会把发送者所在的整张桌子【暂停发牌】——
            // 也就是任何一个观战者发一条空消息就能停掉一桌。空负载一律补成 {}。
            if (args[0] == null && event !== 'disconnect' && event !== 'latency_ping') args[0] = {};
            if (event !== 'disconnect') args = args.map(a => sanitize(a));
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
        socket.emit('profile', { avatar: user.avatar || null, displayName: user.displayName, displayNameChangedAtMs: user.displayNameChangedAtMs });

        const context = { ...deps, socket, user };
        registerConnectionEvents(context);
        registerRoomEvents(context);
        registerTableControlEvents(context);
        registerPokerCardEvents(context);
        registerSocialEvents(context);
        registerFriendEvents(context);
        registerPokerActionEvents(context);
        registerDisconnectEvents(context);
    });
}

module.exports = { registerSocketHandlers };
