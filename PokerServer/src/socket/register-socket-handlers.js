'use strict';

const { registerConnectionEvents } = require('./events/connection-events');
const { registerRoomEvents } = require('./events/room-events');
const { registerTableControlEvents } = require('./events/table-control-events');
const { registerPokerCardEvents } = require('./events/poker-card-events');
const { registerSocialEvents } = require('./events/social-events');
const { registerPokerActionEvents } = require('./events/poker-action-events');
const { registerSquidEvents } = require('./events/squid-events');
const { registerDisconnectEvents } = require('./events/disconnect-events');

function registerSocketHandlers(deps) {
    const { io, db } = deps;
    io.on('connection', (socket) => {
        const user = socket.user;
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
        registerSquidEvents(context);
        registerDisconnectEvents(context);
    });
}

module.exports = { registerSocketHandlers };
