'use strict';
// 「玩法」层（2026-11-19，短牌 / 奥马哈第 1 期）。设计见 docs/feat/game-variants/PLAN.md §4。
//
// 每种玩法一个文件，统一接口：
//   id          'nlhe' | 'shortdeck' | 'plo'
//   holeCount   每人几张底牌
//   ranks       牌堆点数（短牌是 6..A）
//   betLimit    'nl' 无限注 | 'pl' 底池限注
//   score(board, hole)        分数，越小越强（三种玩法都保持这一条，比较大小的代码不用改）
//   best(board, hole)         最强组合 { score, category, boardIdx, holeIdx }（公共牌 5 张时）
//   bestPartial(board, hole)  公共牌 3–5 张时的当前最强组合（牌型提示、牌谱牌型名）
//   category(score)           分数 → 牌型名
//
// 玩法存在 game.config.variant，建房后不可改。没写 = 德州（老房间、老牌谱都按德州）。
const holdem = require('./holdem');
const shortdeck = require('./shortdeck');
const plo = require('./plo');

const VARIANTS = { nlhe: holdem, shortdeck, plo };

// 🔴 必须用 Object.hasOwn，不能写 VARIANTS[id]：'constructor' / '__proto__' / 'toString' 这类名字
//    是每个普通对象都自带的，VARIANTS[id] 会取到 Object / 函数，「有没有」的判断就被骗过去了。
//    2026-11-19 对抗测试实测：建房 variant:'constructor' → 一张牌都不发、摊牌抛错、底池结不了。
const known = (id) => typeof id === 'string' && Object.hasOwn(VARIANTS, id);
function variantById(id) { return known(id) ? VARIANTS[id] : holdem; }
function variantOf(game) { return variantById(game && game.config && game.config.variant); }
// 建房时收的玩法：只认登记过的，其它一律当德州
function normalizeVariant(id) { return known(id) ? id : 'nlhe'; }

// 这位玩家这一次最多能把注下到 / 加到多少。
//   无限注：全下额（chips + 本街已下）——和原来一模一样。
//   底池限注：跟注之后的底池大小再加上去 = 当前注 + (底池 + 桌上所有本街下注 + 他要跟的那部分)；
//            首注（当前注为 0）就是底池。筹码不够就是全下（短码全押照常允许）。
// 服务端校验和客户端的滑条 / 快捷按钮 / 数字键盘 / 快捷键都按这一个数，不各算各的。
function maxBetTo(game, player) {
    const allIn = player.currentBet + player.chips;
    if (variantOf(game).betLimit !== 'pl') return allIn;
    const onTable = (game.players || []).reduce((s, p) => s + (p.currentBet || 0), 0);
    const toCall = Math.max(0, game.currentBet - player.currentBet);
    return Math.min(allIn, game.currentBet + (game.pot || 0) + onTable + toCall);
}

module.exports = { VARIANTS, variantOf, variantById, normalizeVariant, maxBetTo };
