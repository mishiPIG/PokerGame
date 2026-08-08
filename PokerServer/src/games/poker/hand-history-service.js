'use strict';

function createHandHistoryService({ db, persistence, roomGames, HandEvaluator }) {
function recordAction(game, player, action, amount) {
    if (!game.hand) return;
    game.hand.actions.push({
        userId: player.userId, street: game.phase, action,
        amount: amount || 0,
        thinkMs: game.actionStartedAt ? Date.now() - game.actionStartedAt : 0
    });
}

// 构建已完成牌谱；调用方完成 pot/phase 等收尾后，再通过 commitHandHistory
// 与比赛快照放入同一个 SQLite 事务。
function saveHandHistory(game, winShare) {
    if (!game.hand) return null;
    game.hand.community = game.communityCards.map(c => `${c.rank}${c.suit[0]}`);
    // 顺便算出每家的最终牌型名存进牌谱（牌谱详情要显示「谁是什么牌」）。
    // 放在服务端算：牌力评估逻辑只此一份，客户端不必再实现一遍；且历史牌谱自带该字段，事后可查。
    // 只有公共牌 ≥3 张（能构成 5 张）才有意义；弃牌者也算——玩家想知道「我弃掉的会是什么」。
    const catOf = (userId) => {
        try {
            const hole = game.holeCards[userId];
            if (!hole || game.communityCards.length < 3 || !HandEvaluator) return null;
            const bh = HandEvaluator.bestHandFrom(game.communityCards.concat(hole));
            return bh ? bh.category : null;
        } catch (e) { return null; }   // 牌型只是展示信息，算不出也不能影响牌谱落库
    };
    game.hand.results = game.hand.seats.map(s => ({
        userId: s.userId,
        won: (winShare && winShare[s.userId]) || 0,
        endChips: (game.players.find(p => p.userId === s.userId) || {}).chips ?? 0,
        category: catOf(s.userId),
        folded: !!(game.players.find(p => p.userId === s.userId) || {}).folded
    }));
    game.hand.completedAt = Date.now();
    game.hand.matchId = game.matchId;
    const completed = game.hand;
    game.hand = null;
    return completed;
}

function commitHandHistory(roomId, completedHand) {
    if (!completedHand) return;
    const game = roomGames[roomId];
    if (!game) return;
    try {
        db.raw.transaction(() => {
            db.appendHand(completedHand);
            persistence.commit(roomId, 'hand_settled', null, { handSeq: completedHand.handSeq });
        })();
    } catch (error) {
        game.hand = completedHand;
        db.matches.markRecoveryNeeded(game.matchId, error);
        throw error;
    }
}

// ===== 房间 / 大厅 =====


    return { recordAction, saveHandHistory, commitHandHistory };
}

module.exports = { createHandHistoryService };
