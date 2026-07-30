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
const EXTRA_STEP = 15000;
const EXTRA_MAX = 120000;
const RUNOUT_DELAY = 1400;
const RUNIT_MAX = 5;
const RUNIT_DECIDE_MS = 45000;   // 多次发牌决策窗口（25s→45s，给足反应时间；落后方选号后会为领先方重置一次）
const STRADDLE_DECISION_MS = 15000;
const STRADDLE_INTERMISSION_MS = 4500;
const FIXED_BUYIN = 50;
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
const INITIAL_BB = STANDARD_BLIND_LEVELS[0].bb;

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

module.exports = {
    LOCAL_DEV: process.env.LOCAL_DEV === '1', PHASES, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND,
    ACTION_TIME, EXTRA_STEP, EXTRA_MAX, RUNOUT_DELAY, RUNIT_MAX, RUNIT_DECIDE_MS,
    STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS, FIXED_BUYIN, SNG_BUYIN_TIERS,
    BUYIN_RATE, CASHOUT_RATE, CONFIGURED_PUBLIC_ORIGIN, STANDARD_BLIND_LEVELS, INITIAL_BB,
    loadJwtSecret, gameSB, gameBB, gameAnte, timeCardsFor, sngPrize
};
