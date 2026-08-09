'use strict';

const { createPokerRules } = require('./poker-rules');
const { createPotService } = require('./pot-service');
const { createStatePresenter } = require('./state-presenter');
const { createStraddleService } = require('./extensions/straddle/straddle-service');
const { createRunItService } = require('./extensions/run-it/run-it-service');
const { createShowdownService } = require('./showdown-service');
const { createHandHistoryService } = require('./hand-history-service');
const { createHandService } = require('./hand-service');

// Poker hand orchestration only. Match and room policies are supplied as hooks so
// the existing public table-service API can remain unchanged during this refactor.
function createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime, hooks, persistence }) {
    const { PHASES, gameSB, gameBB, gameAnte, ACTION_TIME, EXTRA_MAX, STRADDLE_DECISION_MS } = config;
    const { roomGames } = runtime;
    const pokerRules = createPokerRules();
    const handHistoryService = createHandHistoryService({ db, persistence, roomGames, HandEvaluator });
    const potService = createPotService({ io, roomGames, gameBB });
    const statePresenter = createStatePresenter({ io, db, roomGames, PHASES, gameSB, gameBB, gameAnte, ACTION_TIME, EXTRA_MAX, livePots: potService.livePots, HandEvaluator, persistence });
    const straddleService = createStraddleService({ io, roomGames, PHASES, gameBB, gameAnte, STRADDLE_DECISION_MS, persistence });

    const runItService = createRunItService({
        io, roomGames, HandEvaluator, equity, config, persistence, activePlayers: pokerRules.activePlayers,
        buildSidePots: potService.buildSidePots,
        hooks: { broadcastState: statePresenter.broadcastState, saveHandHistory: handHistoryService.saveHandHistory, commitHandHistory: handHistoryService.commitHandHistory, applyPendingLevelUp: hooks.applyPendingLevelUp, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand, advanceStage: (...args) => handService.advanceStage(...args) }
    });
    const showdownService = createShowdownService({
        io, roomGames, HandEvaluator, activePlayers: pokerRules.activePlayers,
        buildSidePots: potService.buildSidePots, returnUncalledBets: potService.returnUncalledBets,
        hooks: { saveHandHistory: handHistoryService.saveHandHistory, commitHandHistory: handHistoryService.commitHandHistory, applyPendingLevelUp: hooks.applyPendingLevelUp, broadcastState: statePresenter.broadcastState, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand }
    });
    const handService = createHandService({
        io, roomGames, Deck, HandEvaluator, equity, config, rules: pokerRules, pots: potService,
        presenter: statePresenter, straddle: straddleService, runIt: runItService,
        showdown: showdownService, history: handHistoryService,
        hooks: { applyPendingLevelUp: hooks.applyPendingLevelUp, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand, startLevelTimer: hooks.startLevelTimer, startTableTimer: hooks.startTableTimer, broadcastRoomList: hooks.broadcastRoomList }
    });

    return {
        ...pokerRules,
        ...potService,
        ...statePresenter,
        ...straddleService,
        ...runItService,
        ...showdownService,
        ...handHistoryService,
        ...handService
    };
}

module.exports = { createPokerService };
