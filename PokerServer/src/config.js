const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PHASES = {
    WAITING: 'waiting', PREFLOP: 'preflop', FLOP: 'flop',
    TURN: 'turn', RIVER: 'river', SHOWDOWN: 'showdown'
};
const DEFAULT_SMALL_BLIND = 10;
const DEFAULT_BIG_BLIND = 20;
const ACTION_TIME = 18000;
// 房主建房时可选的思考时间（秒）。默认还是 18 —— 新手觉得紧的话房主可以放宽（2026-11-17 玩家视角复盘 P6）。
const ACTION_TIME_CHOICES = [15, 18, 20, 30];
const pickActionTimeSec = (v) => (ACTION_TIME_CHOICES.includes(+v) ? +v : ACTION_TIME / 1000);
// 这一桌每次行动给多少毫秒。老房间（快照里没有这个字段）照旧 18 秒。
const actionTimeOf = (game) => pickActionTimeSec(game && game.config && game.config.actionTimeSec) * 1000;
const EXTRA_STEP = 15000;
const EXTRA_MAX = 120000;
const RUNOUT_DELAY = 1400;
const RUNIT_MAX = 5;
const RUNIT_DECIDE_MS = 45000;   // 多次发牌决策窗口（25s→45s，给足反应时间；落后方选号后会为领先方重置一次）
const STRADDLE_DECISION_MS = 15000;
const STRADDLE_INTERMISSION_MS = 4500;
const SNG_BUYIN_TIERS = [110, 220, 550, 1100];
const BUYIN_RATE = 0.11;
const CASHOUT_RATE = 0.10;
const CONFIGURED_PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const STANDARD_BLIND_LEVELS = [
    { sb: 25, bb: 50 }, { sb: 50, bb: 100 }, { sb: 75, bb: 150 },
    { sb: 100, bb: 200 }, { sb: 150, bb: 300 }, { sb: 200, bb: 400 },
    { sb: 300, bb: 600 }, { sb: 400, bb: 800 }, { sb: 500, bb: 1000 },
    { sb: 600, bb: 1200 }, { sb: 800, bb: 1600 }, { sb: 1000, bb: 2000 },
    { sb: 1500, bb: 3000 }, { sb: 2000, bb: 4000 }, { sb: 3000, bb: 6000 }
];

function loadJwtSecret(baseDir) {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
    const keyPath = path.join(baseDir, 'secret.key');
    try {
        if (fs.existsSync(keyPath)) {
            const key = fs.readFileSync(keyPath, 'utf8').trim();
            if (key.length >= 16) return key;
        }
    } catch {}
    const key = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(keyPath, key, { mode: 0o600 }); console.log('🔐 已生成新的 JWT 私章 secret.key（旧登录令牌将失效，需重新登录一次）'); }
    catch (error) { console.error('⚠️ 无法写入 secret.key，本次用内存随机密钥（重启会掉登录）：', error.message); }
    return key;
}

function gameSB(game) {
    if (game.roomType === 'cash') return game.config.sb;
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].sb;
    return DEFAULT_SMALL_BLIND;
}
function gameBB(game) {
    if (game.roomType === 'cash') return game.config.bb;
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].bb;
    return DEFAULT_BIG_BLIND;
}
function gameAnte(game) { return (game.roomType === 'cash' && game.config.ante) ? game.config.ante : 0; }
function timeCardsFor(game, chips) {
    const buyInBB = chips / (gameBB(game) || 1);
    return game.roomType === 'cash' ? Math.round(buyInBB * 0.25) : Math.max(6, Math.round(buyInBB * 0.1));
}
function sngPrize(pool) { return Math.floor((pool || 0) * 10 / 11); }
// SNG 按名次发奖（2026-11-18 用户定）。原来不管几个人开都是冠军一个人拿走整个奖池。
// 抽水照旧先从奖池里扣（sngPrize = 奖池 × 10/11），剩下的按人数分：
//   2 人：冠军全拿 / 3 人：冠军 2 份、亚军 1 份（亚军拿回自己那份）/ 4–6 人：65% / 35% / 7–9 人：50% / 30% / 20%
// 除不尽的零头给冠军，保证各名次加起来正好等于抽水后的奖池。
// ⚠️ 客户端 30-room.js 的 sngPayoutsView 是同一张表（建房表单显示用），sng-payout.test.js 核对两边一致。
function sngPayoutShares(entrants) {
    if (entrants <= 2) return [1];
    if (entrants === 3) return [2 / 3, 1 / 3];
    if (entrants <= 6) return [0.65, 0.35];
    return [0.5, 0.3, 0.2];
}
function sngPayouts(pool, entrants) {
    const net = sngPrize(pool);
    const amounts = sngPayoutShares(entrants).map(s => Math.floor(net * s));
    amounts[0] += net - amounts.reduce((a, b) => a + b, 0);
    return amounts;
}
// 这场有几个人报了名：奖池只由报名费累积（开赛前退出的已从奖池里退掉），所以奖池 ÷ 报名费就是报名人数
function sngEntrants(game) {
    const fee = game && game.config && game.config.buyIn;
    return fee > 0 ? Math.round((game.prizePool || 0) / fee) : (game.players || []).length;
}

module.exports = {
    LOCAL_DEV: process.env.LOCAL_DEV === '1', PHASES, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND,
    ACTION_TIME, EXTRA_STEP, EXTRA_MAX, RUNOUT_DELAY, RUNIT_MAX, RUNIT_DECIDE_MS,
    STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS, SNG_BUYIN_TIERS,
    BUYIN_RATE, CASHOUT_RATE, CONFIGURED_PUBLIC_ORIGIN, STANDARD_BLIND_LEVELS,
    loadJwtSecret, gameSB, gameBB, gameAnte, timeCardsFor, sngPrize, sngPayouts, sngPayoutShares, sngEntrants,
    ACTION_TIME_CHOICES, pickActionTimeSec, actionTimeOf
};
