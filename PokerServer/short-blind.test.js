'use strict';
// 大盲短码全押、贴得比小盲还少时，牌局不能卡死。
//
// 2026-11-13 生产实锤（房间 210983 第 23 手，单挑 SNG，盲注 100/200）：
// 大盲只剩 50 全押，小盲贴了 100。桌面当前注被记成「大盲贴的 50」，
// 小盲的 100 于是永远 !== 50 —— 过牌之后行动又回到他自己，连过 27 次，最后只能弃牌，
// 还把自己那 100 全输给了只投了 50 的对手。
// 这里用【真引擎】把那一手重放一遍，而不是只断言源码里有某一行。
const test = require('node:test');
const assert = require('node:assert/strict');
const { Deck, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');

function makeTable(stacks, { roomType = 'sng', sb = 100, bb = 200, buttonSeat = null } = {}) {
    const roomGames = {};
    const sink = { emit() {} };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const saved = [];
    const noop = () => {};
    const db = { raw: { transaction: (fn) => fn }, appendHand: (h) => saved.push(h), matches: { markRecoveryNeeded: noop } };
    const persistence = { commit: noop };
    const hooks = {
        applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop,
        startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop
    };
    const svc = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime: { roomGames }, hooks, persistence });
    const game = {
        roomType, status: 'running', phase: config.PHASES.WAITING, matchId: 'm1',
        config: { sb, bb, ante: 0, maxPlayers: stacks.length },
        blindLevels: roomType === 'sng' ? [{ sb, bb }] : undefined, currentLevel: 0,
        deck: new Deck(), players: stacks.map((chips, i) => ({
            userId: 'u' + i, username: 'p' + i, seat: i, chips, buyIn: chips,
            currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false
        })),
        buttonSeat, handSeq: 0, holeCards: {}, communityCards: [], pot: 0, currentBet: 0
    };
    roomGames.R = game;
    return { svc, game, saved };
}
const total = (g) => g.players.reduce((s, p) => s + p.chips + p.currentBet + (p.committed || 0), 0);
const stopTimers = (g) => { clearTimeout(g.actionTimer); clearTimeout(g.runoutTimer); };

test('🔴 单挑：大盲全押得比小盲还少 → 不让小盲空转，直接亮牌，多贴的退回', (t) => {
    // 按钮(=小盲)是 0 号，筹码 29950；大盲 1 号只剩 50
    const { svc, game } = makeTable([29950, 50], { buttonSeat: 1 });   // 下一手按钮轮到 0 号
    t.after(() => stopTimers(game));
    svc.startHand('R');
    const [sbP, bbP] = game.players;
    assert.equal(bbP.allIn, true, '大盲应当已全押');
    assert.equal(game.actionOnIdx, -1, '没有任何决定可做，不该再指着谁行动');
    assert.equal(game.allinRevealed, true, '应当直接进全押亮牌');
    assert.equal(sbP.chips, 29900, '小盲多贴的 50 没人能跟，必须退回');
    assert.equal(game.pot, 100, '真正在争的只有 50 + 50');
    assert.equal(total(game), 30000, '筹码守恒');
});

test('🔴 多人桌大盲短码：其他人要跟满一个大盲；弃到只剩小盲时不再要求他行动', (t) => {
    // 三人桌：按钮 0、小盲 1（贴 100）、大盲 2 只剩 50 全押。
    const { svc, game } = makeTable([5000, 5000, 50], { buttonSeat: 2 });
    t.after(() => stopTimers(game));
    svc.startHand('R');
    assert.equal(game.currentBet, 200, '正式规则：还有两人能行动时，要跟的是完整的一个大盲');
    assert.equal(game.actionOnIdx, 0, '翻前先轮到大盲后面那位');
    const utg = game.players[0];
    utg.folded = true; utg.hasActed = true;
    svc.afterAction('R');
    // 只剩小盲能行动，而他贴的 100 已经多过全押的 50 —— 没人可以跟他比，不能再要他行动
    assert.equal(game.actionOnIdx, -1, '小盲不能被要求补齐一个没人能跟的大盲，也不能被反复要求行动');
    assert.equal(game.allinRevealed, true);
    assert.equal(game.players[1].chips, 4950, '小盲多贴的 50 退回');
    assert.equal(total(game), 10050, '筹码守恒');
});

test('多人桌大盲短码：两人跟满大盲后，短码只争主池，多出的成边池', (t) => {
    const { svc, game } = makeTable([5000, 5000, 50], { buttonSeat: 2 });
    t.after(() => stopTimers(game));
    svc.startHand('R');
    const [btn, sb] = game.players;
    // 按钮跟到 200
    btn.chips -= 200 - btn.currentBet; btn.currentBet = 200; btn.hasActed = true;
    svc.afterAction('R');
    assert.equal(game.actionOnIdx, 1, '小盲面对完整大盲，要补齐或弃牌');
    sb.chips -= 200 - sb.currentBet; sb.currentBet = 200; sb.hasActed = true;
    svc.afterAction('R');
    assert.equal(game.phase, config.PHASES.FLOP, '两人都跟满了，进翻牌');
    const pots = svc.buildSidePots(game).map(p => [p.amount, p.eligible.length]);
    assert.deepEqual(pots, [[150, 3], [300, 2]], '主池 50×3 三人争，边池 150×2 只有跟满的两人争');
    assert.equal(total(game), 10050);
});

test('弃牌获胜时，弃牌者多投的部分退回，不白送给短码全押的赢家', (t) => {
    const { svc, game } = makeTable([29950, 50], { buttonSeat: 1 });
    t.after(() => stopTimers(game));
    // 手工摆出线上那手的收尾：小盲投了 100 后弃牌，大盲全押 50
    Object.assign(game, { phase: config.PHASES.PREFLOP, hand: null, allinRevealed: false, currentBet: 100, pot: 0 });
    Object.assign(game.players[0], { chips: 29850, currentBet: 100, folded: true });
    Object.assign(game.players[1], { chips: 0, currentBet: 50, allIn: true });
    svc.advanceStage('R');
    assert.equal(game.players[1].chips, 100, '只投了 50 的人最多从对手那里赢走 50');
    assert.equal(game.players[0].chips, 29900, '多出来的 50 退给弃牌者');
});

test('平常「下注没人跟」的结算不受影响', (t) => {
    const { svc, game } = makeTable([5000, 5000], { buttonSeat: 1 });
    t.after(() => stopTimers(game));
    Object.assign(game, { phase: config.PHASES.FLOP, hand: null, allinRevealed: false, currentBet: 600, pot: 400 });
    Object.assign(game.players[0], { chips: 4200, committed: 200, currentBet: 600 });
    Object.assign(game.players[1], { chips: 4800, committed: 200, currentBet: 0, folded: true });
    svc.advanceStage('R');
    assert.equal(game.players[0].chips, 5200, '赢走对手的 200，自己的注原样拿回');
    assert.equal(game.players[1].chips, 4800);
});

test('正常盲注下翻前流程不变：单挑小盲先行动、欠 1 个小盲', (t) => {
    const { svc, game } = makeTable([5000, 5000], { buttonSeat: 1 });
    t.after(() => stopTimers(game));
    svc.startHand('R');
    assert.equal(game.currentBet, 200);
    assert.equal(game.actionOnIdx, 0, '单挑按钮位=小盲先行动');
    assert.equal(game.allinRevealed, false);
});
