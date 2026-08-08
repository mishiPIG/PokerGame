'use strict';

function createStatePresenter({ io, db, roomGames, PHASES, gameSB, gameBB, gameAnte, ACTION_TIME, EXTRA_MAX, livePots, HandEvaluator, persistence }) {
function broadcastState(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (persistence) persistence.commit(roomId, game._pendingPersistenceEvent || 'state_committed');
    delete game._pendingPersistenceEvent;
    const state = {
        phase: game.phase,
        pot: game.pot,
        currentBet: game.currentBet,
        smallBlind: gameSB(game),
        bigBlind: gameBB(game),
        ante:       gameAnte(game),
        allowUtgStraddle: !!game.config?.allowUtgStraddle,
        straddle: game.straddle ? {
            type: 'utg', userId: game.straddle.userId, amount: game.straddle.amount
        } : null,
        minBuyIn:   game.config?.minBuyIn || 0,
        maxBuyIn:   game.config?.maxBuyIn || 0,
        minBet:     gameBB(game),                                       // 本街首注最小额
        minRaiseTo: game.currentBet + (game.lastRaiseSize || gameBB(game)), // 最小加注目标额
        // 无效加注：当前行动者本街已行动过、且面对的加注不足「一个完整加注」（前方是短码全押）
        // → 行动未被重开，他只能跟/弃。下发给客户端用于置灰加注按钮 + 点击时给出可见提示。
        raiseClosed: (() => {
            const a = game.actionOnIdx >= 0 ? game.players[game.actionOnIdx] : null;
            if (!a || !game.currentBet) return false;
            return !!a.hasActed && (game.currentBet - a.currentBet) < (game.lastRaiseSize || gameBB(game));
        })(),
        roomType:   game.roomType || 'cash',
        roomName:   game.config?.name || roomId,
        maxPlayers: game.config?.maxPlayers || 9,
        sidePots:   livePots(game),
        spectators: listSpectators(roomId),
        vacatedUserIds: (game.vacatedPlayers || []).map(v => v.userId),   // 站起围观者（可带原筹码回座）
        // 站起围观者的战绩（战绩面板灰显保留，别让带入过又离座的人从战绩里消失）
        vacated: (game.vacatedPlayers || []).map(v => ({ userId: v.userId, username: v.username, displayName: v.displayName || v.username, buyIn: v.buyIn || 0, handsPlayed: v.handsPlayed || 0, net: (v.chips || 0) - (v.buyIn || 0) })),
        statsHistory: game.statsHistory || [],       // 已离开/淘汰玩家（战绩面板灰显）
        tableEndAt: game.tableEndAt || null,         // 现金桌训练结束时间戳
        pendingEnd: !!game.pendingEnd,               // 训练时长已到、本手结束后结算（房主可加时）
        pendingDissolve: !!game.pendingDissolve,     // 房主已点结束，本手打完后解散
        paused:      !!game.paused,                  // 房主暂停发牌（本手结束后不开新局，等继续）
        runIt:       game.runItPending && game.runIt   // 多次发牌协商中（落后方选/领先方同意）
                     ? { deciderId: game.runIt.deciderId, leaderId: game.runIt.leaderId, n: game.runIt.n, equities: game.runIt.equities }
                     : null,
        ownerUserId:    game.ownerUserId || null,
        status:         game.status || 'waiting',
        currentLevel:   game.currentLevel || 0,
        nextLevelAt:    game.roomType === 'sng' && game.status === 'running' && game.levelStartTime
                        ? game.levelStartTime + game.config.levelMinutes * 60000 : null,
        pendingLevelUp: !!game.pendingLevelUp,
        tournamentOver: game.tournamentOver || false,
        actionDeadline: game.actionOnIdx >= 0 ? (game.actionDeadline || null) : null, // 行动截止时间戳(ms)
        actionTotalMs:  game.actionOnIdx >= 0 ? (game.actionTotalMs || ACTION_TIME) : null, // 本次行动总时长(环形进度)
        canAddTime:     game.actionOnIdx >= 0 && (game.extraAddedThisTurn || 0) < EXTRA_MAX
                        && (game.players[game.actionOnIdx]?.timeCards || 0) > 0, // 还能加时(未达2min上限且有时间卡)
        buttonUserId:   game.players[game.buttonIdx]?.userId || null,
        actionOnUserId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.userId || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            userId:     p.userId,
            username:   p.username,
            displayName: p.displayName || p.username,
            seat:       p.seat ?? 0,
            avatar:     p.avatar || null,
            chips:      p.chips,
            currentBet: p.currentBet,
            folded:     p.folded,
            allIn:      p.allIn,
            ready:      p.ready,
            away:       !!p.away,
            sittingOut: !!p.sittingOut,            // 现金桌坐出（等补码）
            reserved:   !!p.reserved,              // 留座离座中
            standing:   !!p.standing,              // 站起围观中（筹码保留，结束时结算）
            reserveLeaveAt: p.reserveLeaveAt || null,
            pendingRebuy: p.pendingRebuy || 0,     // 下一手生效的补码
            autoRebuy:  !!p.autoRebuy,             // 现金桌自动补码
            buyIn:      p.buyIn || 0,              // 累计带入（战绩面板）
            handsPlayed: p.handsPlayed || 0,       // 已玩手数（战绩面板）
            timeCards:  p.timeCards || 0           // 剩余时间卡（加时消耗）
        }))
    };
    io.in(roomId).emit('game_state', state);
    emitHandHints(roomId);
}

// 房间内未入座的观众（在 room 但不在 players）
function listSpectators(roomId) {
    const game = roomGames[roomId];
    if (!game) return [];
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    const seated = new Set(game.players.map(p => p.socketId));
    const specs = [];
    for (const sid of room) {
        if (seated.has(sid)) continue;
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) specs.push({ userId: s.user.id, username: s.user.username, displayName: s.user.displayName || s.user.username, avatar: s.user.avatar || null });
    }
    return specs;
}

// 向每位在局玩家私发其「当前最强 5 张牌」+ 牌型名（仅 flop 起，showdown 由 reveal 接管）
function emitHandHints(roomId) {
    const game = roomGames[roomId];
    if (!game || game.phase === PHASES.SHOWDOWN) return;
    const comLen = game.communityCards.length;
    if (comLen < 3) return;
    game.players.forEach(p => {
        if (!p.socketId || !game.holeCards[p.userId]) return;
        const cards = game.communityCards.concat(game.holeCards[p.userId]);
        const bh = HandEvaluator.bestHandFrom(cards);
        if (!bh) return;
        const community = bh.indices.filter(i => i < comLen);
        const hole = bh.indices.filter(i => i >= comLen).map(i => i - comLen);
        // 已弃牌的人也发（标记 folded=true）：玩家反馈「弃牌后就看不到自己最终会是什么牌型了」。
        // 这只用到他【自己的底牌 + 公共牌】，不含任何对手信息，且是私发给本人，不影响公平性。
        io.to(p.socketId).emit('my_hand', { community, hole, category: bh.category, folded: !!p.folded });
    });
}


    return { broadcastState, listSpectators, emitHandHints };
}

module.exports = { createStatePresenter };
