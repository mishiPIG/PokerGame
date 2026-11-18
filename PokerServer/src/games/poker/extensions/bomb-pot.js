'use strict';
// Bomb pot（2026-11-18，家庭局玩法）。现金桌房主开关，默认关。
//
// 这一手：不收盲注 / 前注 / straddle，发到牌的每个人先往底池里放同样一笔（付不起就全押），
// 发完底牌【直接到翻牌】，从按钮左手第一位开始正常下注。
//
// 触发两种：「下一手 Bomb pot」（一次性，game.nextBomb）；或者设成每 N 手一次。
// 两种都要全桌投票同意才生效（rooms/rule-vote.js），建房时的初始设置除外
// （按手数算：handSeq 是 N 的倍数那一手 —— 不用另记计数器，重启后照样准）。
//
// 实现上刻意少动：Bomb 的那笔和前注一样直接进底池、不算下注（currentBet 保持 0），
// 然后交给现有的 advanceStage —— 它本来就是「翻前下注结束 → 收池 → 发翻牌 → 从按钮左手开始」，
// 全押跑马、多次发牌、边池都是现成的路径，不长第二套。
const ALLOWED_EVERY = [0, 5, 10, 20];
const ALLOWED_BB = [2, 5, 10];   // 每人放几个大盲（用户 2026-11-18 定：2 / 5 / 10）

function bombConfig(cfg) {
    const every = ALLOWED_EVERY.includes(Number(cfg && cfg.bombEvery)) ? Number(cfg.bombEvery) : 0;
    const bb = ALLOWED_BB.includes(Number(cfg && cfg.bombBB)) ? Number(cfg.bombBB) : 2;
    return { every, bb };
}

// 这一手是不是 Bomb pot（只看房主点的一次性标记和「每 N 手」）
function isBombHand(game, handSeq) {
    if (!game || game.roomType !== 'cash') return false;
    if (game.nextBomb) return true;
    const { every } = bombConfig(game.config);
    return every > 0 && handSeq > 0 && handSeq % every === 0;
}

// 每人放进底池多少（倍数 × 这一手大盲）
function bombAmount(game, bb) { return bombConfig(game.config).bb * bb; }

// 收 Bomb：和前注同一种记法（committed + 底池），不进 currentBet。返回实际收了多少（牌谱用）
function postBomb(game, amount) {
    const posted = {};
    for (const p of game.players) {
        if (p.folded) continue;               // 坐出 / 没发牌的人不参与
        const a = Math.min(amount, p.chips);
        p.chips -= a; p.committed = (p.committed || 0) + a;
        if (p.chips === 0) p.allIn = true;
        posted[p.userId] = a;
    }
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    return posted;
}

module.exports = { ALLOWED_EVERY, ALLOWED_BB, bombConfig, isBombHand, bombAmount, postBomb };
