'use strict';
// 判牌算法交叉核对（2026-11-19，用户要求「短牌和奥马哈的判大小算法要核对」）。
//
// 正式实现：德州 = Cactus Kev 查表；短牌 = Kev 5 张评估 + 重新排档；奥马哈 = 2+3 组合 × Kev 5 张评估。
// 这里另写一份【完全独立】的笨办法判牌器：不查表、不用 PokerLogic，直接数点数 / 花色，按「牌型档位 + 踢脚」逐个比。
// 两份写法毫无共同代码，随机发几万局、逐一比较每两家谁大，结论必须完全一致（含平局）；牌型名也必须一致。
//
// 规则来源（2026-11-19 查证，见 docs/feat/game-variants/PLAN.md §8.2）：
//   · 短牌：36 张（去掉 2–5）；同花 > 葫芦；A-6-7-8-9 是最小的顺子（没有 A-2-3-4-5）；
//     顺子 > 三条（Triton 官网 / PokerStars 6+ 官方规则 / GGPoker 帮助中心 / pokerkit / Wikipedia 一致，2026-11-19 用户定以官方为准）
//   · 奥马哈：必须正好 2 张底牌 + 3 张公共牌；牌型大小和德州一样
const test = require('node:test');
const assert = require('node:assert/strict');
const { variantById } = require('./src/games/poker/variants');

const V = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const ALL = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SD_RANKS = ['6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// 短牌当前的规则（和 src/games/poker/variants/shortdeck.js 的 ORDER 一致）：顺子 > 三条
const TRIPS_OVER_STRAIGHT = false;

// ── 笨办法：一手 5 张牌 → [档位, 踢脚…]（数组按字典序比，越大越强）──
// 档位：0 高牌 1 一对 2 两对 3 三条 4 顺子 5 同花 6 葫芦 7 四条 8 同花顺（德州）；短牌在下面换顺序
function naive5(cards, shortdeck) {
    const vals = cards.map(c => V[c.rank]).sort((a, b) => b - a);
    const flush = cards.every(c => c.suit === cards[0].suit);
    const uniq = [...new Set(vals)];
    let straightHigh = 0;
    if (uniq.length === 5) {
        if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
        else if (!shortdeck && uniq.join() === '14,5,4,3,2') straightHigh = 5;        // 德州：A-2-3-4-5
        else if (shortdeck && uniq.join() === '14,9,8,7,6') straightHigh = 9;         // 短牌：A-6-7-8-9（最小，排在 T 高顺子下面）
    }
    const cnt = {};
    vals.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
    const groups = Object.entries(cnt).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const shape = groups.map(g => g[0]).join('');
    const kick = groups.map(g => g[1]);
    let cat;
    if (straightHigh && flush) cat = 'sf';
    else if (shape === '41') cat = 'quads';
    else if (shape === '32') cat = 'fh';
    else if (flush) cat = 'flush';
    else if (straightHigh) cat = 'straight';
    else if (shape === '311') cat = 'trips';
    else if (shape === '221') cat = 'twopair';
    else if (shape === '2111') cat = 'pair';
    else cat = 'high';
    const order = shortdeck
        ? ['high', 'pair', 'twopair', ...(TRIPS_OVER_STRAIGHT ? ['straight', 'trips'] : ['trips', 'straight']), 'fh', 'flush', 'quads', 'sf']
        : ['high', 'pair', 'twopair', 'trips', 'straight', 'flush', 'fh', 'quads', 'sf'];
    const tail = (cat === 'sf' || cat === 'straight') ? [straightHigh] : (cat === 'flush' || cat === 'high') ? vals : kick;
    return { key: [order.indexOf(cat), ...tail], cat, royal: cat === 'sf' && straightHigh === 14 };
}
const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return Math.sign(d); } return 0; };
function bestNaive(fives, shortdeck) {
    let best = null;
    for (const f of fives) { const r = naive5(f, shortdeck); if (!best || cmp(r.key, best.key) > 0) best = r; }
    return best;
}
function combos(arr, k) {
    const out = [];
    (function rec(s, cur) { if (cur.length === k) { out.push(cur.slice()); return; } for (let i = s; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); } })(0, []);
    return out;
}
// 德州 / 短牌：7 张里任选 5；奥马哈：底牌任选 2 × 公共牌任选 3
const fivesHoldem = (board, hole) => combos(board.concat(hole), 5);
const fivesOmaha = (board, hole) => combos(hole, 2).flatMap(h => combos(board, 3).map(b => h.concat(b)));

const NAME = { sf: '同花顺', quads: '四条', fh: '葫芦', flush: '同花', straight: '顺子', trips: '三条', twopair: '两对', pair: '一对', high: '高牌' };
const nameOf = (r) => r.royal ? '皇家同花顺' : NAME[r.cat];

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function deal(rng, ranks, players, holeN) {
    const deck = [];
    for (const s of SUITS) for (const r of ranks) deck.push({ rank: r, suit: s });
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const holes = [];
    for (let p = 0; p < players; p++) holes.push(deck.splice(0, holeN));
    return { holes, board: deck.splice(0, 5) };
}

function crossCheck({ variant, ranks, holeN, fives, shortdeck, deals, seed }) {
    const v = variantById(variant);
    const rng = mulberry32(seed);
    let pairs = 0, ties = 0;
    const bad = [];
    for (let d = 0; d < deals; d++) {
        const players = 2 + (d % 4);
        const { holes, board } = deal(rng, ranks, players, holeN);
        const mine = holes.map(h => v.score(board, h));
        const ref = holes.map(h => bestNaive(fives(board, h), shortdeck));
        holes.forEach((h, i) => {
            const myName = v.best(board, h).category;
            if (myName !== nameOf(ref[i]) && bad.length < 5) bad.push({ why: '牌型名不同', board: board.map(c => c.rank + c.suit[0]), hole: h.map(c => c.rank + c.suit[0]), mine: myName, ref: nameOf(ref[i]) });
        });
        for (let i = 0; i < players; i++) for (let j = i + 1; j < players; j++) {
            pairs++;
            const a = Math.sign(mine[j] - mine[i]);          // 正式实现：分数越小越强 → i 赢时为正
            const b = cmp(ref[i].key, ref[j].key);            // 笨办法：key 越大越强 → i 赢时为正
            if (b === 0) ties++;
            if (a !== b && bad.length < 5) bad.push({ why: '谁大不同', board: board.map(c => c.rank + c.suit[0]), a: holes[i].map(c => c.rank + c.suit[0]), b: holes[j].map(c => c.rank + c.suit[0]), mine: a, ref: b });
        }
    }
    return { pairs, ties, bad };
}

test('🔴 德州：正式实现（Kev 查表）和独立的笨办法，随机 2 万局里每两家谁大、牌型名完全一致', () => {
    const r = crossCheck({ variant: 'nlhe', ranks: ALL, holeN: 2, fives: fivesHoldem, shortdeck: false, deals: 20000, seed: 11 });
    assert.deepEqual(r.bad, [], JSON.stringify(r.bad));
    assert.ok(r.pairs > 50000 && r.ties > 0, `比了 ${r.pairs} 对，其中平局 ${r.ties}`);
});

test('🔴 短牌：正式实现（Kev 重新排档）和独立的笨办法，随机 2 万局里每两家谁大、牌型名完全一致', () => {
    const r = crossCheck({ variant: 'shortdeck', ranks: SD_RANKS, holeN: 2, fives: fivesHoldem, shortdeck: true, deals: 20000, seed: 22 });
    assert.deepEqual(r.bad, [], JSON.stringify(r.bad));
    assert.ok(r.pairs > 50000 && r.ties > 0, `比了 ${r.pairs} 对，其中平局 ${r.ties}`);
});

test('🔴 奥马哈：正式实现（2+3 组合 × Kev）和独立的笨办法，随机 1 万局里每两家谁大、牌型名完全一致', () => {
    const r = crossCheck({ variant: 'plo', ranks: ALL, holeN: 4, fives: fivesOmaha, shortdeck: false, deals: 10000, seed: 33 });
    assert.deepEqual(r.bad, [], JSON.stringify(r.bad));
    assert.ok(r.pairs > 25000, `比了 ${r.pairs} 对`);
});

test('短牌的几个关键结论，笨办法自己也认（证明它不是照抄正式实现的错）', () => {
    const C = (s) => s.split(' ').map(x => ({ rank: x[0], suit: { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' }[x[1]] }));
    const k = (s) => naive5(C(s), true).key;
    assert.equal(naive5(C('As 6h 7d 8c 9h'), true).cat, 'straight', 'A-6-7-8-9 是顺子');
    assert.ok(cmp(k('Ts 9h 8d 7c 6h'), k('As 6h 7d 8c 9h')) > 0, 'A-6-7-8-9 是最小的顺子');
    assert.ok(cmp(k('6s 7s 8s 9s Js'), k('As Ah Ad Kc Ks')) > 0, '同花大于葫芦');
    assert.ok(cmp(k('As 6h 7d 8c 9h'), k('As Ah Ad Kc Qh')) > 0, '最小的顺子大于最大的三条（官方规则）');
    assert.equal(naive5(C('As 2h 3d 4c 5h'), false).cat, 'straight', '德州 A-2-3-4-5 是顺子');
});

test('奥马哈：Wikipedia 上的例子 —— 公共牌 K♠ 9♠ Q♠ Q♥ 5♠、手里 A♠ 2♥ 4♥ 5♣ 不能成同花（只有一张黑桃）', () => {
    const C = (s) => s.split(' ').map(x => ({ rank: x[0], suit: { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' }[x[1]] }));
    const b = variantById('plo').best(C('Ks 9s Qs Qh 5s'), C('As 2h 4h 5c'));
    assert.notEqual(b.category, '同花');
    assert.equal(b.category, '两对', '5♣ 配公共牌的 5♠ 一对，加公共牌一对 Q');
});
