'use strict';
// 「再来一局」的待办邀请（2026-11-17）。
//
// SNG 打完，房主点「再来一局」→ 服务端用同样设置开一张新桌 → 上一场还停在结算页的人收到邀请。
// 🔴 和牌友邀请（invite-events.js 的 FRIEND_INVITES）是同一道闸：
//    rematch_join 必须在这里找得到一条【发给你本人】的记录才放行，用完即删、3 分钟过期。
//    没有这道闸，任何人知道新桌的房间号就能自己 emit 一个 rematch_join 拿到下场资格 ——
//    而房间号在大厅列表里是公开的。
//    邀请里也【不带房间码】，理由同牌友邀请。
const PENDING = new Map();            // `${roomId}:${userId}` -> { from, at }
const TTL_MS = 3 * 60 * 1000;
const key = (roomId, userId) => `${roomId}:${userId}`;

function sweep(now = Date.now()) {
    for (const [k, v] of PENDING) if (now - v.at > TTL_MS) PENDING.delete(k);
}
function offerRematch(roomId, userId, fromUserId, now = Date.now()) {
    sweep(now);
    PENDING.set(key(roomId, userId), { from: fromUserId, at: now });
}
// 取出并删除（只能用一次）。没有 / 过期 → null。
function takeRematch(roomId, userId, now = Date.now()) {
    sweep(now);
    const k = key(roomId, userId);
    const v = PENDING.get(k);
    if (!v) return null;
    PENDING.delete(k);
    return v;
}

module.exports = { offerRematch, takeRematch, REMATCH_TTL_MS: TTL_MS, _pending: PENDING };
