'use strict';
// 2026-11-14 第二批（A 批）：会丢钱、会卡局的牌局流程问题。能用真模块跑的都真跑。
process.env.EMPTY_GRACE_MS = '5';    // 空房宽限压到 5ms（必须在 require 之前设）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Deck, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');
const { createRoomLifecycle } = require('./src/rooms/room-lifecycle');
const { createMatchResultService } = require('./src/matches/match-result-service');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function engine(stacks) {
    const roomGames = {};
    const sink = { emit() {} };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const noop = () => {};
    const svc = createPokerService({
        io, equity, Deck, HandEvaluator, config, runtime: { roomGames },
        db: { raw: { transaction: (fn) => fn }, appendHand: noop, matches: { markRecoveryNeeded: noop } },
        persistence: { commit: noop },
        hooks: { applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop, startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop }
    });
    const game = {
        roomType: 'cash', status: 'running', phase: config.PHASES.FLOP, matchId: 'm', hand: null,
        config: { sb: 100, bb: 200, ante: 0, maxPlayers: stacks.length }, deck: new Deck(),
        players: stacks.map((chips, i) => ({ userId: 'u' + i, username: 'p' + i, seat: i, chips, buyIn: chips, currentBet: 0, committed: 0, folded: false, allIn: false, hasActed: false })),
        holeCards: {}, communityCards: [], pot: 0, currentBet: 0, actionOnIdx: -1
    };
    roomGames.R = game;
    return { svc, game, io };
}

// ───────── 1 局间开新一手只有一个入口 ─────────
test('🔴 局间不许绕过 scheduleNextHand 直接开新一手', () => {
    for (const f of ['src/socket/events/membership-events.js', 'src/socket/events/table-control-events.js']) {
        assert.doesNotMatch(codeOf(read(f)), /\bstartHand\(roomId\)/, `${f} 里还有直接 startHand 的地方 —— 会跳过本手收尾（离座 / 挂起的解散 / 到点结算）`);
    }
    const cash = codeOf(read('src/matches/cash-match-service.js'));
    assert.equal((cash.match(/setTimeout\(\(\) => runNextHand\(roomId\)/g) || []).length, 2, '正常排队和重启恢复都要走同一个 runNextHand');
    assert.match(cash, /function runNextHand\(roomId\)[\s\S]*?removeBustedPlayers[\s\S]*?pendingDissolve[\s\S]*?pendingEnd/);
});

// ───────── 2/3 空房清理 ─────────
function lifecycleHarness(game, roomSize = 0) {
    const calls = [];
    const rooms = new Map(roomSize ? [['R', { size: roomSize }]] : []);
    const roomGames = { R: game };
    const lc = createRoomLifecycle({
        io: { sockets: { adapter: { rooms } } }, roomGames,
        hooks: {
            endCashTable: (id, why) => calls.push(['end', why]),
            dissolveNow: (id) => calls.push(['dissolve']),
            clearActionTimer() {}, broadcastRoomList() {}, finishRoom: (id, s) => calls.push(['finish', s])
        }
    });
    return { lc, calls, roomGames };
}

test('🔴 空房计时到点时还在一手牌里 → 不当场结算（下进池里的筹码会消失），改成本手打完再解散', async () => {
    const game = { roomType: 'cash', phase: 'turn', players: [{ chips: 3000 }], vacatedPlayers: [] };
    const { lc, calls } = lifecycleHarness(game);
    lc.scheduleEmptyCleanup('R');
    await sleep(30);
    assert.deepEqual(calls, [], '不能在牌局中途结算');
    assert.equal(game.pendingDissolve, 'empty', '要挂上可撤销的「本手打完再解散」');
});

test('空房计时到点、局间、还有筹码 → 正常结算；房里还有人 → 什么都不做', async () => {
    const game = { roomType: 'cash', phase: 'showdown', players: [{ chips: 3000 }], vacatedPlayers: [] };
    const h1 = lifecycleHarness(game);
    h1.lc.scheduleEmptyCleanup('R');
    await sleep(30);
    assert.equal(h1.calls[0][0], 'end');
    const g2 = { roomType: 'cash', phase: 'showdown', players: [{ chips: 3000 }], vacatedPlayers: [] };
    const h2 = lifecycleHarness(g2, 1);
    h2.lc.scheduleEmptyCleanup('R');
    await sleep(30);
    assert.deepEqual(h2.calls, []);
});

test('有人回来就撤销「空房、本手后解散」，但房主自己点的不撤销', () => {
    const ms = codeOf(read('src/rooms/membership-service.js'));
    assert.match(ms, /if \(game\.pendingDissolve === 'empty'\) game\.pendingDissolve = false/);
});

test('任何连接离开都挂空房计时（原来只在座玩家掉线才挂）；重启恢复也挂', () => {
    const d = codeOf(read('src/socket/events/disconnect-events.js'));
    assert.ok(d.indexOf('scheduleEmptyCleanup(roomId)') < d.indexOf('if (idx < 0) return'), '必须在「不是在座玩家就返回」之前');
    assert.match(codeOf(read('src/table/table-service.js')), /restoreRecoveredTimers[\s\S]*scheduleEmptyCleanup\(roomId\)/);
});

test('房里一个连接都没有时，行动计时器快速代打', () => {
    const hs = codeOf(read('src/games/poker/hand-service.js'));
    assert.match(hs, /leftByChoice \|\| nobodyHere\) \? LEFT_PLAYER_ACT_MS : ACTION_TIME/);
});

test('建房有上限（每人 / 全服）', () => {
    const lobby = codeOf(read('src/socket/events/lobby-events.js'));
    assert.equal((lobby.match(/const limit = roomLimitReached\(roomGames, user\.id\)/g) || []).length, 2, 'SNG 和现金桌建房都要查');
    const fn = new Function(/(function roomLimitReached[\s\S]*?\n\})/.exec(lobby)[1] + '\nreturn roomLimitReached;')();
    const MAX_ROOMS_PER_OWNER = 3, MAX_ROOMS_TOTAL = 300;   // eslint-disable-line no-unused-vars
    const limitFn = new Function('MAX_ROOMS_PER_OWNER', 'MAX_ROOMS_TOTAL', 'return ' + fn.toString())(MAX_ROOMS_PER_OWNER, MAX_ROOMS_TOTAL);
    const rooms = (n, owner) => Object.fromEntries(Array.from({ length: n }, (_, i) => [owner + i, { ownerUserId: owner }]));
    assert.equal(limitFn(rooms(2, 'a'), 'a'), null);
    assert.equal(limitFn(rooms(3, 'a'), 'a'), 'room.tooManyMine');
    assert.equal(limitFn({ ...rooms(3, 'a'), x: { ownerUserId: 'a', tournamentOver: true } }, 'b'), null, '已结束的房间不算');
});

// ───────── 4 底池不能凭空消失 ─────────
test('🔴 超时时他已经是最后一个没弃牌的人 → 不能再把他弃掉，他赢下底池', (t) => {
    const { svc, game } = engine([5000, 5000]);
    t.after(() => clearTimeout(game.actionTimer));
    const [a, b] = game.players;
    Object.assign(b, { folded: true, committed: 400, chips: 4600 });
    Object.assign(a, { committed: 400, chips: 4600 });
    game.currentBet = 600; b.currentBet = 600; b.chips -= 600;       // b 下了注之后离桌被弃
    game.actionOnIdx = 0;
    svc.onActionTimeout('R');
    assert.equal(a.folded, false, '最后一个人不能被超时弃牌');
    assert.equal(a.chips + b.chips, 10000, '筹码守恒');
    assert.equal(a.chips, 5400, '他赢走对手已被跟到的 400');
    assert.equal(b.chips, 4600, '对手下了没人跟的 600 就离桌了：这 600 退给他，不白送');
});

test('真出现「一个没弃牌的人都没有」→ 按投入原数退回，不让底池蒸发', (t) => {
    const { svc, game } = engine([5000, 5000]);
    t.after(() => clearTimeout(game.actionTimer));
    for (const p of game.players) Object.assign(p, { folded: true, committed: 300, chips: 4700 });
    game.pot = 600;
    const orig = console.error; console.error = () => {};
    try { svc.advanceStage('R'); } finally { console.error = orig; }
    assert.deepEqual(game.players.map(p => p.chips), [5000, 5000]);
});

test('现金桌离开时弃了牌就一定推进（原来「全员离桌」时不推进）', () => {
    const m = codeOf(read('src/socket/events/membership-events.js'));
    assert.doesNotMatch(m, /if \(!anyActive && listSpectators\(roomId\)\.length === 0\)/);
});

// ───────── 5 SNG 排名 ─────────
test('🔴 SNG 结算排名里有亚军（原来单挑只有冠军一行）', () => {
    const svc = createMatchResultService({ io: { in: () => ({ emit() {} }) }, db: { getUserById: () => null }, roomGames: {} });
    const game = {
        roomType: 'sng', config: { buyIn: 1100 },
        players: [
            { userId: 'w', username: 'W', chips: 20000, handsPlayed: 30 },
            { userId: 'r', username: 'R', chips: 0, handsPlayed: 30 }
        ],
        statsHistory: []
    };
    const ranking = svc.buildRanking(game, 'w', 2000);
    assert.deepEqual(ranking.map(r => [r.rank, r.userId, r.net]), [[1, 'w', 900], [2, 'r', -1100]]);
});

test('SNG 中途解散：还在桌上的按筹码排，已出局的排后面，不重复', () => {
    const svc = createMatchResultService({ io: { in: () => ({ emit() {} }) }, db: { getUserById: () => null }, roomGames: {} });
    const game = {
        roomType: 'sng', config: { buyIn: 110 },
        players: [
            { userId: 'a', username: 'A', chips: 9000 },
            { userId: 'b', username: 'B', chips: 4000 },
            { userId: 'c', username: 'C', chips: 7000 }
        ],
        statsHistory: [{ userId: 'd', username: 'D' }, { userId: 'b', username: 'B' }]
    };
    const ranking = svc.buildRanking(game, 'a', 200);
    assert.deepEqual(ranking.map(r => r.userId), ['a', 'c', 'b', 'd']);
});

// ───────── 10 多次发牌协商的重连恢复 ─────────
test('🔴 断线重连能恢复到「领先方同意」那一步', () => {
    const sp = codeOf(read('src/games/poker/state-presenter.js'));
    for (const f of ['max:', 'deadlineAt:', 'proposed:']) assert.ok(sp.includes(f), `state.runIt 缺 ${f}`);
    assert.match(codeOf(read('src/socket/events/poker-action-events.js')), /game\.runIt\.proposed = true/);
    assert.match(codeOf(read('public/js/20-socket.js')), /if \(state\.runIt\.proposed\) showRunitProposal\(state\.runIt\);\s*else showRunitOffer\(state\.runIt\);/);
});
