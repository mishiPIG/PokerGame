'use strict';
// 摊牌可读性（2026-11-17 玩家视角复盘 P1 / P1b）
//
// 服务端：showdown_reveal 现在带上【每一家亮出来的】牌型，不只是赢家的 ——
// 玩家最想看清的是「他拿什么输给我的」。
// 🔴 但只许是本来就亮在桌上的人：弃牌者的牌型绝不能出现，否则等于把他从没亮过的牌告诉全桌。
// 前端：几条结构性断言，防止以后有人把「透明」或「两行水印」改回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Deck, HandEvaluator } = require('./PokerLogic');
const equity = require('./equity');
const config = require('./src/config');
const { createPokerService } = require('./src/games/poker/poker-service');

const card = (s) => ({ rank: s[0], suit: s[1] });

function showdownTable() {
    const roomGames = {};
    const emitted = [];
    const sink = { emit(ev, data) { emitted.push({ ev, data }); } };
    const io = { in: () => sink, to: () => sink, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
    const noop = () => {};
    const db = { raw: { transaction: (fn) => fn }, appendHand: noop, matches: { markRecoveryNeeded: noop } };
    const hooks = {
        applyPendingLevelUp: noop, maybeEndSNG: noop, scheduleNextHand: noop,
        startLevelTimer: noop, startTableTimer: noop, broadcastRoomList: noop
    };
    const svc = createPokerService({ io, db, equity, Deck, HandEvaluator, config, runtime: { roomGames }, hooks, persistence: { commit: noop } });
    const mk = (i, folded, committed) => ({
        userId: 'u' + i, username: 'p' + i, seat: i, chips: 1000, buyIn: 1000,
        currentBet: 0, committed, folded, allIn: false, hasActed: true
    });
    const game = {
        roomType: 'cash', status: 'running', phase: config.PHASES.RIVER, matchId: 'm1',
        config: { sb: 10, bb: 20, ante: 0, maxPlayers: 3 },
        deck: new Deck(), handSeq: 1, buttonSeat: 0, currentBet: 0,
        players: [mk(0, false, 100), mk(1, false, 100), mk(2, true, 40)],
        // 公共牌 K♠ K♦ 7♣ 4♥ 2♠
        communityCards: ['KS', 'KD', '7C', '4H', '2S'].map(card),
        holeCards: {
            u0: ['AH', 'AD'].map(card),     // 两对 AA KK
            u1: ['7H', '7D'].map(card),     // 葫芦 777KK —— 赢
            u2: ['KH', 'KC'].map(card)      // 弃牌者：本来是四条，绝不能泄露
        },
        pot: 240, actions: [], startChips: {}
    };
    roomGames.R = game;
    return { svc, game, emitted };
}

test('摊牌广播里有每一家亮出来的牌型，赢家输家都有', () => {
    const { svc, emitted } = showdownTable();
    svc.doShowdown('R');
    const sd = emitted.find(e => e.ev === 'showdown_reveal').data;
    assert.deepEqual(Object.keys(sd.categories).sort(), ['u0', 'u1'], '只有仍在局的两家');
    assert.deepEqual(sd.winners, ['u1']);
    assert.ok(sd.categories.u0 && sd.categories.u1 && sd.categories.u0 !== sd.categories.u1, JSON.stringify(sd.categories));
    assert.equal(sd.categories.u1, sd.category, '赢家的牌型和原来的 category 字段一致');
});

test('🔴 弃牌者的牌型绝不出现在摊牌广播里（他本来是四条）', () => {
    const { svc, emitted } = showdownTable();
    svc.doShowdown('R');
    const sd = emitted.find(e => e.ev === 'showdown_reveal').data;
    assert.equal(sd.categories.u2, undefined);
    assert.equal(sd.reveals.u2, undefined, '底牌也不在');
    // 换个角度再查一遍：整条广播里不该出现四条这个牌型
    const quads = HandEvaluator.bestHand(['KS', 'KD', '7C', '4H', '2S', 'KH', 'KC'].map(card)).category;
    assert.ok(!JSON.stringify(sd).includes(quads), '整条广播里不该出现弃牌者的牌型：' + quads);
});

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('输家的牌只压暗、不透明（对手的牌是盖在头像上的，一透明头像就透出来）', () => {
    const css = read('public/css/20-table.css');
    const rule = css.match(/\.card\.dim\s*\{([^}]*)\}/);
    assert.ok(rule, '.card.dim 规则不见了');
    assert.ok(!/opacity/.test(rule[1]), '.card.dim 不许再带 opacity：' + rule[1]);
    assert.ok(!/\.seat\.folded\s*\{\s*opacity/.test(css), '弃牌不许再把整个座位（连同亮出的牌）一起调透明');
});

test('桌面信息挂在 #board 里、公共牌下方；不再常驻房间名', () => {
    const html = read('index.html');
    const board = html.slice(html.indexOf('<div id="board">'));
    const boardEnd = board.indexOf('<div id="ring-layer">');
    assert.ok(board.slice(0, boardEnd).includes('id="table-info"'), '#table-info 必须在 #board 里面');
    const css = read('public/css/20-table.css');
    const rule = css.match(/#table-info\s*\{([^}]*)\}/)[1];
    assert.match(rule, /position:\s*absolute/, '绝对定位：不进布局，否则会改变 #board 高度、打乱公共牌的几何');
    assert.match(rule, /top:\s*100%/, '挂在 #board 下沿之外');
    const js = read('public/js/80-table-renderer.js');
    const block = js.slice(js.indexOf("const sng = document.getElementById('table-info')"), js.indexOf('// 公共牌：固定 5 个位置'));
    assert.ok(!block.includes('roomName'), '房间名挪进了比赛设置，桌心不再常驻');
});

test('赢额弹字挂在自己座位左边那一栏，不压住自己的牌', () => {
    const js = read('public/js/50-audio-settings.js');
    const fn = js.slice(js.indexOf('function winPopup'), js.indexOf('function animatePotsToWinners'));
    assert.match(fn, /\.self-info/);
});
