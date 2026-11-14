'use strict';

// 客户端发来的负载里，这几个键会让 String(x) / x + '' / 拿它当属性名 直接抛错，
// 或者污染原型。socket.io 的 JSON 里它们都是普通的自有属性，所以在进处理器之前统一剥掉。
// （2026-11-14：发一条 { text: { toString: 1 } } 就能让处理器抛错 —— 再加上出错就暂停牌桌，任何观战者都能停掉任何一桌；见 register-socket-handlers.js「谁的错误才暂停牌桌」）
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'toJSON', 'hasOwnProperty']);
function sanitize(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 6) return value;
    if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
    const out = {};
    for (const k of Object.keys(value)) if (!POISON_KEYS.has(k)) out[k] = sanitize(value[k], depth + 1);
    return out;
}

module.exports = { sanitize, POISON_KEYS };
