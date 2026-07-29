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

module.exports = {
    DISPLAY_NAME_COOLDOWN_MS,
    displayNameChangeAllowed,
    displayNameChangeRemainingMs,
    normalizeDisplayName
};
