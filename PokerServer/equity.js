// 全押胜率（equity）：剩余公共牌少则精确穷举、翻前多则蒙特卡洛
// 结果同分算平局均分。用现成的 HandEvaluator（分越小越强）
const { HandEvaluator } = require('./PokerLogic');

const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const keyOf = c => c.rank + c.suit[0];

function fullDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
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

// holes: { userId: [card,card] }（未弃牌者）；community: [card...]
function computeEquity(holes, community) {
    const ids = Object.keys(holes).filter(id => holes[id] && holes[id].length === 2);
    if (ids.length < 2) return {};
    const known = new Set();
    community.forEach(c => known.add(keyOf(c)));
    ids.forEach(id => holes[id].forEach(c => known.add(keyOf(c))));
    const remaining = fullDeck().filter(c => !known.has(keyOf(c)));
    const need = 5 - community.length;

    const win = {}; ids.forEach(id => win[id] = 0);
    let total = 0;
    const evalBoard = (board) => {
        let best = Infinity, winners = [];
        for (const id of ids) {
            const score = HandEvaluator.evaluate7Cards(board.concat(holes[id]));
            if (score < best) { best = score; winners = [id]; }
            else if (score === best) winners.push(id);
        }
        const share = 1 / winners.length;
        winners.forEach(id => win[id] += share);
        total++;
    };

    if (need <= 0) evalBoard(community);
    else if (nCk(remaining.length, need) <= 20000) enumerate(remaining, need, picks => evalBoard(community.concat(picks)));
    else { const N = 8000; for (let i = 0; i < N; i++) evalBoard(community.concat(sample(remaining, need))); }

    const out = {};
    ids.forEach(id => out[id] = total ? Math.round((win[id] / total) * 1000) / 10 : 0);
    return out;
}

module.exports = { computeEquity };
