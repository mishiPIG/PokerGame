// PokerLogic.js
const LookupTables = require('./LookupTables');
const crypto = require('crypto');   // 密码学安全随机源（洗牌用，不可预测、无偏）

class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
    }
    toString() { return `${this.suit} - ${this.rank}`; }
}

class Deck {
    constructor() {
        this.cards = [];
        this.reset();
        this.shuffle();
    }
    reset() {
        const suits = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
        const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']; 
        this.cards = [];
        for (let suit of suits) {
            for (let rank of ranks) {
                this.cards.push(new Card(suit, rank));
            }
        }
    }
    // Fisher-Yates 无偏洗牌。默认随机源是 crypto（CSPRNG，不可预测），
    // crypto.randomInt 本身就是无模偏的均匀整数。
    //
    // 可传入 rng 把随机源换成【种子推出来的确定性流】（可验证公平，2026-09-16）。
    // 接口故意做成和 crypto.randomInt 一样，所以**洗牌算法本身一个字都没改**：
    // 换的只是那一行里的随机源。不传则行为与以前完全一致。
    // ⚠️ rng 必须同样是无模偏的（见 provably-fair.js 的拒绝采样）——
    //    随便给个 `字节 % n` 会让牌系统性地偏向前面几张，而且看不出任何异常。
    shuffle(rng = null) {
        const nextInt = rng ? (m) => rng.randomInt(m) : (m) => crypto.randomInt(m);
        for (let n = this.cards.length - 1; n > 0; n--) {
            const k = nextInt(n + 1);   // [0, n] 均匀
            const temp = this.cards[k];
            this.cards[k] = this.cards[n];
            this.cards[n] = temp;
        }
        this.lastShuffleId = crypto.randomBytes(4).toString('hex');   // 每手唯一标识，便于审计/确认确有重洗
    }
    drawCard() {
        if (this.cards.length === 0) return null;
        return this.cards.shift();
    }
}

// Cactus Kev 辅助对象
const CactusKev = {
    Primes: [ 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41 ],
    RankMap: { '2':0, '3':1, '4':2, '5':3, '6':4, '7':5, '8':6, '9':7, 'T':8, 'J':9, 'Q':10, 'K':11, 'A':12 },
    SuitMap: { 'Spades':1, 'Hearts':2, 'Diamonds':4, 'Clubs':8 },
    
    getCardInt: function(card) {
        let r = this.RankMap[card.rank];
        let p = this.Primes[r];
        let s = this.SuitMap[card.suit];
        let b = 1 << r;
        return (b << 16) | (s << 12) | (r << 8) | p;
    }
};

// 判牌器
const HandEvaluator = {
    evaluate7Cards: function(sevenCards) {
        let bestScore = 9999;
        for (let i = 0; i < 21; i++) {
            let current5Cards = [
                sevenCards[LookupTables.Perm7[i][0]],
                sevenCards[LookupTables.Perm7[i][1]],
                sevenCards[LookupTables.Perm7[i][2]],
                sevenCards[LookupTables.Perm7[i][3]],
                sevenCards[LookupTables.Perm7[i][4]]
            ];
            let currentScore = this.evaluate5Cards(current5Cards);
            if (currentScore < bestScore) {
                bestScore = currentScore;
            }
        }
        return bestScore;
    },

    evaluate5Cards: function(fiveCards) {
        let c1 = CactusKev.getCardInt(fiveCards[0]);
        let c2 = CactusKev.getCardInt(fiveCards[1]);
        let c3 = CactusKev.getCardInt(fiveCards[2]);
        let c4 = CactusKev.getCardInt(fiveCards[3]);
        let c5 = CactusKev.getCardInt(fiveCards[4]);

        let q = (c1 | c2 | c3 | c4 | c5) >>> 16; 
        
        if ((c1 & c2 & c3 & c4 & c5 & 0xF000) !== 0) {
            return LookupTables.Flushes[q];
        }

        let uniqueScore = LookupTables.Unique5[q];
        if (uniqueScore !== 0) {
            return uniqueScore;
        }

        let primeProduct = (c1 & 0xFF) * (c2 & 0xFF) * (c3 & 0xFF) * (c4 & 0xFF) * (c5 & 0xFF);
        return this.findScoreByPerfectHash(primeProduct);
    },

    // JS 版 Paul Senzee 完美哈希 (注意 >>> 0 防止符号位导致负数)
    findScoreByPerfectHash: function(u) {
        u = u >>> 0;
        u = (u + 0xe91aaa35) >>> 0;
        u ^= (u >>> 16);
        u = (u + (u << 8)) >>> 0;
        u ^= (u >>> 4);
        let b = (u >>> 8) & 0x1ff;
        let a = (u + (u << 2)) >>> 19;
        let r = a ^ LookupTables.HashAdjust[b];
        return LookupTables.HashValues[r];
    },

    // 从 7 张牌中取出构成最强牌的 5 张：返回 { score, indices(5 个，指向 sevenCards), category }
    bestHand: function(sevenCards) {
        let bestScore = 9999, bestPerm = null;
        for (let i = 0; i < 21; i++) {
            const idx = LookupTables.Perm7[i];
            const five = [sevenCards[idx[0]], sevenCards[idx[1]], sevenCards[idx[2]], sevenCards[idx[3]], sevenCards[idx[4]]];
            const s = this.evaluate5Cards(five);
            if (s < bestScore) { bestScore = s; bestPerm = idx; }
        }
        return { score: bestScore, indices: [...bestPerm], category: this.handCategory(bestScore) };
    },

    // 从任意 5~7 张牌中取最强 5 张：返回 { score, indices, category }
    bestHandFrom: function(cards) {
        const n = cards.length;
        if (n < 5) return null;
        let bestScore = 9999, bestIdx = null;
        for (let a = 0; a < n - 4; a++)
        for (let b = a + 1; b < n - 3; b++)
        for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
        for (let e = d + 1; e < n; e++) {
            const s = this.evaluate5Cards([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (s < bestScore) { bestScore = s; bestIdx = [a, b, c, d, e]; }
        }
        return { score: bestScore, indices: bestIdx, category: this.handCategory(bestScore) };
    },

    // 分数 → 牌型名（Cactus Kev 标准分段，分数越小越强）
    handCategory: function(score) {
        if (score === 1)    return '皇家同花顺';
        if (score <= 10)    return '同花顺';
        if (score <= 166)   return '四条';
        if (score <= 322)   return '葫芦';
        if (score <= 1599)  return '同花';
        if (score <= 1609)  return '顺子';
        if (score <= 2467)  return '三条';
        if (score <= 3325)  return '两对';
        if (score <= 6185)  return '一对';
        return '高牌';
    }
};

module.exports = { Card, Deck, HandEvaluator };