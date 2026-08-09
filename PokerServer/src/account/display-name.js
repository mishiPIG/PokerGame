'use strict';

const DISPLAY_NAME_MIN_LENGTH = 2;
const DISPLAY_NAME_MAX_LENGTH = 16;
const DISPLAY_NAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RESERVED_NAMES = new Set(['系统', '管理员', '官方', '客服', 'gm', 'admin', 'administrator']);
const DISPLAY_NAME_CHARS = /^[\p{L}\p{N} _.\-]+$/u;

function normalizeDisplayName(value) {
    if (typeof value !== 'string') return null;
    const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const length = Array.from(name).length;
    if (length < DISPLAY_NAME_MIN_LENGTH || length > DISPLAY_NAME_MAX_LENGTH) return null;
    if (!DISPLAY_NAME_CHARS.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null;
    if (RESERVED_NAMES.has(name.toLocaleLowerCase())) return null;
    return name;
}

function displayNameChangeAllowed(user, now = Date.now()) {
    const changedAt = Number(user?.displayNameChangedAtMs || 0);
    return !changedAt || now - changedAt >= DISPLAY_NAME_COOLDOWN_MS;
}

function displayNameChangeRemainingMs(user, now = Date.now()) {
    const changedAt = Number(user?.displayNameChangedAtMs || 0);
    return Math.max(0, changedAt + DISPLAY_NAME_COOLDOWN_MS - now);
}

// 所有【给玩家看】的文字一律走这里：玩家改名后要显示新名字。
// （username 是账号名、改名不会变，只适合服务器日志/审计这种要稳定身份的地方。）
function nameOf(u) {
    return (u && (u.displayName || u.username)) || '玩家';
}

module.exports = {
    nameOf,
    DISPLAY_NAME_COOLDOWN_MS,
    displayNameChangeAllowed,
    displayNameChangeRemainingMs,
    normalizeDisplayName
};
