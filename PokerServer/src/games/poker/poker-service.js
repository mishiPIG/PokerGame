'use strict';

const { createPokerRules } = require('./poker-rules');
const { createPotService } = require('./pot-service');
const { createStatePresenter } = require('./state-presenter');
const { createStraddleService } = require('./extensions/straddle/straddle-service');
const { createRunItService } = require('./extensions/run-it/run-it-service');
const { createSquidService } = require('./extensions/squid/squid-service');
const { createShowdownService } = require('./showdown-service');
const { createHandHistoryService } = require('./hand-history-service');
const { createHandService } = require('./hand-service');

// Poker hand orchestration only. Match and room policies are supplied as hooks so
// the existing public table-service API can remain unchanged during this refactor.
function createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime, hooks }) {
    const { PHASES, gameSB, gameBB, gameAnte, ACTION_TIME, EXTRA_MAX, STRADDLE_DECISION_MS } = config;
    const { roomGames } = runtime;
    const pokerRules = createPokerRules();
    const handHistoryService = createHandHistoryService({ db });
    const potService = createPotService({ io, roomGames, gameBB });
    // Squid game extension: created early so its publicState can be used by statePresenter (§7.6)
    const squidService = createSquidService({
        io, roomGames, db, config,
        hooks: {
            broadcastState: (...args) => statePresenter.broadcastState(...args),
            scheduleNextHand: hooks.scheduleNextHand,
            endCashTable: hooks.endCashTable,
            saveHandHistory: handHistoryService.saveHandHistory
        }
    });

    const statePresenter = createStatePresenter({ io, db, roomGames, PHASES, gameSB, gameBB, gameAnte, ACTION_TIME, EXTRA_MAX, livePots: potService.livePots, HandEvaluator, squidPublicState: squidService.publicState });
    const straddleService = createStraddleService({ io, roomGames, PHASES, gameBB, gameAnte, STRADDLE_DECISION_MS });

    const runItService = createRunItService({
        io, roomGames, HandEvaluator, equity, config, activePlayers: pokerRules.activePlayers,
        hooks: { broadcastState: statePresenter.broadcastState, saveHandHistory: handHistoryService.saveHandHistory, applyPendingLevelUp: hooks.applyPendingLevelUp, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand, advanceStage: (...args) => handService.advanceStage(...args) },
        squid: squidService
    });
    const showdownService = createShowdownService({
        io, roomGames, HandEvaluator, activePlayers: pokerRules.activePlayers,
        buildSidePots: potService.buildSidePots, returnUncalledBets: potService.returnUncalledBets,
        hooks: { saveHandHistory: handHistoryService.saveHandHistory, applyPendingLevelUp: hooks.applyPendingLevelUp, broadcastState: statePresenter.broadcastState, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand },
        squid: squidService
    });
    const handService = createHandService({
        io, roomGames, Deck, HandEvaluator, equity, config, rules: pokerRules, pots: potService,
        presenter: statePresenter, straddle: straddleService, runIt: runItService,
        showdown: showdownService, history: handHistoryService,
        squid: squidService,
        hooks: { applyPendingLevelUp: hooks.applyPendingLevelUp, maybeEndSNG: hooks.maybeEndSNG, scheduleNextHand: hooks.scheduleNextHand, startLevelTimer: hooks.startLevelTimer, startTableTimer: hooks.startTableTimer, broadcastRoomList: hooks.broadcastRoomList }
    });

    return {
        ...pokerRules,
        ...potService,
        ...statePresenter,
        ...straddleService,
        ...runItService,
        ...squidService,
        ...showdownService,
        ...handHistoryService,
        ...handService
    };
}

module.exports = { createPokerService };
