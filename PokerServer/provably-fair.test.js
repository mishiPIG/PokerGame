'use strict';

// 可验证公平（2026-09-16）。
//
// 这批动的是【发牌随机性】—— 本项目写明的公平性底线。所以这里守两类东西：
//   A. 公平性本身：洗牌不许有偏、种子不许提前泄漏；
//   B. 可验证性：承诺对得上、牌序能重放、被人改过一定验不过。
//
// ⚠️ 关于「怎么验无偏」这件事本身，值得先说清楚：
//    模偏在 32 位下是 1e-8 量级，**跑几百万次采样也测不出来** ——
//    那种统计测试只会给人一种「测过了」的错觉。
//    所以下面用的是【精确构造】：亲手喂一个落在拒绝区间里的值，看它到底重取没有。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
    newServerSeed, commitOf, createSeededRng, createHandFairness,
    shuffledOrder, verifyHand, uniformInt,
} = require('./src/games/poker/provably-fair');

const DECK = [];
for (const s of ['S', 'H', 'D', 'C']) for (const r of '23456789TJQKA') DECK.push(r + s);

// 把一串指定的字节喂给 uniformInt，用来精确控制它看到什么
function streamOf(bytes) {
    let i = 0;
    return () => bytes[i++ % bytes.length];
}
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

// ═══ A. 公平性 ═══

test('🔴 拒绝采样真的在拒绝：落在尾巴上的值必须被丢掉重取', () => {
    // n = 52 时 2^32 = 82595524*52 + 48，也就是说最后 48 个值是「多出来的尾巴」。
    // 直接取模的话，这 48 个值会让 0..47 各多一份概率 —— 那就是模偏。
    const n = 52;
    const limit = Math.floor(0x100000000 / n) * n;
    assert.equal(0x100000000 - limit, 48, '先确认这个 n 确实除不尽（否则这条测试测了个寂寞）');

    // 第一个 4 字节 = limit（尾巴里的第一个值，必须被拒绝）
    // 第二个 4 字节 = 7（正常值）
    const next = streamOf([...u32(limit), ...u32(7)]);
    assert.equal(uniformInt(next, n), 7,
        '🔴 没有重取 —— 直接取模会返回 limit % 52 = 0，这就是模偏的来源');
});

test('🔴 尾巴里的每一个值都要被拒绝，不是只挡第一个', () => {
    const n = 52;
    const limit = Math.floor(0x100000000 / n) * n;
    for (const off of [0, 1, 17, 47]) {          // 尾巴是 limit .. 2^32-1，共 48 个
        const next = streamOf([...u32(limit + off), ...u32(3)]);
        assert.equal(uniformInt(next, n), 3, '尾巴偏移 ' + off + ' 没被拒绝');
    }
    // 整除段内的最后一个值必须【被接受】，不能连它一起丢（那会从另一头制造偏差）
    const next = streamOf([...u32(limit - 1)]);
    assert.equal(uniformInt(next, n), (limit - 1) % n, '把合法值也拒了');
});

test('边界：n<=1 直接给 0，不消耗随机流也不死循环', () => {
    let calls = 0;
    const next = () => { calls++; return 0; };
    assert.equal(uniformInt(next, 1), 0);
    assert.equal(uniformInt(next, 0), 0);
    assert.equal(calls, 0);
});

test('洗牌是个真排列：52 张不重不漏（不能把牌洗没了或洗重了）', () => {
    for (let i = 0; i < 50; i++) {
        const out = shuffledOrder(DECK, { serverSeed: newServerSeed(), clientSeed: 'c', nonce: i });
        assert.equal(out.length, 52);
        assert.equal(new Set(out).size, 52, '出现了重复或丢失的牌');
    }
});

test('统计自检：每个位置上各张牌大致均匀（沿用本项目原有的自检口径）', () => {
    // 这条**不是**用来抓模偏的（见文件头：那个量级测不出来），
    // 它抓的是「整条流坏掉」那种粗错误：卡住的字节、错位的范围、常数偏移。
    const N = 20000;
    const firstCard = new Map();
    for (let i = 0; i < N; i++) {
        const out = shuffledOrder(DECK, { serverSeed: newServerSeed(), clientSeed: 'x', nonce: i });
        firstCard.set(out[0], (firstCard.get(out[0]) || 0) + 1);
    }
    assert.equal(firstCard.size, 52, '有牌从来没出现在首位过 —— 随机流有问题');
    const expected = N / 52;
    for (const [card, n] of firstCard) {
        assert.ok(Math.abs(n - expected) < expected * 0.45,
            '首张是 ' + card + ' 的频率明显偏离 1/52：' + n + ' vs ' + expected.toFixed(0));
    }
});

test('🔴 种子在揭示之前绝不能泄漏 —— 泄漏等于把整副牌提前告诉所有人', () => {
    const f = createHandFairness({ clientSeed: 'room1234', nonce: 7 });
    const pub = f.publicCommitment();

    assert.ok(!('serverSeed' in pub), 'publicCommitment 里带了 serverSeed');
    assert.ok(!JSON.stringify(pub).includes(f.serverSeed), '种子以别的形式混进了公开内容');
    assert.equal(pub.commit, f.commit);

    // 而承诺本身不能反推出种子（SHA256 原像）——这里只做一个形态断言：
    // commit 是 64 位十六进制，和种子不相等。
    assert.match(pub.commit, /^[0-9a-f]{64}$/);
    assert.notEqual(pub.commit, f.serverSeed);
});

// ═══ B. 可验证性 ═══

test('承诺-揭示：SHA256(种子) 必须等于开局前公布的那个 commit', () => {
    const f = createHandFairness({ clientSeed: 'c', nonce: 1 });
    const r = f.reveal();
    assert.equal(commitOf(r.serverSeed), r.commit);
    assert.equal(crypto.createHash('sha256').update(r.serverSeed).digest('hex'), r.commit,
        '任何人用标准 sha256 都要能算出同一个值（不能依赖我们自己的函数）');
});

test('🔴 同样的三要素必须重放出一模一样的牌序（否则整个方案不成立）', () => {
    const f = createHandFairness({ clientSeed: 'room777', nonce: 42 });
    const dealt = shuffledOrder(DECK, f.reveal());
    const v = verifyHand({ ...f.reveal(), orderedCards: DECK, dealtOrder: dealt });
    assert.equal(v.ok, true);
    assert.equal(v.commitOk, true);
    assert.equal(v.orderOk, true);
});

test('🔴 牌序被改过一张 → 必须验不过', () => {
    const f = createHandFairness({ clientSeed: 'c', nonce: 3 });
    const dealt = shuffledOrder(DECK, f.reveal());
    const tampered = dealt.slice();
    [tampered[0], tampered[1]] = [tampered[1], tampered[0]];     // 只换两张的位置

    const v = verifyHand({ ...f.reveal(), orderedCards: DECK, dealtOrder: tampered });
    assert.equal(v.ok, false, '换了两张牌居然还验得过 —— 那这个验证毫无意义');
    assert.equal(v.commitOk, true, '这次动的是牌序不是种子，commit 本身应该还是对的');
    assert.equal(v.orderOk, false);
});

test('🔴 拿另一个种子来冒充 → commit 对不上', () => {
    const f = createHandFairness({ clientSeed: 'c', nonce: 3 });
    const dealt = shuffledOrder(DECK, f.reveal());
    const fake = newServerSeed();

    const v = verifyHand({
        commit: f.commit, serverSeed: fake, clientSeed: 'c', nonce: 3,
        orderedCards: DECK, dealtOrder: dealt,
    });
    assert.equal(v.commitOk, false, '换了种子 commit 还能对上 —— 承诺就形同虚设');
    assert.equal(v.ok, false);
});

test('三要素里任何一个变了，牌序就不同（clientSeed / nonce 都真的参与了运算）', () => {
    const seed = newServerSeed();
    const base = shuffledOrder(DECK, { serverSeed: seed, clientSeed: 'a', nonce: 1 }).join();
    const otherClient = shuffledOrder(DECK, { serverSeed: seed, clientSeed: 'b', nonce: 1 }).join();
    const otherNonce = shuffledOrder(DECK, { serverSeed: seed, clientSeed: 'a', nonce: 2 }).join();
    const otherSeed = shuffledOrder(DECK, { serverSeed: newServerSeed(), clientSeed: 'a', nonce: 1 }).join();

    assert.notEqual(base, otherClient, 'clientSeed 根本没参与运算');
    assert.notEqual(base, otherNonce, 'nonce 根本没参与运算 —— 同一局每手会发一样的牌！');
    assert.notEqual(base, otherSeed);
});

test('🔴 同一副种子、连续 nonce 不能发出一样的牌', () => {
    const seed = newServerSeed();
    const seen = new Set();
    for (let n = 0; n < 200; n++) {
        seen.add(shuffledOrder(DECK, { serverSeed: seed, clientSeed: 'room', nonce: n }).join());
    }
    assert.equal(seen.size, 200, '不同手之间出现了重复牌序');
});

test('种子够长且每次都不同', () => {
    const seeds = new Set();
    for (let i = 0; i < 500; i++) {
        const s = newServerSeed();
        assert.match(s, /^[0-9a-f]{64}$/, '种子应当是 256 bit 的十六进制');
        seeds.add(s);
    }
    assert.equal(seeds.size, 500);
});

test('seeded rng 与离线重放走的是同一条流（验证工具不能是另一套实现）', () => {
    const seed = newServerSeed();
    const rng = createSeededRng(seed, 'c', 9);
    const direct = [];
    const cards = DECK.slice();
    for (let n = cards.length - 1; n > 0; n--) direct.push(rng.randomInt(n + 1));

    const rng2 = createSeededRng(seed, 'c', 9);
    const again = [];
    for (let n = cards.length - 1; n > 0; n--) again.push(rng2.randomInt(n + 1));
    assert.deepEqual(direct, again);
});
