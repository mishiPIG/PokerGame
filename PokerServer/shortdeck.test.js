'use strict';
// 短牌（2026-11-19）。牌型大小（按官方规则）：同花顺 > 四条 > 同花 > 葫芦 > 顺子 > 三条 > 两对 > 一对 > 高牌；A-6-7-8-9 是最小的顺子。
// 最硬的一条是穷举：36 张牌全部 376,992 种 5 张组合，每个牌型的个数必须等于手算的组合数 ——
// A-6-7-8-9 漏认、多认、认错档，个数都会对不上。
const test = require('node:test');
const assert = require('node:assert/strict');
const sd = require('./src/games/poker/variants/shortdeck');
const { variantById } = require('./src/games/poker/variants');

const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const S = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
const C = (str) => str.split(' ').map(x => ({ rank: x[0], suit: S[x[1]] }));
const cat = (str) => sd.category(sd._score5(C(str)));

test('🔴 穷举 376,992 手：每个牌型的个数等于手算的组合数', () => {
    const deck = [];
    for (const s of SUITS) for (const r of sd.ranks) deck.push({ rank: r, suit: s });
    assert.equal(deck.length, 36);
    const count = {};
    const n = deck.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
            const k = sd.category(sd._score5([deck[a], deck[b], deck[c], deck[d], deck[e]]));
            count[k] = (count[k] || 0) + 1;
        }
    assert.deepEqual(count, {
        '皇家同花顺': 4,                    // A K Q J T 同花 × 4
        '同花顺': 20,                       // 5 种（KQJT9 … T9876、A6789）× 4 花色
        '四条': 288,                        // 9 × 32
        '同花': 480,                        // C(9,5)×4 − 24 同花顺
        '葫芦': 1728,                       // 9×4 × 8×6
        '三条': 16128,                      // 9×4 × C(8,2)×16
        '顺子': 6120,                       // 6 种 × 4⁵ − 24
        '两对': 36288,                      // C(9,2)×36 × 7×4
        '一对': 193536,                     // 9×6 × C(8,3)×64
        '高牌': 122400,                     // (C(9,5)−6) × (4⁵−4)
    });
});

test('🔴 牌型大小按短牌的顺序：同花 > 葫芦、顺子 > 三条、A-6-7-8-9 是最小的顺子 / 同花顺', () => {
    const s = (x) => sd._score5(C(x));
    // 档与档之间
    const ladder = ['As Ks Qs Js Ts', 'Ks Qs Js Ts 9s', 'As 6s 7s 8s 9s', '7s 7h 7d 7c As', 'As Ks 9s 8s 6s', 'As Ah Ad Kc Ks',
        'As Kh Qd Jc Th', 'Ts 9h 8d 7c 6h', 'As 6h 7d 8c 9h', 'Qs Qh Qd Ac Ks', 'As Ah Ks Kh Qd', 'As Ah Kd Qc Jh', 'As Kh Qd Jc 9h'];
    for (let i = 1; i < ladder.length; i++) assert.ok(s(ladder[i - 1]) < s(ladder[i]), `「${ladder[i - 1]}」应当大于「${ladder[i]}」`);
    assert.equal(cat('As 6h 7d 8c 9h'), '顺子');
    assert.equal(cat('As 6s 7s 8s 9s'), '同花顺');
    assert.equal(cat('As Ks Qs Js Ts'), '皇家同花顺');
    assert.ok(s('As 6s 7s 8s 9s') < s('As Ah Ad Ac Ks'), 'A6789 同花顺仍然大于四条');
    assert.ok(s('As 6h 7d 8c 9h') < s('As Ah Ad Kc Qh'), '最小的顺子（A-6-7-8-9）大于最大的三条');
    assert.ok(s('6s 7s 8s 9s Js') < s('As Ah Ad Kc Ks'), '最小的同花大于最大的葫芦');
});

test('7 张牌：取最强 5 张，下标拆回公共牌 / 底牌', () => {
    const v = variantById('shortdeck');
    const board = C('6h 7d 8c Kd Ks'), hole = C('As 9h');   // 底牌 A + 9 组成 A-6-7-8-9 顺子；公共牌有一对 K
    const b = v.best(board, hole);
    assert.equal(b.category, '顺子', '顺子大于一对');
    assert.deepEqual(b.holeIdx.sort(), [0, 1]);
    assert.deepEqual(b.boardIdx.sort(), [0, 1, 2]);
    // 同一副牌在德州里：A-6-7-8-9 不是顺子，只剩一对 K
    assert.equal(variantById('nlhe').best(board, hole).category, '一对');
    // 公共牌只有 3 张时的牌型提示
    assert.equal(v.bestPartial(C('6h 7d 8c'), C('As 9h')).category, '顺子');
});

test('三条 vs 顺子在 7 张里也按短牌：同时成三条和顺子时取顺子（它更大）', () => {
    const v = variantById('shortdeck');
    const b = v.best(C('9s 9h Tc Jd Qh'), C('9d 8c'));   // 9-9-9 和 8-9-T-J-Q 顺子都成
    assert.equal(b.category, '顺子');
});

// ───────── 真引擎：短牌整手牌 ─────────
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { playTable } = require('./golden/holdem-golden');
function loadVerify() {
    const src = fs.readFileSync(path.join(__dirname, 'tools', 'verify-hand.js'), 'utf8');
    const dir = path.join(__dirname, 'tools');
    const ctx = { require: (m) => require(m.startsWith('.') ? path.join(dir, m) : m), __dirname: dir, __filename: path.join(dir, 'verify-hand.js'), process: { argv: ['node', 'v'], exit() {} }, console, Buffer };
    vm.createContext(ctx);
    vm.runInContext(src.slice(0, src.indexOf('const hand = readInput();')) + '\n;this.verify = verify;', ctx);
    return ctx.verify;
}

test('🔴 真引擎打 80 手短牌：没有 2–5、单手守恒、每手都能离线验算、牌谱标着短牌、牌型按短牌算', () => {
    const six = playTable({ name: 'S', stacks: [3000, 1500, 4000, 800, 2500, 6000], cfg: { variant: 'shortdeck', ante: 5, bombEvery: 5, bombBB: 2 }, hands: 50, seed: 303 });
    const hu = playTable({ name: 'T', stacks: [2000, 3500], cfg: { variant: 'shortdeck' }, hands: 30, seed: 404 });
    const hands = six.concat(hu).map(x => x.hand);
    const verify = loadVerify();
    const v = variantById('shortdeck');
    let showdowns = 0, runIts = 0;
    for (const h of hands) {
        assert.equal(h.variant, 'shortdeck');
        const cards = [...h.seats.flatMap(s => s.hole), ...(h.community || []), ...((h.runIt && h.runIt.boards) || []).flat()];
        assert.ok(cards.every(c => !'2345'.includes(c[0])), `第 ${h.handSeq} 手出现了 2–5：${cards.join(' ')}`);
        assert.equal(h.fair.deckOrder.length, 36, '牌堆 36 张');
        assert.equal(h.results.reduce((a, r) => a + r.endChips, 0), h.seats.reduce((a, s) => a + s.startChips, 0), `第 ${h.handSeq} 手不守恒`);
        const r = verify(h);
        assert.equal(r.ok, true, `第 ${h.handSeq} 手离线验算不过：` + JSON.stringify(r.out.filter(x => !x[1])));
        // 摊牌的牌型名必须是短牌评估器算出来的那个（不是德州的）
        if ((h.community || []).length === 5) {
            showdowns++;
            for (const res of h.results) {
                if (!res.category || res.folded) continue;
                const seat = h.seats.find(s => s.userId === res.userId);
                const parse = (x) => ({ rank: x[0], suit: { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[x[1]] });
                assert.equal(res.category, v.best(h.community.map(parse), seat.hole.map(parse)).category);
            }
        }
        if (h.runIt && h.runIt.n > 1) runIts++;
    }
    assert.ok(showdowns > 10 && hands.some(h => h.bomb), `覆盖面：摊牌 ${showdowns} 手、多次发牌 ${runIts} 手`);
});

test('短牌不能开 7-2 奖励：建房时清零、投票也不收', () => {
    const lobby = fs.readFileSync(path.join(__dirname, 'src/socket/events/lobby-events.js'), 'utf8');
    assert.match(lobby, /sevenDeuceBB: normalizeVariant\(cfg\.variant\) === 'nlhe' &&/);
    const rv = require('./src/rooms/rule-vote');
    const game = { roomType: 'cash', ownerUserId: 'h', config: { variant: 'shortdeck', sevenDeuceBB: 0 }, players: [{ userId: 'h' }, { userId: 'a' }] };
    assert.equal(rv.propose(game, 'h', 'sevenDeuce', { bb: 2 }).reason, 'noSevenDeuce');
});

test('🔴 胜率按短牌算：同花对葫芦，短牌里同花领先、德州里葫芦领先（跑马胜率徽章不能显示反了）', () => {
    const { computeEquity } = require('./equity');
    // 转牌后：flush 已成同花（红心 A K 8 + Q 9）；boat 已成葫芦（8-8-8 带 A-A：公共牌 A 8 8 + 底牌 8 A）
    const board = C('Ah Kh 8h 8c');
    const holes = { flush: C('Qh 9h'), boat: C('8s Ac') };
    const sd = computeEquity(holes, board, variantById('shortdeck'));
    const he = computeEquity(holes, board);
    assert.ok(sd.flush > sd.boat, `短牌：同花应当领先 ${JSON.stringify(sd)}`);
    assert.ok(he.boat > he.flush, `德州：葫芦应当领先 ${JSON.stringify(he)}`);
});

test('高牌定庄也用短牌的牌堆：抽出来的牌没有 2–5', () => {
    const { createPokerService } = require('./src/games/poker/poker-service');
    const { Deck, HandEvaluator } = require('./PokerLogic');
    const config = require('./src/config');
    const equity = require('./equity');
    const roomGames = {}, noop = () => {}, draws = [];
    const sink = { emit(ev, d) { if (ev === 'button_draw') draws.push(...d.draws.map(x => x.card)); } };
    const io = { in: () => sink, to: () => ({ emit() {} }), sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const svc = createPokerService({ io, db: { raw: { transaction: (f) => f }, appendHand: noop, matches: { markRecoveryNeeded: noop } }, equity, Deck, HandEvaluator, config, runtime: { roomGames },
        hooks: { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop }, persistence: { commit: noop } });
    const game = { roomType: 'cash', status: 'waiting', phase: 'waiting', matchId: 'm', config: { sb: 10, bb: 20, ante: 0, maxPlayers: 9, variant: 'shortdeck' }, deck: new Deck(),
        players: Array.from({ length: 9 }, (_, i) => ({ userId: 'u' + i, username: 'p' + i, seat: i, socketId: 's' + i, chips: 2000, buyIn: 2000, currentBet: 0, committed: 0 })),
        holeCards: {}, communityCards: [], pot: 0, currentBet: 0, actionOnIdx: -1 };
    roomGames.R = game;
    for (let k = 0; k < 30; k++) { svc.drawForButton('R'); clearTimeout(game.nextHandTimer); }
    assert.equal(draws.length, 270);
    assert.ok(draws.every(c => !'2345'.includes(c.rank)), '抽到了 2–5：' + draws.filter(c => '2345'.includes(c.rank)).map(c => c.rank + c.suit[0]).join(' '));
});
