'use strict';

const { registerLobbyEvents } = require('./lobby-events');
const { createJoinRoomHandler, registerMembershipEvents } = require('./membership-events');
const { registerInviteEvents } = require('./invite-events');

function registerRoomEvents(context) {
    registerLobbyEvents(context);
    const handleJoinRoom = createJoinRoomHandler(context);
    registerInviteEvents(context, handleJoinRoom);
    registerMembershipEvents(context);
}

module.exports = { registerRoomEvents };
