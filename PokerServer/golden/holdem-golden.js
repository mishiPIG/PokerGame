'use strict';
// 德州黄金样本（2026-11-18，短牌 / 奥马哈第 0 期）。计划见 docs/feat/game-variants/PLAN.md §3。
//
// 做什么：用【现在的代码】把德州的行为钉成一份标准答案存进 golden/*.json。
// 之后抽「玩法」层、加短牌 / 奥马哈，每改一步都要让 holdem-golden.test.js 一字不差地复现这份答案。
//
// 🔴 规矩：答案一旦对不上，说明德州的行为被改了 —— 停下来查，绝不允许「重新生成一份让测试变绿」。
//    只有在【有意改变德州行为、且用户同意】时才用 --write 重写，并在提交说明里写清改了什么。
//
// 三部分：
//   G1 判牌：固定种子随机 6 万手 7 张牌，每手的分数 / 最强 5 张下标 / 牌型名（evaluate7Cards、bestHand、bestHandFrom）
//   G2 整手牌：固定种子 + 固定行动脚本在真引擎上打 6 人桌 70 手 + 单挑 40 手（全押、边池、多次发牌、链式 straddle、
//      前注、Bomb pot、7-2），行动全部经过真正的 player_action 处理器；每手完整牌谱（去掉墙钟时间）+ 每手结束后的筹码
//   G4 胜率：固定 60 个剩余牌少的局面（穷举，结果确定）
//   （G3 离线验算在测试里对 G2 的每一手跑；G5 前端靠截图，不在这里）
//
// 可复现靠三件事：每手开始前塞固定的 serverSeed（引擎每手结束会换一个随机新种子）、
// 假时钟（全押跑马 / 多次发牌靠定时器推进）、把 Math.random 换成固定种子（翻前胜率是蒙特卡洛，决定多次发牌谁来选）。
//
// 用法：node golden/holdem-golden.js --write    （只在上面说的情况下）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Deck, Card, HandEvaluator } = require(path.join(ROOT, 'PokerLogic'));
const equity = require(path.join(ROOT, 'equity'));
const config = require(path.join(ROOT, 'src/config'));
const { createPokerService } = require(path.join(ROOT, 'src/games/poker/poker-service'));
const { registerPokerActionEvents } = require(path.join(ROOT, 'src/socket/events/poker-action-events'));
const { commitOf } = require(path.join(ROOT, 'src/games/poker/provably-fair'));
const { maxBetTo } = require(path.join(ROOT, 'src/games/poker/variants'));

const FILES = {
    evaluator: path.join(__dirname, 'holdem-evaluator.json'),
    engine: path.join(__dirname, 'holdem-engine.json'),
    equity: path.join(__dirname, 'holdem-equity.json'),
};

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 按固定顺序建一副 52 张、用种子洗（不用 new Deck()：它构造时会拿 crypto 洗一次）
function shuffledDeck(rng) {
    const cards = [];
    for (const suit of ['Spades', 'Hearts', 'Diamonds', 'Clubs']) for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) cards.push(new Card(suit, rank));
    for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    return cards;
}
const cs = (c) => c.rank + c.suit[0];

// ───────── G1 判牌 ─────────
function runEvaluator(n = 60000) {
    const rng = mulberry32(20261118);
    const h = crypto.createHash('sha256');
    const sample = [];
    const byCat = {};
    for (let i = 0; i < n; i++) {
        const seven = shuffledDeck(rng).slice(0, 7);
        const score = HandEvaluator.evaluate7Cards(seven);
        const best = HandEvaluator.bestHand(seven);
        const from = HandEvaluator.bestHandFrom(seven);
        const five = HandEvaluator.bestHandFrom(seven.slice(0, 5));
        const row = [seven.map(cs).join(' '), score, best.score, best.indices.join(''), best.category, from.score, from.indices.join(''), from.category, five.score, HandEvaluator.handCategory(score)].join('|');
        h.update(row + '\n');
        byCat[best.category] = (byCat[best.category] || 0) + 1;
        if (i < 200) sample.push(row);
    }
    return { n, hash: h.digest('hex'), byCategory: byCat, sample };
}

// ───────── 假时钟 + 固定随机 ─────────
function deterministic(seed, fn) {
    const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, setInterval: global.setInterval, clearInterval: global.clearInterval, now: Date.now, random: Math.random };
    const clock = { now: 1_800_000_000_000, seq: 0, timers: new Map() };
    const add = (fnc, ms, args, every) => {
        const id = ++clock.seq;
        clock.timers.set(id, { at: clock.now + Math.max(0, Number(ms) || 0), fn: fnc, args, every });
        return { id, unref() { return this; }, ref() { return this; }, hasRef() { return false; }, [Symbol.toPrimitive]() { return id; } };
    };
    const del = (t) => { if (t != null) clock.timers.delete(typeof t === 'object' ? t.id : t); };
    global.setTimeout = (f, ms, ...args) => add(f, ms, args, 0);
    global.clearTimeout = del;
    global.setInterval = (f, ms, ...args) => add(f, ms, args, Math.max(1, Number(ms) || 1));
    global.clearInterval = del;
    Date.now = () => clock.now;
    Math.random = mulberry32(seed);
    clock.fireNext = () => {
        let best = null;
        for (const [id, t] of clock.timers) if (!best || t.at < best[1].at || (t.at === best[1].at && id < best[0])) best = [id, t];
        if (!best) return false;
        const [id, t] = best;
        clock.now = Math.max(clock.now, t.at);
        if (t.every) t.at = clock.now + t.every; else clock.timers.delete(id);
        t.fn(...t.args);
        return true;
    };
    clock.advance = (ms) => {
        const until = clock.now + ms;
        for (;;) {
            let due = null;
            for (const [id, t] of clock.timers) if (t.at <= until && (!due || t.at < due[1].at || (t.at === due[1].at && id < due[0]))) due = [id, t];
            if (!due) break;
            clock.fireNext();
        }
        clock.now = until;
    };
    clock.nextAt = () => { let m = Infinity; for (const t of clock.timers.values()) m = Math.min(m, t.at); return m; };
    try { return fn(clock); } finally {
        global.setTimeout = saved.setTimeout; global.clearTimeout = saved.clearTimeout;
        global.setInterval = saved.setInterval; global.clearInterval = saved.clearInterval;
        Date.now = saved.now; Math.random = saved.random;
    }
}

// ───────── G2 整手牌 ─────────
// 一张桌：真 poker-service + 每个玩家一个假 socket，挂上真正的 player_action / propose_runs / respond_runs 处理器
function playTable({ name, stacks, cfg, hands, seed }) {
    return deterministic(seed, (clock) => {
        const rng = mulberry32(seed * 7 + 1);
        const roomGames = {};
        const sink = { emit() {} };
        const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
        const saved = [];
        const noop = () => {};
        const persistence = { commit: noop, commitWithWallet: () => ({ applied: true }) };
        const db = { raw: { transaction: (fn) => fn }, appendHand: (h) => saved.push(JSON.parse(JSON.stringify(h))), matches: { markRecoveryNeeded: noop } };
        const hooks = { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop };
        const svc = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime: { roomGames }, hooks, persistence });
        const game = {
            roomType: 'cash', status: 'running', phase: config.PHASES.WAITING, matchId: 'golden-' + name,
            config: { sb: 10, bb: 20, ante: 0, maxPlayers: stacks.length, ...cfg },
            deck: new Deck(), players: stacks.map((chips, i) => ({
                userId: `${name}${i}`, username: `${name}${i}`, displayName: `${name}${i}`, seat: i, socketId: `s${i}`, chips, buyIn: chips,
                currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false
            })),
            buttonSeat: stacks.length - 1, handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0, actionOnIdx: -1
        };
        roomGames.R = game;
        const sockets = {};
        for (const p of game.players) {
            const socket = { currentRoom: 'R', handlers: {}, on(ev, f) { this.handlers[ev] = f; }, emit() {} };
            registerPokerActionEvents({ socket, user: { id: p.userId, username: p.username, displayName: p.displayName }, io, db, config, runtime: { roomGames, lobbySockets: new Set() }, tableService: { ...svc, persistence } });
            sockets[p.userId] = socket;
        }
        const act = (uid, action, amount) => sockets[uid].handlers.player_action({ roomId: 'R', action, amount });
        const results = [];
        for (let i = 1; i <= hands; i++) {
            // 输光的人补回 2000（直接改，和真补码一样在局间生效）
            for (const p of game.players) if (p.chips <= 0) { p.chips = 2000; p.buyIn += 2000; p.sittingOut = false; }
            const seed64 = sha(`golden-${name}-${i}`).slice(0, 64);
            game.fair = { serverSeed: seed64, commit: commitOf(seed64), clientSeed: null, nonce: 0, deckOrder: null };
            // 链式 straddle：每 7 手里有两手按预测位置让 UTG（再加 UTG+1、UTG+2）接
            game.straddleChain = [];
            if (cfg.allowUtgStraddle && (i % 7 === 3 || i % 7 === 6)) {
                const pos = svc.projectedPositions(game);
                const depth = 1 + (i % 3);
                (pos && pos.afterBB || []).slice(0, depth).forEach((p, ci) => game.straddleChain.push({ userId: p.userId, seat: p.seat, amount: game.config.bb * Math.pow(2, ci + 1), targetHandSeq: game.handSeq + 1 }));
            }
            const before = saved.length;
            svc.startHand('R');
            for (let step = 0; step < 400 && saved.length === before; step++) {
                if (game.runItPending && game.runIt) {
                    if (!game.runIt.proposed) sockets[game.runIt.deciderId].handlers.propose_runs({ n: 1 + Math.floor(rng() * 3) });
                    else sockets[game.runIt.leaderId].handlers.respond_runs({ agree: rng() < 0.7 });
                    continue;
                }
                if (game.actionOnIdx >= 0) {
                    clock.advance(700);   // 思考 0.7 秒（让牌谱里的思考时间有值、而且固定）
                    if (game.actionOnIdx < 0) continue;
                    const p = game.players[game.actionOnIdx];
                    const bb = game.config.bb;
                    const toCall = game.currentBet - p.currentBet;
                    const maxTo = maxBetTo(game, p);   // 德州 = 全下额（和原来 chips + currentBet 一样）；奥马哈 = 底池限注上限
                    const potNow = game.pot + game.players.reduce((a, x) => a + (x.currentBet || 0), 0);
                    const minRaiseTo = game.currentBet + (game.lastRaiseSize || bb);
                    const closed = p.hasActed && toCall > 0 && toCall < (game.lastRaiseSize || bb);
                    const r = rng();
                    let a;
                    if (toCall <= 0) {
                        if (r < 0.55) a = ['check'];
                        else if (r < 0.9) a = [game.currentBet ? 'raise' : 'bet', Math.min(maxTo, Math.max(game.currentBet ? minRaiseTo : bb, Math.round(potNow * (0.5 + rng()))))];
                        else a = [game.currentBet ? 'raise' : 'bet', maxTo];
                    } else if (closed) a = r < 0.3 ? ['fold'] : ['call'];
                    else if (r < 0.25) a = ['fold'];
                    else if (r < 0.75) a = ['call'];
                    else if (r < 0.92) a = ['raise', Math.min(maxTo, Math.max(minRaiseTo, game.currentBet + Math.round(potNow * (0.6 + rng()))))];
                    else a = ['raise', maxTo];
                    const marker = (game.hand && game.hand.actions.length) || 0;
                    act(p.userId, a[0], a[1]);
                    // 处理器拒绝了（比如加注额不合法）→ 退回跟注 / 过牌，再不行弃牌：绝不能原地打转
                    if (game.hand && game.hand.actions.length === marker && game.players[game.actionOnIdx] === p) {
                        act(p.userId, toCall > 0 ? 'call' : 'check');
                        if (game.hand && game.hand.actions.length === marker && game.players[game.actionOnIdx] === p) act(p.userId, 'fold');
                    }
                    continue;
                }
                if (!clock.fireNext()) break;   // 没人要行动：全押跑马 / 多次发牌，拨到下一个定时器
            }
            if (saved.length === before) throw new Error(`[golden] ${name} 第 ${i} 手没打完`);
            const h = saved[saved.length - 1];
            delete h.ts; delete h.completedAt;   // 墙钟时间（假时钟下也固定，但和真实时间无关的字段不入答案）
            results.push({ hand: h, chipsAfter: game.players.map(p => [p.userId, p.chips]) });
            // 拆掉这一手留下的计时器（行动 / straddle 邀请），下一手从干净的钟开始
            clock.timers.clear();
        }
        return results;
    });
}

function runEngine() {
    const six = playTable({ name: 'A', stacks: [3000, 1500, 4000, 800, 2500, 6000], cfg: { ante: 5, allowUtgStraddle: true, sevenDeuceBB: 2, bombEvery: 5, bombBB: 2 }, hands: 70, seed: 101 });
    const hu = playTable({ name: 'H', stacks: [2000, 3500], cfg: { sevenDeuceBB: 5, bombEvery: 5, bombBB: 5 }, hands: 40, seed: 202 });
    const all = six.concat(hu);
    const facts = {
        hands: all.length,
        bomb: all.filter(x => x.hand.bomb).length,
        straddle: all.filter(x => (x.hand.actions || []).some(a => a.action === 'straddle')).length,
        chainStraddle: all.filter(x => (x.hand.actions || []).filter(a => a.action === 'straddle').length >= 2).length,
        runIt: all.filter(x => x.hand.runIt && x.hand.runIt.n > 1).length,
        allInHands: all.filter(x => (x.hand.results || []).some(r => r.endChips === 0)).length,
        showdown: all.filter(x => (x.hand.community || []).length === 5).length,
        sevenDeuce: all.filter(x => x.hand.sevenDeuce).length,
    };
    return { facts, hash: sha(JSON.stringify(all)), hands: all };
}

// ───────── G4 胜率 ─────────
function runEquity(n = 60) {
    const rng = mulberry32(777);
    const out = [];
    for (let i = 0; i < n; i++) {
        const deck = shuffledDeck(rng);
        const players = 2 + (i % 3);
        const boardLen = i % 2 ? 4 : 3;   // 翻牌后 / 转牌后：剩余组合少，走穷举，结果确定
        const holes = {};
        for (let k = 0; k < players; k++) holes['p' + k] = [deck[2 * k], deck[2 * k + 1]];
        const community = deck.slice(2 * players, 2 * players + boardLen);
        const eq = equity.computeEquity(holes, community);
        out.push({ holes: Object.fromEntries(Object.entries(holes).map(([k, v]) => [k, v.map(cs)])), community: community.map(cs), equity: eq });
    }
    return out;
}

if (require.main === module) {
    if (!process.argv.includes('--write')) {
        console.log('只在【有意改变德州行为、且用户同意】时才重写黄金样本：node golden/holdem-golden.js --write');
        process.exit(1);
    }
    const ev = runEvaluator();
    fs.writeFileSync(FILES.evaluator, JSON.stringify(ev, null, 1));
    const en = runEngine();
    fs.writeFileSync(FILES.engine, JSON.stringify(en, null, 1));
    const eq = runEquity();
    fs.writeFileSync(FILES.equity, JSON.stringify(eq, null, 1));
    console.log('G1 判牌', ev.n, '手', ev.hash.slice(0, 16), JSON.stringify(ev.byCategory));
    console.log('G2 整手牌', JSON.stringify(en.facts), en.hash.slice(0, 16));
    console.log('G4 胜率', eq.length, '个局面');
}

// playTable 也导出给其它玩法的测试复用（短牌 / 奥马哈用同一套真引擎 + 假 socket 跑整手牌）；它只打牌、不写答案文件
module.exports = { runEvaluator, runEngine, runEquity, playTable, FILES, mulberry32 };
