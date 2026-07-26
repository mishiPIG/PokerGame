'use strict';

const { createPokerService } = require('../games/poker/poker-service');
const { createLobbyService } = require('../rooms/lobby-service');
const { createMatchResultService } = require('../matches/match-result-service');
const { createSngMatchService } = require('../matches/sng-match-service');
const { createCashMatchService } = require('../matches/cash-match-service');
const { createSeatService } = require('../rooms/seat-service');

function createTableService({ io, db, stats, equity, Deck, HandEvaluator, crypto, config, runtime }) {
    const { gameSB, gameBB, gameAnte, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const lobbyService = createLobbyService({ io, runtime, config });
    const { clampInt, genRoomId, genJoinCode, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, clientIp, recentFailures, codeAttemptLimited, recordCodeFailure, clearUserCodeFailures, canAuthorizeNewUser, authorize, roomSummary, listRooms, broadcastRoomList } = lobbyService;
    const matchResultService = createMatchResultService({ io, db, roomGames });
    const { recordLeft, buildRanking, sendMatchResult } = matchResultService;
    let seatService;
    let pokerService;
    const sngMatchService = createSngMatchService({ io, db, roomGames, lobbySockets, sngPrize, PHASES: config.PHASES, hooks: { broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, buildRanking, sendMatchResult, listRooms, clearActionTimer: (...args) => pokerService.clearActionTimer(...args) } });
    const cashMatchService = createCashMatchService({ io, db, roomGames, lobbySockets, config, hooks: { buildRanking, sendMatchResult, clearActionTimer: (...args) => pokerService.clearActionTimer(...args), clearStraddleDecision: (...args) => pokerService.clearStraddleDecision(...args), showStraddleDecision: (...args) => pokerService.showStraddleDecision(...args), broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, listRooms, removeBustedPlayers: (...args) => seatService.removeBustedPlayers(...args), liveCount: (...args) => pokerService.liveCount(...args), startHand: (...args) => pokerService.startHand(...args) } });
    const seatHooks = { clampInt, broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, clearActionTimer: (...args) => pokerService.clearActionTimer(...args), afterAction: (...args) => pokerService.afterAction(...args), isBettingRoundComplete: (...args) => pokerService.isBettingRoundComplete(...args), advanceStage: (...args) => pokerService.advanceStage(...args), scheduleNextHand: cashMatchService.scheduleNextHand, liveCount: (...args) => pokerService.liveCount(...args), cashOut: cashMatchService.cashOut, recordLeft };
    seatService = createSeatService({ io, db, roomGames, lobbySockets, config, hooks: seatHooks });
    pokerService = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime, hooks: { applyPendingLevelUp: sngMatchService.applyPendingLevelUp, maybeEndSNG: sngMatchService.maybeEndSNG, scheduleNextHand: cashMatchService.scheduleNextHand, startLevelTimer: sngMatchService.startLevelTimer, startTableTimer: cashMatchService.startTableTimer, broadcastRoomList } });

    return { ...lobbyService, ...matchResultService, ...sngMatchService, ...cashMatchService, ...seatService, ...pokerService, gameSB, gameBB, gameAnte };
}

module.exports = { createTableService };
