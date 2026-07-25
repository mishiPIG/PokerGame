'use strict';

function createPokerRules() {
function activePlayers(game) {
    return game.players.filter(p => !p.folded);
}

function canAct(p) {
    return !p.folded && !p.allIn;
}

// 某玩家本街是否还需要行动：能行动(未弃牌未全押) 且 (还没行动过 或 面对更高的注还没跟平)
function needsToAct(p, game) {
    return canAct(p) && !(p.hasActed && p.currentBet === game.currentBet);
}
function findNextActionIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (needsToAct(game.players[idx], game)) return idx;   // 跳过已行动且已跟平者，避免又轮到他
    }
    return -1;
}

function isBettingRoundComplete(game) {
    const active = activePlayers(game);
    if (active.length <= 1) return true;
    const canStill = active.filter(canAct);
    if (canStill.length === 0) return true;
    return canStill.every(p => p.hasActed && p.currentBet === game.currentBet);
}


    return { activePlayers, canAct, needsToAct, findNextActionIdx, isBettingRoundComplete };
}

module.exports = { createPokerRules };
