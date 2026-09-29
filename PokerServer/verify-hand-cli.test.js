'use strict';

// 离线验算器命令行（tools/verify-hand.js）—— 它是给仓库外的玩家用的，结论必须可信。
//
// 🔴 2026-09-29：种子还没公布（整桌没结束）时，它会拿 undefined 去算哈希，
//    然后报「❌ 验证不通过，请反馈」—— 对玩家来说这句话等于「服务器作弊了」。
//    「还不能验」和「验了不对」必须是两个结论、两个退出码。

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { newServerSeed, commitOf, shuffledOrder } = require('./src/games/poker/provably-fair');

const CLI = path.join(__dirname, 'tools/verify-hand.js');
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const ORDERED = [];
for (const s of SUITS) for (const r of RANKS) ORDERED.push(r + s);

// 按真实发牌顺序造一手：每人两张 → 烧 → 翻牌 3 → 烧 → 转 → 烧 → 河
function genuineHand() {
    const serverSeed = newServerSeed();
    const clientSeed = '123456', nonce = 7;
    const deckOrder = shuffledOrder(ORDERED, { serverSeed, clientSeed, nonce });
    const seats = [0, 1, 2].map(i => ({ seat: i, username: 'p' + i, hole: [deckOrder[2 * i], deckOrder[2 * i + 1]] }));
    const b = 6;
    const community = [deckOrder[b + 1], deckOrder[b + 2], deckOrder[b + 3], deckOrder[b + 5], deckOrder[b + 7]];
    return { roomId: '123456', handSeq: nonce, seats, community,
        fair: { commit: commitOf(serverSeed), serverSeed, clientSeed, nonce, deckOrder } };
}
const run = (hand, ...flags) => spawnSync(process.execPath, [CLI, '-', ...flags],
    { input: JSON.stringify(hand), encoding: 'utf8' });

test('真实的一手牌 → 通过（退出码 0）', () => {
    const r = run(genuineHand());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /通过验证/);
});

test('🔴 种子还没公布 → 退出码 2 且说明「还不能验」，绝不能说「验证不通过」', () => {
    const h = genuineHand();
    delete h.fair.serverSeed;
    delete h.fair.deckOrder;
    h.fair.revealPending = true;          // 这正是整桌没结束时接口下发的形态
    for (const flags of [[], ['--en']]) {
        const r = run(h, ...flags);
        assert.equal(r.status, 2, '「还不能验」不是「验了不对」');
        assert.doesNotMatch(r.stdout, /验证不通过|Verification FAILED/,
            '🔴 这句话对玩家的意思是「服务器作弊了」');
        assert.match(r.stdout, flags.length ? /cannot be verified yet/ : /还不能验/);
        assert.match(r.stdout, new RegExp(h.fair.commit), '承诺要照常给出 —— 它在发牌前就公开了');
    }
});

test('牌被改过 → 退出码 1（真正的失败仍然要报出来）', () => {
    const h = genuineHand();
    h.community[2] = h.community[2] === 'AS' ? 'KH' : 'AS';
    const r = run(h);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /验证不通过/);
});

test('承诺被换过 → 退出码 1', () => {
    const h = genuineHand();
    h.fair.commit = commitOf(newServerSeed());
    assert.equal(run(h).status, 1);
});
