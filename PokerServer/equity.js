// 全押胜率（equity）：剩余公共牌少则精确穷举、翻前多则蒙特卡洛
// 结果同分算平局均分。用现成的 HandEvaluator（分越小越强）
const { HandEvaluator } = require('./PokerLogic');

const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const keyOf = c => c.rank + c.suit[0];

function fullDeck(ranks = RANKS) {
    const d = [];
    for (const s of SUITS) for (const r of ranks) d.push({ suit: s, rank: r });
    return d;
}

// 枚举 remaining 中取 k 张的所有组合，对每个组合调 cb(picks)
function enumerate(remaining, k, cb) {
    const n = remaining.length, idx = [];
    (function rec(start, depth) {
        if (depth === k) { cb(idx.map(i => remaining[i])); return; }
        for (let i = start; i <= n - (k - depth); i++) { idx[depth] = i; rec(i + 1, depth + 1); }
    })(0, 0);
}
function sample(remaining, k) {   // 随机取 k 张（洗牌前 k 个）
    const a = remaining.slice();
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(Math.random() * (a.length - i));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.slice(0, k);
}
function nCk(n, k) { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); }

// 精确穷举的总工作量上限（只对声明了 exactBudget 的玩法生效；德州 / 短牌不声明，行为和原来一模一样）。
// 原来只看「有几种牌面」（≤ 20000 就穷举），没算「每种牌面要评估几次」：奥马哈每人每个牌面要比 60 种组合，
// 8 人翻前全押时牌面只有 C(20,5)=15504 种，却要做 15504 × 8 × 60 ≈ 740 万次评估 ——
// 同步跑完要 0.6 秒，期间整个服务器（所有牌桌）都卡住（2026-11-19 奥马哈测试实测）。超了就改用蒙特卡洛。
function withinBudget(variant, boards, players) {
    if (!variant || !variant.exactBudget) return true;
    return boards * players * (variant.evalCost || 1) <= variant.exactBudget;
}

// holes: { userId: [底牌...] }（未弃牌者）；community: [card...]
// variant（可选）：玩法层对象（底牌张数、牌堆点数、怎么评估）。不传 = 德州，行为与原来完全一致。
function computeEquity(holes, community, variant = null) {
    const holeCount = variant ? variant.holeCount : 2;
    const ids = Object.keys(holes).filter(id => holes[id] && holes[id].length === holeCount);
    if (ids.length < 2) return {};
    const known = new Set();
    community.forEach(c => known.add(keyOf(c)));
    ids.forEach(id => holes[id].forEach(c => known.add(keyOf(c))));
    const remaining = fullDeck(variant ? variant.ranks : RANKS).filter(c => !known.has(keyOf(c)));
    const need = 5 - community.length;

    const win = {}; ids.forEach(id => win[id] = 0);
    let total = 0;
    const evalBoard = (board) => {
        let best = Infinity, winners = [];
        for (const id of ids) {
            const score = variant ? variant.score(board, holes[id]) : HandEvaluator.evaluate7Cards(board.concat(holes[id]));
            if (score < best) { best = score; winners = [id]; }
            else if (score === best) winners.push(id);
        }
        const share = 1 / winners.length;
        winners.forEach(id => win[id] += share);
        total++;
    };

    if (need <= 0) evalBoard(community);
    else if (nCk(remaining.length, need) <= 20000 && withinBudget(variant, nCk(remaining.length, need), ids.length)) enumerate(remaining, need, picks => evalBoard(community.concat(picks)));
    else { const N = (variant && variant.mcSamples) || 8000; for (let i = 0; i < N; i++) evalBoard(community.concat(sample(remaining, need))); }

    const out = {};
    ids.forEach(id => out[id] = total ? Math.round((win[id] / total) * 1000) / 10 : 0);
    return out;
}

module.exports = { computeEquity, withinBudget };
