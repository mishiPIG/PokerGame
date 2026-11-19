'use strict';
// 奥马哈（PLO，2026-11-19）：每人 4 张底牌，【必须正好用 2 张底牌 + 3 张公共牌】，底池限注。牌型大小和德州一样。
//
// 🔴 最容易错的就是「2 + 3」：德州的 7 选 5 会让「手里四张同花」直接算同花、「公共牌四张同花 + 手里一张」也算同花，
//    在奥马哈里这两种都不成立。所以评估一律走这里，不许绕过去用 HandEvaluator 的 7 张评估（variants.test.js 守着）。
//
// 评估：底牌 6 种两张组合 × 公共牌 C(n,3) 种三张组合（河牌时 10 种）= 最多 60 次 5 张评估，取最小。
// 5 张评估直接复用 Cactus Kev，不用新查表；分数含义和德州完全一样（1 最强 … 7462 最弱）。
const { HandEvaluator } = require('../../../../PokerLogic');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const HOLE_PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

function triples(n) {
    const out = [];
    for (let a = 0; a < n - 2; a++) for (let b = a + 1; b < n - 1; b++) for (let c = b + 1; c < n; c++) out.push([a, b, c]);
    return out;
}
const TRIPLES = { 3: triples(3), 4: triples(4), 5: triples(5) };

// 返回 { score, boardIdx, holeIdx }（公共牌少于 3 张返回 null）
function bestOmaha(board, hole) {
    const tri = TRIPLES[board.length];
    if (!tri || !hole || hole.length < 4) return null;
    let best = Infinity, bi = null, hi = null;
    for (const [x, y] of HOLE_PAIRS) {
        for (const [a, b, c] of tri) {
            const s = HandEvaluator.evaluate5Cards([hole[x], hole[y], board[a], board[b], board[c]]);
            if (s < best) { best = s; hi = [x, y]; bi = [a, b, c]; }
        }
    }
    return { score: best, boardIdx: bi, holeIdx: hi };
}

module.exports = {
    id: 'plo',
    holeCount: 4,
    ranks: RANKS,
    betLimit: 'pl',
    mcSamples: 2000,   // 翻前全押胜率的蒙特卡洛次数：每次评估是德州的 ~3 倍（60 vs 21），8000 次会拖住事件循环
    evalCost: 60,          // 每人每个牌面要比几种组合（C(4,2)×C(5,3)）
    exactBudget: 1200000,  // 精确穷举最多做这么多次评估（约 0.1 秒），超了改蒙特卡洛 —— 见 equity.js 的 withinBudget
    score(board, hole) { return bestOmaha(board, hole).score; },
    best(board, hole) { const b = bestOmaha(board, hole); return { ...b, category: HandEvaluator.handCategory(b.score) }; },
    bestPartial(board, hole) { const b = bestOmaha(board, hole); return b ? { ...b, category: HandEvaluator.handCategory(b.score) } : null; },
    category(score) { return HandEvaluator.handCategory(score); },
};
