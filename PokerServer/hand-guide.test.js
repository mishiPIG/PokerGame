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

// ───────── 短牌那一版（2026-11-19）─────────
test('🔴 短牌速查表：每组示例牌用短牌评估器判出来就是写的牌型、从大到小、一张 2–5 都没有', () => {
    const c2 = { window: { addEventListener() {} }, onLangChange() {}, localStorage: { getItem: () => null } };
    vm.createContext(c2);
    vm.runInContext(SRC + '\n;this.__sd = HAND_GUIDE_SD;', c2);
    const rows = c2.__sd;
    const sd = require('./src/games/poker/variants/shortdeck');
    assert.equal(rows.length, 10);
    let prev = -1;
    for (const h of rows) {
        assert.ok(h.cards.every(c => !'2345'.includes(c[0])), `${h.cat} 的示例牌里有 2–5（短牌里没有这些牌）`);
        assert.equal(new Set(h.cards).size, 5, h.cat + ' 里有重复的牌');
        const s = sd._score5(h.cards.map(card));
        assert.equal(sd.category(s), h.cat, `示例牌 ${h.cards.join(' ')} 在短牌里其实是「${sd.category(s)}」`);
        assert.ok(s > prev, `${h.cat} 应当比上一行小`);
        prev = s;
    }
    // 和德州那一版的区别正好就是这两处
    const order = rows.map(r => r.cat);
    assert.ok(order.indexOf('同花') < order.indexOf('葫芦'));
    assert.ok(order.indexOf('顺子') < order.indexOf('三条'), '顺子 > 三条（官方规则，和德州一样）');
});

// ───────── 三个玩法分页 + 奥马哈常见误判 + 第一次进短牌 / 奥马哈桌的规则卡（2026-11-19）─────────
// 用户：「牌型大小里只显示德州的，没有短牌的」—— 原来只在短牌房间里打开才是短牌版，在大厅永远是德州。
function loadGuide() {
    const c3 = { window: { addEventListener() {} }, onLangChange() {}, localStorage: { getItem: () => null } };
    vm.createContext(c3);
    vm.runInContext(SRC + '\n;this.__g = { GUIDE_VARIANTS, PLO_MISREADS, HAND_GUIDE_SD, VARIANT_INTRO };', c3);
    return c3.__g;
}

test('速查表三个分页正好对应服务端的三种玩法；规则卡给短牌和奥马哈（德州不用）', () => {
    const { VARIANTS } = require('./src/games/poker/variants');
    const g = loadGuide();
    assert.deepEqual([...g.GUIDE_VARIANTS].sort(), Object.keys(VARIANTS).sort());
    assert.deepEqual(Object.keys(g.VARIANT_INTRO).sort(), Object.keys(VARIANTS).filter(v => v !== 'nlhe').sort());
    for (const v of Object.keys(g.VARIANT_INTRO)) {
        const it = g.VARIANT_INTRO[v];
        assert.ok(it.zh && it.en && it.title.zh && it.title.en, v);
    }
});

test('🔴 奥马哈「常见误判」：按奥马哈规则判出来就是写的「其实是」，9 张里随便挑 5 张就是写的「看着像」', () => {
    const plo = require('./src/games/poker/variants/plo');
    const { PLO_MISREADS } = loadGuide();
    assert.ok(PLO_MISREADS.length >= 3);
    for (const m of PLO_MISREADS) {
        assert.equal(m.hole.length, 4); assert.equal(m.board.length, 5);
        assert.equal(new Set([...m.hole, ...m.board]).size, 9, '有重复的牌');
        const is = plo.best(m.board.map(card), m.hole.map(card)).category;
        assert.equal(is, m.is, `${m.hole.join(' ')} / ${m.board.join(' ')} 在奥马哈里其实是「${is}」`);
        const looks = HandEvaluator.bestHandFrom([...m.hole, ...m.board].map(card)).category;
        assert.equal(looks, m.looks, `不按奥马哈规则看是「${looks}」`);
        assert.notEqual(m.is, m.looks);
    }
});

test('短牌里标「和德州不同」的正好是同花顺 / 同花 / 顺子', () => {
    const { HAND_GUIDE_SD } = loadGuide();
    assert.deepEqual([...HAND_GUIDE_SD.filter(h => h.diff).map(h => h.cat)], ['同花顺', '同花', '顺子']);   // 展开一下：vm 里的数组原型不同，严格比较会误报
});

test('规则卡挂好了：每次画牌桌都检查、回大厅收起（不算看过）、三步新手提示等它关了再出', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    assert.match(read('public/js/80-table-renderer.js'), /maybeShowVariantIntro\(state\)/);
    const room = read('public/js/30-room.js');
    const lobby = room.slice(room.indexOf('function showLobby'), room.indexOf('function showLobby') + 1200);
    assert.match(lobby, /closeVariantIntro\(false\)/);
    assert.match(SRC, /if \(variantIntroOpen\(\)\) \{ setTimeout\(tryStart, 1000\); return; \}/);
    // 在大厅打开速查表默认德州、在牌桌里默认这一桌的玩法；打开时可以指定
    assert.match(SRC, /guideVariant = GUIDE_VARIANTS\.includes\(v\) \? v : tableVariantNow\(\);/);
    assert.match(read('index.html'), /<div id="hg-tabs" class="hg-tabs"><\/div>\s*<div id="hg-list"><\/div>/);
});
