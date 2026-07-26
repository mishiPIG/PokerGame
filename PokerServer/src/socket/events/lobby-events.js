'use strict';
const { bind } = require('./room-context');
function registerLobbyEvents(context) {
    const { socket, user, roomGames, lobbySockets, listRooms, genRoomId, Deck, PHASES, createRoomInvite, clampInt, SNG_BUYIN_TIERS, STANDARD_BLIND_LEVELS, authorize, seatPlayer, emitRoomInviteInfo, joinAsSpectator, persistence } = bind(context);
    // 进入大厅：订阅房间列表
    socket.on('enter_lobby', () => {
        lobbySockets.add(socket.id);
        socket.currentRoom = null;
        socket.emit('room_list', listRooms(user.id));
    });

    // 创建 SNG 房间（双人升盲），创建者自动入座
    socket.on('create_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'sng', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            config: {
                name:        (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的比赛`,
                maxPlayers:  clampInt(cfg.maxPlayers, 2, 9, 2),              // 2–9 人（引擎已支持多人）
                startingStack: clampInt(cfg.startingStack, 5000, 30000, 10000),
                levelMinutes:  clampInt(cfg.levelMinutes, 3, 10, 3),
                buyIn:         SNG_BUYIN_TIERS.includes(+cfg.buyIn) ? +cfg.buyIn : SNG_BUYIN_TIERS[0]
            },
            blindLevels: STANDARD_BLIND_LEVELS,
            currentLevel: 0, levelStartTime: null, prizePool: 0, tournamentOver: false,
            statsHistory: []
        };
        persistence.createMatch(roomId, roomGames[roomId]);
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格
        if (!seatPlayer(roomId, socket, user)) {
            persistence.finish(roomId, 'cancelled');
            delete roomGames[roomId];
        }
        else emitRoomInviteInfo(socket, roomGames[roomId], true);
    });

    // 创建现金桌（2–9 人，固定盲注，金币↔筹码买入），创建者按 buyInChips 买入
    socket.on('create_cash_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        const bb = clampInt(cfg.bb, 20, 1000, 40);
        const sb = clampInt(cfg.sb, 10, bb, Math.floor(bb / 2));
        const minBuyIn = clampInt(cfg.minBuyIn, 2000, 8000, 2000);
        const maxBuyIn = clampInt(cfg.maxBuyIn, 0, 60000, 0);   // 0=无限制
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'cash', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            config: {
                name:      (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的现金桌`,
                maxPlayers: clampInt(cfg.maxPlayers, 2, 9, 6),
                sb, bb, ante: clampInt(cfg.ante, 0, 80, 0), minBuyIn, maxBuyIn,
                allowUtgStraddle: cfg.allowUtgStraddle === true,
                durationH: [0.5, 1, 2, 3, 4, 5, 6].includes(+cfg.durationH) ? +cfg.durationH : 2
            },
            prizePool: 0, tournamentOver: false,
            statsHistory: [], tableEndAt: null, extraMs: 0
        };
        persistence.createMatch(roomId, roomGames[roomId]);
        // 现金桌：房主先以观众身份进桌，点空座位「坐下」再带入（坐下式入座）
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格（无需再输房号）
        joinAsSpectator(roomId, socket);
        emitRoomInviteInfo(socket, roomGames[roomId], true);
    });


}
module.exports = { registerLobbyEvents };
