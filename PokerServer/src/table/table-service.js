'use strict';

const { createPokerService } = require('../games/poker/poker-service');
const { createLobbyService } = require('../rooms/lobby-service');
const { createMatchResultService } = require('../matches/match-result-service');
const { createSngMatchService } = require('../matches/sng-match-service');
const { createCashMatchService } = require('../matches/cash-match-service');
const { createSeatService } = require('../rooms/seat-service');
const { createGamePersistenceService } = require('../persistence/game-persistence-service');

function createTableService({ io, db, stats, equity, Card, Deck, HandEvaluator, crypto, config, runtime }) {
    const { gameSB, gameBB, gameAnte, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const persistence = createGamePersistenceService({ db, runtime, Deck, Card });
    const lobbyService = createLobbyService({ io, runtime, config });
    const { clampInt, genRoomId, genJoinCode, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, clientIp, recentFailures, codeAttemptLimited, recordCodeFailure, clearUserCodeFailures, canAuthorizeNewUser, authorize, roomSummary, listRooms, broadcastRoomList } = lobbyService;
    const matchResultService = createMatchResultService({ io, db, roomGames });
    const { recordLeft, buildRanking, sendMatchResult } = matchResultService;
    let seatService;
    let pokerService;
    const sngMatchService = createSngMatchService({ io, db, roomGames, lobbySockets, sngPrize, persistence, PHASES: config.PHASES, hooks: { broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, buildRanking, sendMatchResult, listRooms, clearActionTimer: (...args) => pokerService.clearActionTimer(...args) } });
    const cashMatchService = createCashMatchService({ io, db, roomGames, lobbySockets, config, persistence, hooks: { buildRanking, sendMatchResult, clearActionTimer: (...args) => pokerService.clearActionTimer(...args), clearStraddleDecision: (...args) => pokerService.clearStraddleDecision(...args), showStraddleDecision: (...args) => pokerService.showStraddleDecision(...args), broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, listRooms, removeBustedPlayers: (...args) => seatService.removeBustedPlayers(...args), liveCount: (...args) => pokerService.liveCount(...args), startHand: (...args) => pokerService.startHand(...args), // 延后解散：本手打完后按房型执行真正的解散
        dissolveNow: (roomId) => (roomGames[roomId]?.roomType === 'cash'
            ? cashMatchService.endCashTable(roomId, '房主提前结束')
            : sngMatchService.dissolveSngRoom(roomId)) } });
    const seatHooks = { clampInt, broadcastState: (...args) => pokerService.broadcastState(...args), broadcastRoomList, clearActionTimer: (...args) => pokerService.clearActionTimer(...args), afterAction: (...args) => pokerService.afterAction(...args), isBettingRoundComplete: (...args) => pokerService.isBettingRoundComplete(...args), advanceStage: (...args) => pokerService.advanceStage(...args), scheduleNextHand: cashMatchService.scheduleNextHand, liveCount: (...args) => pokerService.liveCount(...args), cashOut: cashMatchService.cashOut, recordLeft };
    seatService = createSeatService({ io, db, roomGames, lobbySockets, config, persistence, hooks: seatHooks });
    pokerService = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime, persistence, hooks: { applyPendingLevelUp: sngMatchService.applyPendingLevelUp, maybeEndSNG: sngMatchService.maybeEndSNG, scheduleNextHand: cashMatchService.scheduleNextHand, startLevelTimer: sngMatchService.startLevelTimer, startTableTimer: cashMatchService.startTableTimer, broadcastRoomList } });

    function restoreRecoveredTimers(recovered) {
        for (const { roomId, game } of recovered) {
            if (game.roomType === 'cash' && game.tournamentOver) {
                cashMatchService.endCashTable(roomId, '恢复未完成结算');
                continue;
            }
            if (game.roomType === 'sng' && game.tournamentOver) {
                sngMatchService.restoreDissolveTimer(roomId);
                continue;
            }
            pokerService.restoreActionTimer(roomId);
            pokerService.restoreRunoutTimer(roomId);
            pokerService.restoreRunItTimer(roomId);
            pokerService.restoreStraddleTimer(roomId);
            seatService.restoreReserveTimers(roomId);
            cashMatchService.restoreNextHandTimer(roomId);
            if (game.roomType === 'cash') cashMatchService.restoreTableTimer(roomId);
            if (game.roomType === 'sng') sngMatchService.restoreLevelTimer(roomId);
        }
    }

    return { ...lobbyService, ...matchResultService, ...sngMatchService, ...cashMatchService, ...seatService, ...pokerService, persistence, restoreRecoveredTimers, gameSB, gameBB, gameAnte };
}

module.exports = { createTableService };
