'use strict';

function createHandHistoryService({ db }) {
function recordAction(game, player, action, amount) {
    if (!game.hand) return;
    game.hand.actions.push({
        userId: player.userId, street: game.phase, action,
        amount: amount || 0,
        thinkMs: game.actionStartedAt ? Date.now() - game.actionStartedAt : 0
    });
}

// 一手结束落库牌谱（含公共牌与各家结果）
function saveHandHistory(game, winShare) {
    if (!game.hand) return;
    game.hand.community = game.communityCards.map(c => `${c.rank}${c.suit[0]}`);
    game.hand.results = game.hand.seats.map(s => ({
        userId: s.userId,
        won: (winShare && winShare[s.userId]) || 0,
        endChips: (game.players.find(p => p.userId === s.userId) || {}).chips ?? 0
    }));
    db.appendHand(game.hand);
    game.hand = null;
}

// ===== 房间 / 大厅 =====


    return { recordAction, saveHandHistory };
}

module.exports = { createHandHistoryService };
