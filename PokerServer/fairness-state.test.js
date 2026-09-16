'use strict';

// 可验证公平：**种子绝不能提前离开服务器**（2026-09-16）。
//
// 这是整个方案里唯一一个「做错了比不做还糟」的点：
// 本手的 serverSeed 一旦出现在广播里，任何人都能当场算出整副牌 ——
// 包括还没发出来的公共牌和别人的底牌。
//
// 所以这里不测「功能对不对」，只测一件事：
// **凡是发给客户端的东西，都不许含有当前这手的 serverSeed。**

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatePresenter } = require('./src/games/poker/state-presenter');
const { newServerSeed, commitOf } = require('./src/games/poker/provably-fair');

const PHASES = { WAITING: 'waiting', PREFLOP: 'preflop', SHOWDOWN: 'showdown' };

// 抓住 broadcastState 真正发出去的那个对象
function captureBroadcast(game) {
    const sent = [];
    const io = {
        in: () => ({ emit: (evt, payload) => sent.push({ evt, payload }) }),
        to: () => ({ emit: (evt, payload) => sent.push({ evt, payload }) }),
        sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
    };
    const roomGames = { r1: game };
    const presenter = createStatePresenter({
        io, db: { matches: {} }, roomGames, PHASES,
        gameSB: () => 10, gameBB: () => 20, gameAnte: () => 0,
        ACTION_TIME: 18000, EXTRA_MAX: 120000,
        livePots: () => [], HandEvaluator: null,
        persistence: { commit() { /* 测试里不落库 */ } },
    });
    presenter.broadcastState('r1');
    return sent;
}

function baseGame(fair) {
    return {
        matchId: 'm1', roomId: 'r1', roomType: 'cash', status: 'running',
        phase: PHASES.PREFLOP, players: [], communityCards: [], holeCards: {},
        pot: 0, currentBet: 0, actionOnIdx: -1, buttonIdx: 0, handSeq: 3,
        vacatedPlayers: [], statsHistory: [], fair,
    };
}

test('🔴 本手的 serverSeed 绝不能出现在广播里（否则整副牌当场泄漏）', () => {
    const serverSeed = newServerSeed();
    const game = baseGame({
        serverSeed,
        commit: commitOf(serverSeed),
        clientSeed: 'room1234',
        nonce: 3,
        deckOrder: ['AS', 'KH', 'QD'],     // 真实牌序，同样是机密
    });

    const sent = captureBroadcast(game);
    assert.ok(sent.length > 0, '没广播出任何东西，这条测试就白写了');

    const blob = JSON.stringify(sent);
    assert.ok(!blob.includes(serverSeed), '🔴 serverSeed 泄漏到了广播里');
    assert.ok(!blob.includes('deckOrder'), '🔴 整副牌序泄漏到了广播里');
    assert.ok(!blob.includes('"AS","KH"'), '🔴 牌序内容泄漏到了广播里');
});

test('承诺本身要发出去 —— 不发的话玩家事后没法验证', () => {
    const serverSeed = newServerSeed();
    const commit = commitOf(serverSeed);
    const game = baseGame({ serverSeed, commit, clientSeed: 'room1234', nonce: 3, deckOrder: null });

    const state = captureBroadcast(game).find(m => m.evt === 'game_state');
    assert.ok(state, '没有 game_state');
    assert.ok(state.payload.fair, 'state 里没有 fair 字段');
    assert.equal(state.payload.fair.commit, commit);
    assert.equal(state.payload.fair.clientSeed, 'room1234');
    assert.equal(state.payload.fair.nonce, 3);
    assert.ok(!('serverSeed' in state.payload.fair), 'fair 里带上了 serverSeed');
});

test('上一手的揭示可以发（那手已经打完了，种子作废了）', () => {
    const oldSeed = newServerSeed();
    const curSeed = newServerSeed();
    const game = baseGame({
        serverSeed: curSeed, commit: commitOf(curSeed), clientSeed: 'c', nonce: 4, deckOrder: null,
        lastReveal: {
            commit: commitOf(oldSeed), serverSeed: oldSeed,
            clientSeed: 'c', nonce: 3, deckOrder: ['AS', 'KH'],
        },
    });

    const state = captureBroadcast(game).find(m => m.evt === 'game_state');
    assert.ok(state.payload.lastReveal, '上一手的揭示没发出去，玩家就没东西可验');
    assert.equal(state.payload.lastReveal.serverSeed, oldSeed);
    // 但当前这手的种子仍然不许出现
    assert.ok(!JSON.stringify(state.payload).includes(curSeed), '当前这手的种子泄漏了');
});

test('还没开始的房间（没有 fair）不许崩', () => {
    const game = baseGame(null);
    const state = captureBroadcast(game).find(m => m.evt === 'game_state');
    assert.equal(state.payload.fair, null);
    assert.equal(state.payload.lastReveal, null);
});
