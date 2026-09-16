'use strict';
const { newServerSeed, commitOf } = require('./provably-fair');

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

    // 可验证公平：牌局结束了，现在才能揭示种子。
    // 🔴 时机就是全部 —— 提前一秒揭示，整副牌就提前告诉了所有人。
    if (game.fair && game.fair.serverSeed) {
        game.hand.fair = {
            commit: game.fair.commit,
            serverSeed: game.fair.serverSeed,
            clientSeed: game.fair.clientSeed,
            nonce: game.fair.nonce,
            deckOrder: game.fair.deckOrder,
        };
        // 揭示过的种子就作废了：立刻换一个新的，并把新承诺放进房间状态。
        // 这步让下一手的 commit 【在发牌之前就已经公布】，
        // 也就是说玩家能在看到承诺之后再改 clientSeed ——
        // 服务器因此没办法【碾种子】挑一个对自己有利的出来。
        game.fair.lastReveal = { ...game.hand.fair };
        const nextSeed = newServerSeed();
        game.fair.serverSeed = nextSeed;
        game.fair.commit = commitOf(nextSeed);
        game.fair.deckOrder = null;
        // nonce 也要往前走一格。不走的话，牌局结束后广播里会出现
        // 【fair.nonce 和 lastReveal.nonce 相等】—— 看上去就像「当前这手的种子已经被揭示了」。
        // 实际没有泄露（commit 已经是新种子的），但这个广播本身是误导的：
        // 玩家（和自动检测）分不清这个 commit 到底对应哪一手。
        // —— 这是端到端测试里报出来的。
        game.fair.nonce = (Number(game.fair.nonce) || 0) + 1;
    }
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
