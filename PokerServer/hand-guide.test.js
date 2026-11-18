'use strict';
// 新手引导（2026-11-17）：牌型大小速查表里的每一组示例牌，必须【真的是】它旁边写的那个牌型，
// 而且从上到下真的是从大到小。教新手的东西写错一张牌，比没有更糟。
// 用的是服务端真正判牌的那套评估器，不是另写一份。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { HandEvaluator } = require('./PokerLogic');

const SRC = fs.readFileSync(path.join(__dirname, 'public/js/44-guide.js'), 'utf8');
const ctx = { window: { addEventListener() {} }, onLangChange() {}, localStorage: { getItem: () => null } };
vm.createContext(ctx);
vm.runInContext(SRC + '\n;this.__guide = HAND_GUIDE;', ctx);
const GUIDE = ctx.__guide;
// 和游戏里的牌同一个格式（花色是完整单词，见 PokerLogic.js 的 Deck）
const SUITS = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const card = (s) => ({ rank: s.slice(0, -1), suit: SUITS[s.slice(-1)] });

test('十种牌型都在，示例牌各五张、互不重复', () => {
    assert.equal(GUIDE.length, 10);
    for (const h of GUIDE) {
        assert.equal(h.cards.length, 5, h.cat);
        assert.equal(new Set(h.cards).size, 5, h.cat + ' 里有重复的牌');
        assert.ok(h.zh && h.en, h.cat + ' 缺中文或英文说明');
    }
});

test('🔴 每组示例牌用真评估器判出来，就是它旁边写的牌型', () => {
    for (const h of GUIDE) {
        const got = HandEvaluator.bestHandFrom(h.cards.map(card)).category;
        assert.equal(got, h.cat, `${h.cards.join(' ')} 判出来是「${got}」，表上写的是「${h.cat}」`);
    }
});

test('🔴 从上到下真的是从大到小（分数越小牌越强）', () => {
    const score = (cs) => HandEvaluator.bestHandFrom(cs.map(card)).score;
    for (let i = 1; i < GUIDE.length; i++) {
        const a = score(GUIDE[i - 1].cards), b = score(GUIDE[i].cards);
        assert.ok(a < b, `${GUIDE[i - 1].cat} 应该比 ${GUIDE[i].cat} 大`);
    }
});
