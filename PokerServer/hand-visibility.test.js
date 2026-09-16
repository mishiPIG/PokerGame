'use strict';

// 牌谱可见性（2026-09-17）。
//
// 守的是一条**隐私边界**，所以两个方向都要测：
//   · 漏了 → 同桌事后能查出你弃掉的牌（免费 HUD）；
//   · 过了 → 把本来就该看见的牌也藏了，牌谱回顾当场变空。
//
// ⚠️ 判定规则**刻意与客户端同源**（`42-replay.js`: showFace = isMe || (!folded && showdown)），
//    所以这里的断言同时也是在钉住「服务端和客户端说的是同一件事」。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    filterHandForViewer, tableEndedFrom, wentToShowdown,
} = require('./src/games/poker/hand-visibility');

const ME = 'u-me';
const OPP = 'u-opp';
const THIRD = 'u-3rd';

// 一手牌：默认两人走到摊牌
function hand({ folds = [], seats = [ME, OPP], withFair = true } = {}) {
    return {
        ts: 1, roomId: '1234', handSeq: 5, mode: 'cash',
        seats: seats.map((id, i) => ({
            userId: id, username: id, seat: i, startChips: 1000,
            hole: [id + '-c1', id + '-c2'],
        })),
        actions: folds.map(id => ({ userId: id, street: 'preflop', action: 'fold', amount: 0 })),
        results: seats.map(id => ({
            userId: id, won: 0, endChips: 1000,
            category: id + '-一对', folded: folds.includes(id),
        })),
        community: ['AS', 'KH', 'QD', 'JC', 'TS'],
        ...(withFair ? {
            fair: {
                commit: 'c'.repeat(64), serverSeed: 's'.repeat(64),
                clientSeed: '1234', nonce: 5, deckOrder: ['AS', 'KH'],
            },
        } : {}),
    };
}
const holeOf = (h, id) => (h.seats.find(s => s.userId === id) || {}).hole;
const catOf = (h, id) => (h.results.find(r => r.userId === id) || {}).category;

// ═══ 桌子还没散 ═══

test('🔴 别人弃掉的、从没亮过的底牌，绝不能发给我', () => {
    const out = filterHandForViewer(hand({ folds: [OPP], seats: [ME, OPP, THIRD] }), ME,
        { tableEnded: false });
    assert.equal(holeOf(out, OPP), undefined, '🔴 弃牌者的底牌发出去了 —— 等于送对手一个 HUD');
    assert.equal(catOf(out, OPP), undefined,
        '牌型名是从底牌算出来的，留着等于泄露了一半（「他弃的是同花听」）');
});

test('我自己的牌永远看得见（不然牌谱回顾对我自己也没用了）', () => {
    const out = filterHandForViewer(hand({ folds: [ME] }), ME, { tableEnded: false });
    assert.deepEqual(holeOf(out, ME), [ME + '-c1', ME + '-c2']);
    assert.equal(catOf(out, ME), ME + '-一对');
});

test('走到摊牌、没弃牌的人：牌本来就亮过，照给', () => {
    const out = filterHandForViewer(hand({ folds: [] }), ME, { tableEnded: false });
    assert.deepEqual(holeOf(out, OPP), [OPP + '-c1', OPP + '-c2'], '摊牌过的牌被误藏了');
    assert.equal(catOf(out, OPP), OPP + '-一对');
});

test('🔴 没走到摊牌（对手全弃、无人亮牌）→ 赢家的牌也不能给', () => {
    // 这一手只有 1 人没弃 = 直接收池，他的牌从没亮过
    const h = hand({ folds: [OPP], seats: [ME, OPP] });
    assert.equal(wentToShowdown(h), false, '前提错了：这手不该算摊牌');
    const out = filterHandForViewer(h, OPP, { tableEnded: false });   // 用弃牌方的视角看
    assert.equal(holeOf(out, ME), undefined, '🔴 赢家从没亮过的牌被发出去了');
    assert.deepEqual(holeOf(out, OPP), [OPP + '-c1', OPP + '-c2'], '他自己的牌还是要给');
});

test('🔴 种子和牌序必须扣住 —— 有它就能重算整副牌，上面的过滤全白做', () => {
    const out = filterHandForViewer(hand({ folds: [OPP] }), ME, { tableEnded: false });
    assert.equal(out.fair.serverSeed, undefined, '🔴 种子发出去了');
    assert.equal(out.fair.deckOrder, undefined, '🔴 整副牌序发出去了');
    assert.ok(!JSON.stringify(out).includes('s'.repeat(64)), '种子以别的形式混进了响应');

    // 承诺要留着：玩家事后才能核对「揭示的种子确实对应当时公布的承诺」
    assert.equal(out.fair.commit, 'c'.repeat(64));
    assert.equal(out.fair.clientSeed, '1234');
    assert.equal(out.fair.nonce, 5);
    assert.equal(out.fair.revealPending, true, '要告诉客户端「本桌结束后才可验证」');
});

// ═══ 桌子散了 ═══

test('🔴 桌子结束后一切公开 —— 否则可验证公平就永远验不了', () => {
    const out = filterHandForViewer(hand({ folds: [OPP] }), ME, { tableEnded: true });
    assert.equal(out.fair.serverSeed, 's'.repeat(64), '🔴 散桌后还扣着种子 = 这个功能等于没做');
    assert.deepEqual(out.fair.deckOrder, ['AS', 'KH']);
    assert.deepEqual(holeOf(out, OPP), [OPP + '-c1', OPP + '-c2']);
});

test('不修改入参（同一份牌谱会被多个查看者复用）', () => {
    const h = hand({ folds: [OPP] });
    const before = JSON.stringify(h);
    filterHandForViewer(h, ME, { tableEnded: false });
    assert.equal(JSON.stringify(h), before, '把原始牌谱改坏了 —— 下一个查看者会拿到残缺数据');
});

// ═══ 「桌子散没散」的判定 ═══

test('散桌判定：结束时间 / 状态 / 老牌谱找不到 match 行', () => {
    assert.equal(tableEndedFrom({ status: 'running', ended_at_ms: null }), false);
    assert.equal(tableEndedFrom({ status: 'paused', ended_at_ms: null }), false);
    assert.equal(tableEndedFrom({ status: 'running', ended_at_ms: 123 }), true, '有结束时间就是散了');
    assert.equal(tableEndedFrom({ status: 'finished', ended_at_ms: null }), true);
    assert.equal(tableEndedFrom({ status: 'cancelled', ended_at_ms: null }), true);
    // 老牌谱（SQLite 上线前）没有 match 行 —— 那些桌子早就散了，不存在「还在打」
    assert.equal(tableEndedFrom(null), true);
    assert.equal(tableEndedFrom(undefined), true);
});

test('没有 fair 字段的老牌谱不许崩', () => {
    const out = filterHandForViewer(hand({ folds: [OPP], withFair: false }), ME, { tableEnded: false });
    assert.equal(out.fair, undefined);
    assert.equal(holeOf(out, OPP), undefined, '老牌谱同样要挡住别人的底牌');
});

test('烂输入不许抛（这条路径挂了 = 整个牌谱回顾打不开）', () => {
    for (const bad of [null, undefined, 'x', 42]) {
        assert.doesNotThrow(() => filterHandForViewer(bad, ME, { tableEnded: false }));
    }
    assert.doesNotThrow(() => filterHandForViewer({}, ME, { tableEnded: false }));
});
