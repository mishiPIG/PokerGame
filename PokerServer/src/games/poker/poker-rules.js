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
    return canAct(p) && !(p.hasActed && p.currentBet >= game.currentBet);
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
    // 只剩一个人能行动、而且他的下注已经不少于其余任何人（其余都全押了）→ 没有人可以再跟他比，这一街结束。
    // 不必等他点一次毫无意义的过牌；多出来没人能跟的部分在亮牌时退还。
    if (canStill.length === 1) {
        const me = canStill[0];
        const maxOther = Math.max(0, ...active.filter(p => p !== me).map(p => p.currentBet || 0));
        if ((me.currentBet || 0) >= maxOther) return true;
    }
    // 用 >= 而不是 ===：下注高于桌面当前注的人同样「不欠注」。
    // 写成 === 的话，一旦哪条路径让某人的下注超过了 currentBet，这一街就永远结束不了。
    return canStill.every(p => p.hasActed && p.currentBet >= game.currentBet);
}


    return { activePlayers, canAct, needsToAct, findNextActionIdx, isBettingRoundComplete };
}

module.exports = { createPokerRules };
