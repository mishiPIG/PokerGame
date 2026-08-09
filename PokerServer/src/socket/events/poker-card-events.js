'use strict';
const { nameOf } = require('../../account/display-name');

function registerPokerCardEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction, persistence } = tableService;
    // 主动亮牌：摊牌阶段（含弃牌结束的局间）玩家可选择亮出自己某张/全部底牌
    socket.on('show_card', ({ roomId, index }) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const hole = game.holeCards[user.id];
        if (!hole) return;
        index = parseInt(index);
        if (index !== 0 && index !== 1) return;
        game.shownCards = game.shownCards || {};
        const set = game.shownCards[user.id] || (game.shownCards[user.id] = new Set());
        if (set.has(index)) return;
        set.add(index);
        const shown = [...set].map(i => ({ index: i, suit: hole[i].suit, rank: hole[i].rank }));
        io.in(roomId).emit('show_cards', { userId: user.id, cards: shown });
        io.in(roomId).emit('server_msg', `👁️ ${nameOf(user)} 亮出一张牌`);
        // 每亮一张牌就重置局间倒计时，给大家看牌的时间
        scheduleNextHand(roomId);
        persistence.commit(roomId, 'card_shown', user.id, { index });
    });

    // 看后续牌（rabbit hunt）：弃牌结束的局间，任一玩家可逐步发出剩余公共牌仅供观看
    socket.on('rabbit_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const n = game.communityCards.length;
        if (n >= 5) return;                       // 已到河牌（含真摊牌），无可发
        const count = n === 0 ? 3 : 1;            // 0→翻牌3张，3→转牌1张，4→河牌1张
        const streetName = n === 0 ? '翻牌' : (n === 3 ? '转牌' : '河牌');
        // 公共牌下方显示一行字：谁想看（不走弹幕、不加表情）
        io.in(roomId).emit('table_notice', { text: `${nameOf(user)} 想看${streetName}` });
        const dealt = dealCommunity(game, count);
        io.in(roomId).emit('server_msg', `🐰 看后续牌：${dealt.map(c => c.toString()).join(' ')}`);
        scheduleNextHand(roomId);                 // 重置局间倒计时，给看牌时间
        broadcastState(roomId);
    });


}

module.exports = { registerPokerCardEvents };
