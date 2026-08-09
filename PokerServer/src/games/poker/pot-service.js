'use strict';
const { nameOf } = require('../../account/display-name');

function createPotService({ io, roomGames, gameBB }) {
// 收注：把本街各家下注累加到本手累计投入 committed（真边池在摊牌时按 committed 计算）
function collectBetsToPot(game) {
    game.players.forEach(p => {
        p.committed = (p.committed || 0) + p.currentBet;
        p.currentBet = 0;
        p.hasActed = false;
    });
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    game.currentBet = 0;
    game.lastRaiseSize = gameBB(game);   // 新街最小加注增量重置为大盲
}

// 构建主池 + 边池：返回 [{ amount, eligible:[player,...] }]（按 all-in 档位分层）
function buildSidePots(game) {
    const contribs = game.players
        .filter(p => (p.committed || 0) > 0)
        .map(p => ({ p, amt: p.committed, folded: p.folded }));
    const pots = [];
    let remaining = contribs.filter(c => c.amt > 0);
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0;
        const eligible = [];
        for (const c of remaining) {
            amount += minAmt;
            c.amt -= minAmt;
            if (!c.folded) eligible.push(c.p);
        }
        pots.push({ amount, eligible });
        remaining = remaining.filter(c => c.amt > 0);
    }
    // 合并相邻「有资格赢家完全相同」的档位。弃牌者的盲注 / 半路弃牌零头会在池里切出一个
    // 额外档位边界，但它与相邻档位的赢家范围其实一样 → 应并成一个池（结算等价，
    // 只是不再显示成一长串「边池1/2/3/4/5」）。
    return mergeAdjacentPots(pots);
}

// 相邻档位若有资格玩家集合完全相同则合并（按 userId 判等）
function samePlayerSet(a, b) {
    return a.length === b.length && a.every(p => b.some(q => q.userId === p.userId));
}
function mergeAdjacentPots(pots) {
    const merged = [];
    for (const pot of pots) {
        const last = merged[merged.length - 1];
        if (last && samePlayerSet(last.eligible, pot.eligible)) last.amount += pot.amount;
        else merged.push(pot);
    }
    return merged;
}

// 退还未被跟到的下注：最高投入者超过「第二高投入」的部分无人能跟 → 退回给他。
// （否则会残留一个只有他自己有资格的「边池」——显示成多余边池；对 run-it 更是会把这笔钱错误地并进均分底池。）
// 须在 collectBetsToPot 之后调用（此时投入都在 committed、currentBet=0）。幂等：无未跟注则不动。
function returnUncalledBets(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const commits = game.players.map(p => p.committed || 0);
    const sorted = commits.slice().sort((a, b) => b - a);
    const top = sorted[0] || 0, second = sorted[1] || 0;
    if (top <= second) return;                       // 最高不唯一或无超出 → 无未跟注
    const topPlayers = game.players.filter(p => (p.committed || 0) === top);
    if (topPlayers.length !== 1) return;             // 并列最高 → 都被跟到，无退还
    const refund = top - second;
    const tp = topPlayers[0];
    tp.chips += refund;
    tp.committed -= refund;
    if (tp.allIn && tp.chips > 0) tp.allIn = false;  // 退回后不再是全押
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    io.in(roomId).emit('server_msg', `↩️ ${nameOf(tp)} 未被跟注，退还 ${refund}`);
}

// 实时分池：仅当「某未弃牌玩家 all-in 且投入 < 其他未弃牌玩家」才分主/边池；
// 否则（只是有人还没跟注/加注）视为单一底池——避免行动未完成时误显边池
function livePots(game) {
    const contribs = game.players
        .map(p => ({ userId: p.userId, amt: (p.committed || 0) + (p.currentBet || 0), folded: p.folded, allIn: !!p.allIn }))
        .filter(c => c.amt > 0);
    if (!contribs.length) return [];
    const maxLive = Math.max(0, ...contribs.filter(c => !c.folded).map(c => c.amt));
    const hasAllInSide = contribs.some(c => !c.folded && c.allIn && c.amt < maxLive);
    if (!hasAllInSide) {
        const total = contribs.reduce((s, c) => s + c.amt, 0);
        return [{ amount: total, eligibleCount: contribs.filter(c => !c.folded).length }];
    }
    // 确有 all-in 边池：按档位分层（记录每层有资格玩家）
    const layers = [];
    let remaining = contribs.slice();
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0; const elig = [];
        for (const c of remaining) { amount += minAmt; c.amt -= minAmt; if (!c.folded) elig.push(c.userId); }
        layers.push({ amount, elig });
        remaining = remaining.filter(c => c.amt > 0);
    }
    // 合并相邻「同资格集合」的层：弃牌者盲注/零头切出的多余边池会被并回，避免显示成一长串边池
    const merged = [];
    for (const L of layers) {
        const last = merged[merged.length - 1];
        if (last && last.elig.length === L.elig.length && L.elig.every(id => last.elig.includes(id))) last.amount += L.amount;
        else merged.push({ amount: L.amount, elig: L.elig.slice() });
    }
    return merged.map(m => ({ amount: m.amount, eligibleCount: m.elig.length }));
}


    return { collectBetsToPot, buildSidePots, samePlayerSet, mergeAdjacentPots, returnUncalledBets, livePots };
}

module.exports = { createPotService };
