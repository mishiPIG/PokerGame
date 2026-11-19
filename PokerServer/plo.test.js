'use strict';
// 奥马哈 PLO（2026-11-19）：4 张底牌、【必须正好 2 张底牌 + 3 张公共牌】、底池限注。
// 最怕的是「2 + 3」被算成德州的 7 选 5 —— 那不会报错，只会悄悄判错输赢。所以先钉几个反例。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { variantById, maxBetTo } = require('./src/games/poker/variants');
const { playTable } = require('./golden/holdem-golden');

const plo = variantById('plo'), nlhe = variantById('nlhe');
const S = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
const C = (str) => str.split(' ').map(x => ({ rank: x[0], suit: S[x[1]] }));

test('🔴 「2 + 3」：公共牌四张同花、手里只有一张同花 —— 德州是同花，奥马哈不是', () => {
    const board = C('Ah Kh Qh Jh 2c'), hole = C('9h 9s 8c 7d');
    assert.equal(nlhe.best(board, hole.slice(0, 2)).category, '同花');
    assert.equal(plo.best(board, hole).category, '一对', '只能用手里两张：9h 9s + 公共牌三张 → 一对 9');
});

test('🔴 「2 + 3」：手里四张同花、公共牌只有一张 —— 德州会是皇家同花顺，奥马哈什么同花都没有', () => {
    const board = C('Th 9c 2d 3s 5c'), hole = C('Ah Kh Qh Jh');
    assert.equal(nlhe.best(board, C('Ah Kh')).category, '高牌');   // 德州两张也凑不出，这里只证明奥马哈不会把四张都用上
    const b = plo.best(board, hole);
    assert.notEqual(b.category, '同花'); assert.notEqual(b.category, '皇家同花顺'); assert.notEqual(b.category, '同花顺');
    assert.equal(b.holeIdx.length, 2); assert.equal(b.boardIdx.length, 3);
});

test('正常的 2 + 3：A K 加公共牌 Q J T 是顺子；用到的底牌 / 公共牌下标对得上', () => {
    const b = plo.best(C('Qd Jc Th 7s 6s'), C('As Kh 2c 3d'));
    assert.equal(b.category, '顺子');
    assert.deepEqual(b.holeIdx.sort(), [0, 1]);
    assert.deepEqual(b.boardIdx.sort(), [0, 1, 2]);
    // 翻牌时（3 张公共牌）只有一种三张组合
    assert.equal(plo.bestPartial(C('Qd Jc Th'), C('As Kh 2c 3d')).category, '顺子');
    assert.equal(plo.bestPartial(C('Qd Jc'), C('As Kh 2c 3d')), null, '公共牌不到 3 张没有牌型');
});

test('🔴 底池限注的上限：和标准算法一致（翻前 10/20 最多加到 70；底池 200 面对 100 的下注最多加到 500）', () => {
    const P = (id, currentBet, chips) => ({ userId: id, currentBet, chips });
    const g = (cfg, extra) => ({ config: { variant: cfg }, players: [], ...extra });
    // 翻前：小盲 10、大盲 20 都在桌上，底池还没收（pot 0），UTG 要跟 20
    const pre = g('plo', { pot: 0, currentBet: 20, players: [P('sb', 10, 990), P('bb', 20, 980), P('utg', 0, 1000)] });
    assert.equal(maxBetTo(pre, pre.players[2]), 70);
    // 翻牌后：底池 200，对手下了 100，我要跟 100 → 跟完底池 400 → 最多加到 100 + 400 = 500
    const post = g('plo', { pot: 200, currentBet: 100, players: [P('v', 100, 900), P('me', 0, 1000)] });
    assert.equal(maxBetTo(post, post.players[1]), 500);
    // 首注：底池 200、没人下注 → 最多下 200
    const first = g('plo', { pot: 200, currentBet: 0, players: [P('v', 0, 900), P('me', 0, 1000)] });
    assert.equal(maxBetTo(first, first.players[1]), 200);
    // 筹码不够上限 → 就是全下
    const short = g('plo', { pot: 200, currentBet: 0, players: [P('v', 0, 900), P('me', 0, 150)] });
    assert.equal(maxBetTo(short, short.players[1]), 150);
    // 德州：一律是全下额（行为不变）
    const nl = g('nlhe', { pot: 200, currentBet: 100, players: [P('v', 100, 900), P('me', 0, 1000)] });
    assert.equal(maxBetTo(nl, nl.players[1]), 1000);
});

function loadVerify() {
    const src = fs.readFileSync(path.join(__dirname, 'tools', 'verify-hand.js'), 'utf8');
    const dir = path.join(__dirname, 'tools');
    const ctx = { require: (m) => require(m.startsWith('.') ? path.join(dir, m) : m), __dirname: dir, __filename: path.join(dir, 'verify-hand.js'), process: { argv: ['node', 'v'], exit() {} }, console, Buffer };
    vm.createContext(ctx);
    vm.runInContext(src.slice(0, src.indexOf('const hand = readInput();')) + '\n;this.verify = verify;', ctx);
    return ctx.verify;
}
const parse = (x) => ({ rank: x[0], suit: { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[x[1]] });

test('🔴 真引擎打 70 手奥马哈：每人 4 张、单手守恒、每手都能离线验算、牌型按 2+3 算、没有超过底池限注的下注', () => {
    const six = playTable({ name: 'O', stacks: [3000, 1500, 4000, 800, 2500, 6000], cfg: { variant: 'plo', ante: 5, bombEvery: 5, bombBB: 2, allowUtgStraddle: true }, hands: 45, seed: 505 });
    const hu = playTable({ name: 'P', stacks: [2000, 3500], cfg: { variant: 'plo' }, hands: 25, seed: 606 });
    const hands = six.concat(hu).map(x => x.hand);
    const verify = loadVerify();
    let showdowns = 0;
    for (const h of hands) {
        assert.equal(h.variant, 'plo');
        assert.ok(h.seats.every(s => s.hole.length === 4), `第 ${h.handSeq} 手有人不是 4 张底牌`);
        const cards = [...h.seats.flatMap(s => s.hole), ...(h.community || [])];
        assert.equal(new Set(cards).size, cards.length, `第 ${h.handSeq} 手有重复的牌`);
        assert.equal(h.results.reduce((a, r) => a + r.endChips, 0), h.seats.reduce((a, s) => a + s.startChips, 0), `第 ${h.handSeq} 手不守恒`);
        const r = verify(h);
        assert.equal(r.ok, true, `第 ${h.handSeq} 手离线验算不过：` + JSON.stringify(r.out.filter(x => !x[1])));
        if ((h.community || []).length === 5) {
            showdowns++;
            for (const res of h.results) {
                if (!res.category) continue;
                const seat = h.seats.find(s => s.userId === res.userId);
                assert.equal(res.category, plo.best(h.community.map(parse), seat.hole.map(parse)).category, '牌谱里的牌型名要按 2+3 算');
            }
        }
    }
    assert.ok(showdowns > 10, `摊牌 ${showdowns} 手`);
});

test('🔴 底池限注在真处理器上生效：超过上限的加注被拒（带上限金额），正好在上限的照常', () => {
    // 用 playTable 同一套真引擎：开一手奥马哈，翻前 UTG 先试一个超大的加注
    const { createPokerService } = require('./src/games/poker/poker-service');
    const { registerPokerActionEvents } = require('./src/socket/events/poker-action-events');
    const { Deck, HandEvaluator } = require('./PokerLogic');
    const config = require('./src/config');
    const equity = require('./equity');
    const roomGames = {}, noop = () => {};
    const sink = { emit() {} };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const svc = createPokerService({ io, db: { raw: { transaction: (f) => f }, appendHand: noop, matches: { markRecoveryNeeded: noop } }, equity, Deck, HandEvaluator, config, runtime: { roomGames },
        hooks: { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop }, persistence: { commit: noop } });
    const game = { roomType: 'cash', status: 'running', phase: 'waiting', matchId: 'm', config: { sb: 10, bb: 20, ante: 0, maxPlayers: 3, variant: 'plo' }, deck: new Deck(),
        players: [0, 1, 2].map(i => ({ userId: 'u' + i, username: 'p' + i, seat: i, socketId: 's' + i, chips: 5000, buyIn: 5000, currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false })),
        buttonSeat: 2, handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0, actionOnIdx: -1 };
    roomGames.R = game;
    const msgs = [];
    const sockets = {};
    for (const p of game.players) {
        const socket = { currentRoom: 'R', handlers: {}, on(ev, f) { this.handlers[ev] = f; }, emit(ev, d) { msgs.push([p.userId, ev, d]); } };
        registerPokerActionEvents({ socket, user: { id: p.userId, username: p.username }, io, config, runtime: { roomGames, lobbySockets: new Set() }, tableService: { ...svc, persistence: { commit: noop } } });
        sockets[p.userId] = socket;
    }
    svc.startHand('R');
    try {
        assert.ok(game.holeCards.u0.length === 4);
        const actor = game.players[game.actionOnIdx];
        const cap = maxBetTo(game, actor);
        assert.equal(cap, 70, '翻前 10/20：最多加到 70');
        sockets[actor.userId].handlers.player_action({ roomId: 'R', action: 'raise', amount: 500 });
        assert.ok(msgs.some(m => m[0] === actor.userId && m[2] && m[2].k === 'act.potLimit' && m[2].p.max === 70), '超过上限被拒，并告诉他上限是多少');
        assert.equal(actor.currentBet, 0, '被拒的加注没有扣钱');
        sockets[actor.userId].handlers.player_action({ roomId: 'R', action: 'raise', amount: 70 });
        assert.equal(actor.currentBet, 70, '正好在上限的加注照常');
    } finally { clearTimeout(game.actionTimer); if (game.straddleDecision) clearTimeout(game.straddleDecision.timer); }
});

test('奥马哈 4 张牌的排法：一排叠放 + 被压住的牌用角标；高亮的牌不许浮到最上层盖住后一张', () => {
    const css = fs.readFileSync(path.join(__dirname, 'public/css/20-table.css'), 'utf8');
    const rule = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
    // 每张都定位 → 层次按先后；默认 .card.hl 带 z-index: 2，叠放时必须改回 auto，否则抬起的赢家牌把后一张整个盖住（截图里量到过）
    assert.match(rule('.self-cards.many .card, .opp-cards.many .card'), /position:\s*relative/);
    assert.match(rule('.self-cards.many .card.hl, .opp-cards.many .card.hl'), /z-index:\s*auto/);
    // 四张一律角标：点数 + 花色靠左竖排（落在露出来的那一条里）
    assert.match(rule('.opp-cards.many .card, .self-cards.many .card'), /align-items:\s*flex-start/);
    assert.match(rule('.ring-seat .opp-cards.many .card > .suit'), /align-self:\s*flex-start/);
    // 🔴 四张必须同一个样子：不许再出现「只有前三张用角标、最后一张照常大字」（用户 2026-11-19：看着很不协调）
    for (const f of ['public/css/20-table.css', 'public/css/44-replay.css', 'public/css/46-history.css']) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.doesNotMatch(src, /\.many \.card:not\(:last-child\)/, f + ' 里四张牌的样式又分开了');
    }
    // 不许改成两行：两行必定盖住这个座位自己的名字和筹码
    assert.doesNotMatch(css, /\.opp-cards\.many \.card-row \{[^}]*grid/);
});

test('7-2 奖励只在德州：奥马哈 / 短牌建房清零、投票不收', () => {
    const lobby = fs.readFileSync(path.join(__dirname, 'src/socket/events/lobby-events.js'), 'utf8');
    assert.match(lobby, /sevenDeuceBB: normalizeVariant\(cfg\.variant\) === 'nlhe' &&/);
    const rv = require('./src/rooms/rule-vote');
    const game = { roomType: 'cash', ownerUserId: 'h', config: { variant: 'plo', sevenDeuceBB: 0 }, players: [{ userId: 'h' }, { userId: 'a' }] };
    assert.equal(rv.propose(game, 'h', 'sevenDeuce', { bb: 2 }).reason, 'noSevenDeuce');
});

test('奥马哈界面上的几处文案 / 布局（2026-11-19 UI 测试抓的）', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    const room = read('public/js/30-room.js'), guide = read('public/js/44-guide.js'), i18n = read('public/js/03-i18n.js');
    const renderer = read('public/js/80-table-renderer.js'), replay = read('public/js/42-replay.js'), rcss = read('public/css/44-replay.css');
    // 比赛设置：7-2 那一行和投票按钮只在德州桌出现
    assert.match(room, /if \(!st\.variant \|\| st\.variant === 'nlhe'\) rows\.push\(\[L\('7-2 奖励'/);
    assert.match(room, /if \(!st\.variant \|\| st\.variant === 'nlhe'\) html \+= `<div class="cfg-field" style="margin-top:10px"><span class="cfg-label">\$\{L\('7-2 奖励/);
    // 速查表底部那句按玩法换；中英文都有
    assert.match(guide, /plo \? t\('hg\.notePlo'\) : t\('hg\.note'\)/);
    assert.equal((i18n.match(/'hg\.notePlo':/g) || []).length, 2);
    // 第二步提示：奥马哈说「四张里挑两张」
    assert.match(guide, /从你的四张里挑两张/);
    // 4 张时 All in 标签再往外挪
    assert.match(renderer, /\(state\.holeCount \|\| 2\) > 2 \? ' wide' : ''/);
    // 回放 / 牌谱详情：4 张一排叠放 + 角标；人多时收紧
    assert.match(replay, /rp-cards\$\{p\.hole\.length > 2 \? ' many' : ''\}/);
    assert.match(replay, /classList\.toggle\('crowd', n >= 8\)/);
    assert.match(rcss, /\.rp-cards\.many \.card \{[^}]*align-items:\s*flex-start/);
});

test('🔴 全押胜率不能卡住服务器：奥马哈 / 短牌多人翻前改用抽样，德州的判断不变', () => {
    const { withinBudget } = require('./equity');
    const { variantById } = require('./src/games/poker/variants');
    const plo = variantById('plo'), sd = variantById('shortdeck'), nl = variantById('nlhe');
    // 奥马哈 8 人翻前：C(20,5)=15504 种牌面 × 8 人 × 60 ≈ 740 万次评估（实测 0.6 秒卡住整个服务器）→ 不许穷举
    assert.equal(withinBudget(plo, 15504, 8), false);
    assert.equal(withinBudget(sd, 15504, 8), false, '短牌 8 人翻前（实测 0.4 秒）');
    // 翻牌 / 转牌照常精确穷举
    assert.equal(withinBudget(plo, 703, 6), true);
    assert.equal(withinBudget(sd, 78, 9), true);
    // 德州不声明上限：和原来完全一样（只看牌面数 ≤ 20000）
    assert.equal(nl.exactBudget, undefined);
    assert.equal(withinBudget(nl, 15504, 9), true);
    assert.equal(withinBudget(null, 15504, 9), true);
});
