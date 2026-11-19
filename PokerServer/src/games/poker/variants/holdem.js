'use strict';
// 德州（无限注）—— 「玩法」的默认那一种。
// 🔴 这里只做【搬家】：每个函数都是原来调用方那一行的原样包装，一个字的规则都不改。
//    golden/holdem-golden.test.js 钉着德州的全部行为，改了这里任何一点它都会报出来。
const { HandEvaluator } = require('../../../../PokerLogic');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

// 把「公共牌 + 底牌」拼起来评估后返回的下标，拆回「用到了哪几张公共牌 / 哪几张底牌」
function splitIdx(indices, boardLen) {
    return { boardIdx: indices.filter(i => i < boardLen), holeIdx: indices.filter(i => i >= boardLen).map(i => i - boardLen) };
}

module.exports = {
    id: 'nlhe',
    holeCount: 2,
    ranks: RANKS,          // 牌堆的点数（Deck.reset 按「花色在外、点数在内」建牌，这个顺序就是可验证公平的重算起点）
    betLimit: 'nl',        // 无限注
    // 一手牌的分数（越小越强）。原来各处写的都是 evaluate7Cards(公共牌.concat(底牌))
    score(board, hole) { return HandEvaluator.evaluate7Cards(board.concat(hole)); },
    // 最强组合（公共牌 5 张时用：摊牌高亮、每家牌型）。原来是 bestHand(公共牌.concat(底牌))
    best(board, hole) {
        const b = HandEvaluator.bestHand(board.concat(hole));
        return { score: b.score, category: b.category, ...splitIdx(b.indices, board.length) };
    },
    // 公共牌还没发完时（3–5 张）的当前最强组合：牌型提示、牌谱里的牌型名。原来是 bestHandFrom(公共牌.concat(底牌))
    bestPartial(board, hole) {
        const b = HandEvaluator.bestHandFrom(board.concat(hole));
        return b ? { score: b.score, category: b.category, ...splitIdx(b.indices, board.length) } : null;
    },
    category(score) { return HandEvaluator.handCategory(score); },
};
