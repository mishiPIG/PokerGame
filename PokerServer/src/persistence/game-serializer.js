'use strict';

const TRANSIENT_KEYS = new Set([
    'actionTimer',
    'levelTimer',
    'tableTimer',
    'nextHandTimer',
    'runoutTimer',
    'runItTimer',
    'dissolveTimer',
    'emptyCleanupTimer',
    'reserveTimer',
    'timeUpGraceTimer',
    'timer'
]);
// ⚠️ 往 game 上挂新的定时器时，务必同时加进上面这张表。
// Node 的 Timeout 对象内部是循环引用（_idlePrev/_idleNext 互指），
// JSON.stringify 会直接抛 "Converting circular structure to JSON" —— 整个快照写不进去，
// 表现是启动恢复时刷一片报错（timeUpGraceTimer 就这么中过一次，靠发版后错误日志自查抓到）。

function encodeGame(game) {
    return JSON.stringify(game, (key, value) => {
        if (TRANSIENT_KEYS.has(key)) return undefined;
        if (key === 'socketId') return null;
        if (value instanceof Set) return { __pokerType: 'Set', values: [...value] };
        if (key === 'deck' && value && Array.isArray(value.cards)) {
            return {
                __pokerType: 'Deck',
                cards: value.cards.map(card => ({ suit: card.suit, rank: card.rank })),
                lastShuffleId: value.lastShuffleId || null
            };
        }
        if (value && value.constructor?.name === 'Card') {
            return { __pokerType: 'Card', suit: value.suit, rank: value.rank };
        }
        return value;
    });
}

function serializeGame(game, stateVersion = game.stateVersion || 0) {
    const snapshot = JSON.parse(encodeGame(game));
    snapshot.formatVersion = 1;
    snapshot.stateVersion = stateVersion;
    return snapshot;
}

// 直接给出要落库的 JSON 字符串。
// 每次广播都会写一次快照：原来是 stringify → parse → 改两个字段 → 入库时再 stringify 一遍，
// 9 人桌上每次广播白做两遍整局序列化。这里只序列化一次，把两个字段拼在末尾
// （JSON 里同名键以最后一个为准，game 自身带的 stateVersion 会被覆盖，结果与 serializeGame 完全一致）。
function serializeGameJson(game, stateVersion = game.stateVersion || 0) {
    const encoded = encodeGame(game);
    return `${encoded.slice(0, -1)}${encoded.length > 2 ? ',' : ''}"formatVersion":1,"stateVersion":${Number(stateVersion) || 0}}`;
}

function playerStatus(player, vacated = false) {
    if (player.settledAt) return 'settled';
    if (player.eliminated) return 'eliminated';
    if (player.leaving || player.left) return 'left';
    if (vacated || player.standing) return 'vacated';
    if (player.reserved) return 'reserved';
    if (player.sittingOut) return 'sitting_out';
    return 'seated';
}

function economicParticipants(game) {
    const rows = [];
    const push = (player, vacated = false) => {
        if (!player?.userId || rows.some(row => row.userId === player.userId)) return;
        rows.push({
            userId: player.userId,
            username: player.username || player.userId,
            seat: player.seat ?? null,
            status: playerStatus(player, vacated),
            buyinGoldTotal: player.buyInGold || 0,
            buyinChipsTotal: player.buyIn || 0,
            currentChips: player.chips || 0,
            handsPlayed: player.handsPlayed || 0,
            settlementGold: player.settlementGold ?? null,
            settledAt: player.settledAt || null,
            joinedAt: player.joinedAt || game.createdAt || Date.now(),
            leftAt: player.leftAt || null
        });
    };
    (game.players || []).forEach(player => push(player, false));
    (game.vacatedPlayers || []).forEach(player => push(player, true));
    (game.statsHistory || []).forEach(player => push(player, true));
    return rows;
}

module.exports = { serializeGame, serializeGameJson, economicParticipants, TRANSIENT_KEYS };
