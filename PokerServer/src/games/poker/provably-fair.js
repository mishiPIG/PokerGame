'use strict';

// 可验证公平（provably fair，2026-09-16）。
//
// 解决的是一个**我们自己无法自证清白**的问题：朋友局里「这牌怎么又是你赢」是玩笑，
// 但只要牌是服务器发的，服务器理论上就能在看到底牌之后再决定发什么。
// 现在的洗牌其实已经很干净了（每手重洗 + Fisher-Yates + crypto CSPRNG），
// 可**玩家没有任何办法验证这一点** —— 他只能选择相信我。
//
// 做法是标准的承诺-揭示（commit-reveal）：
//   ① 发牌【之前】，服务器公布 commit = SHA256(serverSeed)，此时谁都看不出牌序；
//   ② 整副牌完全由 (serverSeed, clientSeed, nonce) 决定性地算出来，没有别的随机源；
//   ③ 这手牌结束后，服务器公布 serverSeed。
// 于是任何人都能离线验算两件事：SHA256(公布的种子) 是否等于开局前那个 commit、
// 以及用它重新洗一遍是不是得到一模一样的牌序。
// **服务器在 ① 之后就被自己锁死了** —— 它没法在看到底牌之后换一副牌，
// 因为换了 commit 就对不上，而 commit 是发牌前就发给全桌的。
//
// clientSeed 由玩家提供（默认用房间码+手数），作用是让玩家确信
// **服务器也不能提前挑一个对自己有利的 serverSeed** —— 它得在不知道 clientSeed 的
// 情况下先承诺。（朋友局里这条偏理论，但正是它让整个方案成立。）
//
// ⚠️⚠️ 这个文件动了【发牌随机性】，而那是本项目写明的公平性底线。两条铁律：
//
// 1) **绝不能引入模偏（modulo bias）**。原来的 `crypto.randomInt(n+1)` 自带无偏保证，
//    换成自己的种子流之后，如果图省事写 `字节 % (n+1)`，牌就会**系统性地偏向前面几张**
//    —— 而且看不出任何异常，测一万把也只是「感觉某些牌多一点」。
//    所以下面用**拒绝采样**：落在不能整除的尾巴上就重取。
//
// 2) **serverSeed 在这手牌结束前绝对不能出现在任何发给客户端的东西里**。
//    泄漏了就等于把整副牌提前告诉所有人 —— 比不做这个功能糟糕一万倍。
//    这条靠 `publicCommitment()` 只吐 commit、以及一条专门的测试守着。

const crypto = require('crypto');

const SEED_BYTES = 32;   // 256 bit，足够；也是 SHA256 的天然宽度

function newServerSeed() {
    return crypto.randomBytes(SEED_BYTES).toString('hex');
}

function commitOf(serverSeed) {
    return crypto.createHash('sha256').update(String(serverSeed)).digest('hex');
}

// 每手一条独立的密钥流：把 (serverSeed, clientSeed, nonce) 揉进 HMAC。
// 用 HMAC 而不是简单拼接后哈希，是为了避免长度扩展那一类的构造问题。
function streamKey(serverSeed, clientSeed, nonce) {
    return crypto.createHmac('sha256', Buffer.from(String(serverSeed), 'hex'))
        .update(String(clientSeed) + ':' + String(nonce))
        .digest();
}

// 确定性随机源。接口刻意做成和 `crypto.randomInt(maxExclusive)` 一样，
// 这样 Fisher-Yates 那段代码一个字都不用改，只是把随机源换掉。
function createSeededRng(serverSeed, clientSeed, nonce) {
    const key = streamKey(serverSeed, clientSeed, nonce);
    let counter = 0;
    let block = Buffer.alloc(0);
    let pos = 0;

    function nextByte() {
        if (pos >= block.length) {
            block = crypto.createHmac('sha256', key).update('ctr:' + counter).digest();
            counter++;
            pos = 0;
        }
        return block[pos++];
    }

    return { randomInt: (maxExclusive) => uniformInt(nextByte, maxExclusive) };
}

// [0, maxExclusive) 上的**均匀**整数，拒绝采样。
//
// 🔴 为什么不能直接 `% n`：2^32 通常不是 n 的整数倍，取模会让**前 (2^32 mod n) 个值
//    各多出一份概率**。对 n=52 这点偏差是 1e-8 量级、统计上根本测不出来 ——
//    也就是说【靠跑几百万次采样去验它是徒劳的，只会给人一种测过了的错觉】。
//    所以这里把取样逻辑单独拿出来、把字节源做成参数，
//    让测试能**精确地**喂一个落在拒绝区间里的值，直接验「它到底有没有重取」。
//    （见 provably-fair.test.js 里那条，以及它的反向对照。）
function uniformInt(nextByte, maxExclusive) {
    const n = Math.floor(maxExclusive);
    if (!(n > 1)) return 0;
    const limit = Math.floor(0x100000000 / n) * n;   // 2^32 里能被 n 整除的那一段
    for (;;) {
        const v = ((nextByte() << 24) | (nextByte() << 16) | (nextByte() << 8) | nextByte()) >>> 0;
        if (v < limit) return v % n;                 // 落在整除段内才用
        // 落在尾巴上：丢掉重取。丢掉的概率 < n/2^32，实际几乎不会发生。
    }
}

// 房间创建时就备下的第一份承诺。
// 意义在于让【第一手】的 commit 也先于发牌公开 ——
// 否则第一手的承诺和发牌是同一瞬间，那一手就少了一层保障。
function initialFair() {
    const serverSeed = newServerSeed();
    return { serverSeed, commit: commitOf(serverSeed), clientSeed: null, nonce: 0, deckOrder: null };
}

// 一手牌的公平上下文。
// 注意 serverSeed 存在这个对象上，**它绝不能被 JSON.stringify 到客户端去** ——
// 快照序列化和 state 下发都只走 publicCommitment()。
function createHandFairness({ clientSeed, nonce, serverSeed = newServerSeed() }) {
    return {
        serverSeed,
        clientSeed: String(clientSeed),
        nonce: Number(nonce) || 0,
        commit: commitOf(serverSeed),
        rng: createSeededRng(serverSeed, clientSeed, nonce),

        // 发牌前能给出去的全部内容：只有承诺，没有种子。
        publicCommitment() {
            return { commit: this.commit, clientSeed: this.clientSeed, nonce: this.nonce };
        },
        // 这手牌结束之后才能调。
        reveal() {
            return {
                commit: this.commit, clientSeed: this.clientSeed,
                nonce: this.nonce, serverSeed: this.serverSeed,
            };
        },
    };
}

// 离线验算用：给定一副按 reset() 顺序排好的牌 + 揭示出来的三要素，
// 重放同一套 Fisher-Yates，应当得到与当时完全一致的牌序。
function shuffledOrder(orderedCards, { serverSeed, clientSeed, nonce }) {
    const rng = createSeededRng(serverSeed, clientSeed, nonce);
    const cards = orderedCards.slice();
    for (let n = cards.length - 1; n > 0; n--) {
        const k = rng.randomInt(n + 1);
        const t = cards[k]; cards[k] = cards[n]; cards[n] = t;
    }
    return cards;
}

// 验证一手牌：commit 对不对得上种子，牌序能不能重放出来。
function verifyHand({ commit, serverSeed, clientSeed, nonce, orderedCards, dealtOrder }) {
    const commitOk = commitOf(serverSeed) === commit;
    const replay = shuffledOrder(orderedCards, { serverSeed, clientSeed, nonce });
    const orderOk = Array.isArray(dealtOrder)
        && replay.length === dealtOrder.length
        && replay.every((c, i) => c === dealtOrder[i]);
    return { ok: commitOk && orderOk, commitOk, orderOk, replay };
}

module.exports = {
    newServerSeed, commitOf, createSeededRng, createHandFairness, uniformInt, initialFair,
    shuffledOrder, verifyHand, SEED_BYTES,
};
