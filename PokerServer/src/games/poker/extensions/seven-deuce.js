'use strict';
// 7-2 奖励（2026-11-18，家庭局玩法）。现金桌房主开关，默认关。
//
// 规则（定死、写清楚，免得打完了吵）：
//   · 手里是 7 和 2（同花不同花都算）
//   · 这一手【只有他一个人赢到筹码】—— 别人都弃牌、或摊牌他一个人赢。平分底池、
//     多次发牌各赢一份、边池被别人赢走，都不算（「这把是不是他赢的」说不清的一律不给）
//   · 这一手发到牌的其余每个人，各付他「奖励额」，付不起就付到 0 为止
//   · 奖励额 = 开手那一刻房主设的倍数 × 这一手的大盲（中途改设置只影响下一手）
//   · 拿奖励要亮牌：没摊牌就赢的，系统替他把这两张牌亮给全桌
//
// 🔴 只在 saveHandHistory 里调用一次：所有收尾路径（弃牌赢、摊牌、多次发牌、全员离桌退还）都汇到那里，
//    而且那时底池已经分完、牌谱的结束筹码还没取 —— 在这里转账，牌谱里每个人的结束筹码就已经含奖励，
//    单手筹码守恒（Σ结束 = Σ开始）照样成立，审计不会误报。
//    钱只在【这一手发到牌的人】之间转，所以守恒是结构上保证的。
const ALLOWED_BB = [0, 1, 2, 5];

function isSevenDeuce(hole) {
    if (!hole || hole.length !== 2) return false;
    const r = hole.map(c => c && c.rank).sort().join('');
    return r === '27';
}

// 开手时调用：把这一手的奖励额定下来（记进牌谱，结算时只认这个）
function bountyForHand(game, bb) {
    const k = game && game.roomType === 'cash' && game.config ? Number(game.config.sevenDeuceBB) || 0 : 0;
    return ALLOWED_BB.includes(k) && k > 0 ? k * bb : 0;
}

// 结算时调用。返回发生的转账（没有就 null）；会直接改 players 上的 chips。
function settleSevenDeuce(game, winShare) {
    const hand = game && game.hand;
    const bounty = hand ? Number(hand.sevenDeuceBounty) || 0 : 0;
    if (!bounty) return null;
    const winners = Object.keys(winShare || {}).filter(id => winShare[id] > 0);
    if (winners.length !== 1) return null;
    const winnerId = winners[0];
    const hole = game.holeCards && game.holeCards[winnerId];
    if (!isSevenDeuce(hole)) return null;
    const winner = (game.players || []).find(p => p.userId === winnerId);
    if (!winner) return null;
    const payers = [];
    let total = 0;
    for (const s of hand.seats || []) {
        if (s.userId === winnerId) continue;
        const p = game.players.find(x => x.userId === s.userId);
        if (!p) continue;
        const paid = Math.min(bounty, Math.max(0, p.chips || 0));
        if (paid <= 0) continue;
        p.chips -= paid;
        total += paid;
        payers.push({ userId: s.userId, paid });
    }
    if (!total) return null;
    winner.chips += total;
    return { userId: winnerId, bounty, total, payers, cards: hole.map(c => `${c.rank}${c.suit[0]}`) };
}

module.exports = { ALLOWED_BB, isSevenDeuce, bountyForHand, settleSevenDeuce };
