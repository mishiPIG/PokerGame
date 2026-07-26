'use strict';

function createHandHistoryService({ db, persistence, roomGames }) {
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
    game.hand.results = game.hand.seats.map(s => ({
        userId: s.userId,
        won: (winShare && winShare[s.userId]) || 0,
        endChips: (game.players.find(p => p.userId === s.userId) || {}).chips ?? 0
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
