'use strict';
// 带入审批（2026-11-17，玩家视角复盘 P11）。现金桌房主可以打开「带入需房主批准」：
// 别人坐下带入、补码，都要房主点一下才生效 —— 朋友局里用来控制输赢规模。默认关。
//
// 做法刻意绕开「审批通过后由服务端替他执行一遍」：
//   请求 → 房主批准 → 记一张【一次性的批准】→ 通知申请人的页面把原来那个 sit_down / rebuy 再发一次。
// 这样真正执行的仍是原来那条路径（座位还空不空、金币够不够、带入上限…一个不少），
// 审批这里只多了一道「有没有批准」的闸，不会长出第二套入座 / 补码逻辑。
//
// 🔴 批准只认：同一个人、同一种操作（坐下 / 补码）、金额不超过房主批准的那个数、1 分钟内用掉。
//    申请人改客户端把金额改大，批准就对不上，照样要重新申请。
const PENDING_MS = 2 * 60 * 1000;    // 房主多久没处理就作废
const APPROVED_MS = 60 * 1000;       // 批准之后多久内必须用掉

function needsApproval(game, userId) {
    return !!game && game.roomType === 'cash' && !!(game.config && game.config.approveBuyIn) && game.ownerUserId !== userId;
}

function ownerSockets(io, game, roomId) {
    const out = [];
    for (const s of io.sockets.sockets.values()) {
        if (s.user && s.user.id === game.ownerUserId && s.currentRoom === roomId) out.push(s);
    }
    return out;
}

// 申请人这一次有没有可用的批准；有就用掉（只能用一次）
function takeApproval(game, userId, kind, chips, now = Date.now()) {
    const a = (game.approvedBuyins || {})[userId];
    if (!a || a.kind !== kind || now - a.at > APPROVED_MS || !(chips <= a.chips)) return false;
    delete game.approvedBuyins[userId];
    return true;
}

// 发起申请。返回 true = 已经发给房主（调用方就此 return，等批准）
function requestApproval({ io, game, roomId, socket, user, kind, chips, seat = null, name, now = Date.now() }) {
    game.pendingBuyins = game.pendingBuyins || {};
    const prev = game.pendingBuyins[user.id];
    if (prev && now - prev.at < PENDING_MS) { socket.emit('server_msg', { k: 'buyin.pending' }); return true; }
    const owners = ownerSockets(io, game, roomId);
    // 房主不在这张桌上：没人能批，别让申请人干等两分钟
    if (!owners.length) { socket.emit('server_msg', { k: 'buyin.ownerAway' }); return true; }
    game.pendingBuyins[user.id] = { kind, chips, seat, at: now };
    owners.forEach(s => s.emit('buyin_request', { userId: user.id, name, kind, chips }));
    socket.emit('server_msg', { k: 'buyin.waiting' });
    return true;
}

// 房主做决定。返回给谁发什么，由调用方去发（便于测试）
function decide(game, ownerId, userId, approve, now = Date.now()) {
    if (!game || game.ownerUserId !== ownerId) return { ok: false, reason: 'notOwner' };
    const p = (game.pendingBuyins || {})[userId];
    if (!p || now - p.at > PENDING_MS) { if (p) delete game.pendingBuyins[userId]; return { ok: false, reason: 'gone' }; }
    delete game.pendingBuyins[userId];
    if (!approve) return { ok: true, approved: false, request: p };
    game.approvedBuyins = game.approvedBuyins || {};
    game.approvedBuyins[userId] = { kind: p.kind, chips: p.chips, at: now };
    return { ok: true, approved: true, request: p };
}

module.exports = { needsApproval, takeApproval, requestApproval, decide, PENDING_MS, APPROVED_MS };
