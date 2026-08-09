'use strict';
const { nameOf } = require('../../account/display-name');

function createShowdownService({ io, roomGames, HandEvaluator, activePlayers, buildSidePots, returnUncalledBets, hooks }) {
    const { saveHandHistory, commitHandHistory, applyPendingLevelUp, broadcastState, maybeEndSNG, scheduleNextHand } = hooks;
function doShowdown(roomId) {
    const game = roomGames[roomId];
    returnUncalledBets(roomId);   // 摊牌前退还未被跟到的多余下注（幂等；已在 all-in 亮牌时退过则不动）
    const active = activePlayers(game);
    io.in(roomId).emit('server_msg', `\n--- 🃏 Showdown ---`);

    // 每位仍在局玩家的 7 张牌得分
    const scoreOf = {};
    active.forEach(p => {
        scoreOf[p.userId] = HandEvaluator.evaluate7Cards(game.communityCards.concat(game.holeCards[p.userId]));
    });

    // 广播所有手牌
    const reveals = {};
    active.forEach(p => {
        reveals[p.userId] = game.holeCards[p.userId].map(c => ({ suit: c.suit, rank: c.rank }));
    });

    // 真边池：逐池在「有资格的玩家」中取最强手分配；平局均分，余数给第一位
    const pots = buildSidePots(game);
    const winShare = {};   // userId -> 赢得总额
    const potResults = []; // 逐池结果（主池在前，边池在后），供客户端依次飞币动画
    pots.forEach((pot, idx) => {
        if (!pot.eligible.length) return;
        const best = Math.min(...pot.eligible.map(p => scoreOf[p.userId]));
        const winners = pot.eligible.filter(p => scoreOf[p.userId] === best);
        const split = Math.floor(pot.amount / winners.length);
        const rem = pot.amount - split * winners.length;
        winners.forEach((w, i) => {
            const amt = split + (i === 0 ? rem : 0);
            w.chips += amt;
            winShare[w.userId] = (winShare[w.userId] || 0) + amt;
        });
        potResults.push({
            amount: pot.amount, main: idx === 0,
            label: idx === 0 ? '主池' : `边池${idx}`,
            winners: winners.map(w => ({ userId: w.userId, amount: split + 0 }))
        });
    });

    // 每个赢家各自的最强 5 张（分池/平分时两位赢家都要高亮各自的牌，不能只亮一个）
    const winnerIds = Object.keys(winShare);
    const overallId = winnerIds.sort((a, b) => winShare[b] - winShare[a])[0];
    const bestByWinner = {};
    winnerIds.forEach(id => {
        if (!game.holeCards[id]) return;
        const wb = HandEvaluator.bestHand(game.communityCards.concat(game.holeCards[id]));
        bestByWinner[id] = {
            community: wb.indices.filter(i => i < 5),
            hole: wb.indices.filter(i => i >= 5).map(i => i - 5),
            category: wb.category
        };
    });
    const ob = bestByWinner[overallId] || { community: [], hole: [], category: '' };
    io.in(roomId).emit('showdown_reveal', {
        reveals, winners: winnerIds, winnerId: overallId,
        bestCommunity: ob.community, bestHole: ob.hole, category: ob.category,
        bestByWinner, pots: potResults
    });
    const label = winnerIds.map(id => {
        const p = game.players.find(x => x.userId === id);
        return `${p ? nameOf(p) : id} +${winShare[id]}`;
    }).join('，');
    io.in(roomId).emit('server_msg', `🏆 ${label}（边池数 ${pots.length}）`);

    const completedHand = saveHandHistory(game, winShare);
    game.pot = 0;
    game.players.forEach(p => p.committed = 0);
    game.actionOnIdx = -1;
    applyPendingLevelUp(roomId);
    commitHandHistory(roomId, completedHand);
    broadcastState(roomId);
    io.in(roomId).emit('sfx', 'win');
    maybeEndSNG(roomId);
    if (!game.tournamentOver) scheduleNextHand(roomId);
}


    return { doShowdown };
}

module.exports = { createShowdownService };
