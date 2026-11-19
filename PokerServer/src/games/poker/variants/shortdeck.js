'use strict';
// 短牌（6+ Hold'em，2026-11-19）：去掉 2–5 的 36 张牌，其余和德州一样（2 张底牌、7 选 5、无限注、大小盲）。
//
// 牌型大小 —— 以赛事 / 平台官方规则为准（用户 2026-11-19 定，查证见 docs/feat/game-variants/PLAN.md §8.2）：
//   同花顺 > 四条 > 同花 > 葫芦 > 顺子 > 三条 > 两对 > 一对 > 高牌
//   · 同花 > 葫芦：每种花色只剩 9 张，同花比葫芦难成（各家官方规则一致）
//   · 顺子 > 三条：Triton 官网、PokerStars 6+ 官方规则、GGPoker 帮助中心都是这样（只有少数房间用三条 > 顺子）
//     （最早按「概率小的大」定成三条 > 顺子，2026-11-19 查证官方规则后改掉）
//   · A-6-7-8-9 是顺子（最小的顺子），同花时是最小的同花顺
//
// 做法：复用德州的 Cactus Kev 5 张评估，在它上面【重新排档】——
//   分数 = 档位 × 10000 + 档内名次（档内名次直接沿用 Kev 的先后，越小越强），所以「分数越小越强」这条不变，
//   比较大小的代码（摊牌、边池、多次发牌）一个字都不用改。
const { HandEvaluator } = require('../../../../PokerLogic');

const RANKS = ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_BIT = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
const A6789 = (1 << 12) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7);

// Kev 分段：[本档最小分, 本档最大分, 档名]
const KEV = [[1, 10, 'sf'], [11, 166, 'quads'], [167, 322, 'fh'], [323, 1599, 'flush'], [1600, 1609, 'straight'],
    [1610, 2467, 'trips'], [2468, 3325, 'twopair'], [3326, 6185, 'pair'], [6186, 7462, 'high']];
// 短牌的档位顺序（越前越强）
const ORDER = ['sf', 'quads', 'flush', 'fh', 'straight', 'trips', 'twopair', 'pair', 'high'];
const NAME = { sf: '同花顺', quads: '四条', flush: '同花', fh: '葫芦', trips: '三条', straight: '顺子', twopair: '两对', pair: '一对', high: '高牌' };
const STEP = 10000;

function score5(five) {
    const mask = five.reduce((m, c) => m | (1 << RANK_BIT[c.rank]), 0);
    if (mask === A6789) {
        // Kev 不认这一手是顺子（它的位图不连续）。德州里 T9876 是第 5 名同花顺 / 第 1605 分顺子，
        // A-6-7-8-9 紧排在 T9876 后面（短牌里没有 98765 和更小的顺子）。
        const flush = five.every(c => c.suit === five[0].suit);
        return flush ? ORDER.indexOf('sf') * STEP + 5 : ORDER.indexOf('straight') * STEP + 6;
    }
    const kev = HandEvaluator.evaluate5Cards(five);
    const band = KEV.find(b => kev <= b[1]);
    return ORDER.indexOf(band[2]) * STEP + (kev - band[0]);
}

function category(score) {
    const tier = ORDER[Math.floor(score / STEP)];
    if (tier === 'sf' && score % STEP === 0) return '皇家同花顺';
    return NAME[tier];
}

// 从若干张牌里取最强 5 张（5–7 张）：返回 { score, indices }
function bestOf(cards) {
    const n = cards.length;
    if (n < 5) return null;
    let best = Infinity, idx = null;
    for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
            const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (s < best) { best = s; idx = [a, b, c, d, e]; }
        }
    return { score: best, indices: idx };
}
function split(b, boardLen) {
    return { score: b.score, category: category(b.score), boardIdx: b.indices.filter(i => i < boardLen), holeIdx: b.indices.filter(i => i >= boardLen).map(i => i - boardLen) };
}

module.exports = {
    id: 'shortdeck',
    holeCount: 2,
    ranks: RANKS,
    betLimit: 'nl',
    // 全押胜率的算力上限（见 equity.js 的 withinBudget）：短牌每次评估要在 7 张里比 21 种 5 张组合，比德州的查表慢；
    // 8 人翻前全押原来要穷举 15504 种牌面 ≈ 0.4 秒，整个服务器跟着卡住（2026-11-19 实测）。超了改蒙特卡洛 4000 次
    evalCost: 21,
    exactBudget: 600000,
    mcSamples: 4000,
    score(board, hole) { return bestOf(board.concat(hole)).score; },
    best(board, hole) { return split(bestOf(board.concat(hole)), board.length); },
    bestPartial(board, hole) { const b = bestOf(board.concat(hole)); return b ? split(b, board.length) : null; },
    category,
    _score5: score5,   // 测试用
};
