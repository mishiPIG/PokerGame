'use strict';

// 注销前的「你还在牌局里吗」闸。
// 漏了这道闸的后果不是报错，是【玩家筹码凭空消失 + 那张牌桌静默坏掉】。

const test = require('node:test');
const assert = require('node:assert/strict');
const { findBlockingRoom } = require('./src/account/deletion-guards');

test('坐在座位上 → 拦住，并且要告诉他是哪一桌', () => {
    const rooms = { 130674: { players: [{ userId: 'u1' }, { userId: 'u2' }] } };
    assert.equal(findBlockingRoom(rooms, 'u1'), '130674');
    assert.equal(findBlockingRoom(rooms, 'u2'), '130674');
});

test('🔴 站起围观也算 —— 他的筹码同样还没结算', () => {
    const rooms = { 200001: { players: [], vacatedPlayers: [{ userId: 'u9' }] } };
    assert.equal(findBlockingRoom(rooms, 'u9'), '200001',
        '只查 players 会放过站起围观的人，而他的筹码同样存在内存里');
});

test('不在任何牌局里 → 放行', () => {
    const rooms = { 1: { players: [{ userId: 'other' }] }, 2: { players: [], vacatedPlayers: [] } };
    assert.equal(findBlockingRoom(rooms, 'me'), null);
});

test('多桌时要把人找出来，而不是只看第一桌', () => {
    const rooms = {
        aaa: { players: [{ userId: 'x' }] },
        bbb: { players: [{ userId: 'y' }] },
        ccc: { players: [{ userId: 'me' }] },
    };
    assert.equal(findBlockingRoom(rooms, 'me'), 'ccc');
});

test('空大厅 / 破损的房间对象都不许抛 —— 抛了就成了「永远删不掉号」', () => {
    assert.equal(findBlockingRoom({}, 'me'), null);
    assert.equal(findBlockingRoom(null, 'me'), null);
    assert.equal(findBlockingRoom(undefined, 'me'), null);
    assert.doesNotThrow(() => findBlockingRoom({ a: null, b: {}, c: { players: [null] } }, 'me'));
});
