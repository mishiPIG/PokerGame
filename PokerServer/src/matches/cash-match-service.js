'use strict';
const { createRoomLifecycle } = require('../rooms/room-lifecycle');

function createCashMatchService({ io, db, roomGames, lobbySockets, config, persistence, hooks }) {
    const { CASHOUT_RATE, PHASES, gameBB, STRADDLE_INTERMISSION_MS } = config;
    const { buildRanking, sendMatchResult, clearActionTimer, clearStraddleDecision, showStraddleDecision, broadcastState, broadcastRoomList, listRooms, removeBustedPlayers, liveCount, startHand } = hooks;
// 现金桌训练时长到点：不打断当前手，也不自动结算；本手结束后暂停发牌，等待房主决定。
function onTableTimeUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
    clearTimeout(game.tableTimer); game.tableTimer = null;
    game.timeExpired = true;
    game.pendingEnd = false; // 兼容旧快照；到时不再代表自动收桌
    io.in(roomId).emit('server_msg', '⏰ 训练时长已到——本手结束后暂停发牌，等待房主决定');
    io.in(roomId).emit('match_time_expired', {});
    broadcastState(roomId);
}
function startTableTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return;
    const ms = Math.round((game.config.durationH || 2) * 3600 * 1000) + (game.extraMs || 0);
    game.tableEndAt = Date.now() + ms;
    clearTimeout(game.tableTimer);
    game.tableTimer = setTimeout(() => onTableTimeUp(roomId), ms);
}
function restoreTableTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash' || !game.tableEndAt || game.tournamentOver) return;
    clearTimeout(game.tableTimer);
    if (game.timeExpired || game.tableEndAt <= Date.now()) { onTableTimeUp(roomId); return; }
    game.tableTimer = setTimeout(() => onTableTimeUp(roomId), Math.max(0, game.tableEndAt - Date.now()));
}
function adjustTableEnd(roomId, endAt) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash' || !Number.isFinite(endAt)) return null;
    const now = Date.now();
    const oldEndAt = game.tableEndAt || now;
    const nextEndAt = Math.max(now, Math.round(endAt));
    const grantedMs = Math.max(0, nextEndAt - Math.max(oldEndAt, now));
    game.tableEndAt = nextEndAt;
    game.extraMs = (game.extraMs || 0) + (nextEndAt - oldEndAt);
    game.timeExpired = nextEndAt <= now;
    game.pendingEnd = false;
    clearTimeout(game.tableTimer); game.tableTimer = null;
    if (!game.timeExpired) game.tableTimer = setTimeout(() => onTableTimeUp(roomId), nextEndAt - now);
    if (grantedMs > 0) {
        // 只为实际延长的未来时长补时间卡；缩短不回收已经发出的卡。
        const addH = grantedMs / 3600000, bb = gameBB(game) || 1;
        const grant = p => { p.timeCards = (p.timeCards || 0) + Math.round(addH * ((p.buyIn || 0) / bb) * 0.25); };
        game.players.forEach(grant);
        (game.vacatedPlayers || []).forEach(grant);
    }
    return { oldEndAt, endAt: nextEndAt, timeExpired: game.timeExpired };
}
function extendTable(roomId, addMs) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return null;
    return adjustTableEnd(roomId, Math.max(game.tableEndAt || 0, Date.now()) + addMs);
}

// 结束现金桌：结算所有在座筹码→金币，公布排名+发消息，全员（含观众）回大厅
function endCashTable(roomId, reason) {
    const game = roomGames[roomId];
    if (!game || game._persistenceFinished) return;
    game.tournamentOver = true; game.status = 'finished';
    clearTimeout(game.tableTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer); clearTimeout(game.runItTimer); game.runItPending = false; clearActionTimer(game);
    clearStraddleDecision(game);
    for (const p of game.players) if (p.reserveTimer) clearTimeout(p.reserveTimer);
    const ranking = buildRanking(game);
    game.players.forEach(p => cashOut(p));   // 结算筹码→金币
    (game.vacatedPlayers || []).forEach(vp => cashOut(vp));   // 站起围观者的筹码也在结束时结算
    if (ranking.length) sendMatchResult(roomId, `【${game.config.name}】${reason || '比赛结束'}`, ranking);
    else io.in(roomId).emit('room_dissolved');   // 空桌（如刚创建即解散）：直接回大厅
    // 把房间内所有 socket（在座玩家 + 观众）踢回大厅
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) for (const sid of [...room]) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); if (s.user) s.emit('room_list', listRooms(s.user.id)); }
    }
    persistence.finish(roomId, 'finished');
    delete roomGames[roomId];
    broadcastRoomList();
}

const { scheduleEmptyCleanup } = createRoomLifecycle({
    io,
    roomGames,
    hooks: { endCashTable, clearActionTimer, broadcastRoomList, finishRoom: persistence.finish }
});

// 一局结束后自动开下一局（SNG/现金桌进行中，无需重新准备）
// 注意：总是排一次定时清理（标记坐出/兑出/生效补码），即使人数不足也要让坐出状态落地
function scheduleNextHand(roomId) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
    if (game.roomType !== 'sng' && game.roomType !== 'cash') return;
    // 若当前手始终没有安全展示时机，利用已有 5 秒局间做最后兜底；不延迟下一手。
    if (game.straddleDecision?.status === 'pending') {
        showStraddleDecision(roomId, STRADDLE_INTERMISSION_MS);
    }
    clearTimeout(game.nextHandTimer);
    game.nextHandAt = Date.now() + 5000;
    game.nextHandTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.tournamentOver || g.phase !== PHASES.SHOWDOWN) return;
        removeBustedPlayers(g);   // 结算后：SNG 淘汰 / 现金桌兑出离场者移除、坐出者保留、挂起补码生效
        // 房主在牌局进行中点了解散 → 等到本手打完才真正解散（不打断正在进行的牌）
        if (g.pendingDissolve) { hooks.dissolveNow(roomId); return; }
        if (g.timeExpired) { io.in(roomId).emit('server_msg', '⏸️ 训练时间已到，等待房主加时或结束比赛'); broadcastState(roomId); return; }
        if (g.paused) { io.in(roomId).emit('server_msg', '⏸️ 房主已暂停发牌（本手结束）'); broadcastState(roomId); return; }
        if (liveCount(g) >= 2) startHand(roomId);
        else broadcastState(roomId);   // 人不够：停摆，等补码/坐下（坐出状态已标记）
    }, 5000);
    persistence.commit(roomId, 'next_hand_scheduled', null, { nextHandAt: game.nextHandAt });
}

function restoreNextHandTimer(roomId) {
    const game = roomGames[roomId];
    if (!game?.nextHandAt || game.tournamentOver) return;
    clearTimeout(game.nextHandTimer);
    game.nextHandTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.tournamentOver || g.phase !== PHASES.SHOWDOWN) return;
        removeBustedPlayers(g);
        if (g.pendingDissolve) { hooks.dissolveNow(roomId); return; }
        if (g.timeExpired) { broadcastState(roomId); return; }
        if (g.paused) { broadcastState(roomId); return; }
        if (liveCount(g) >= 2) startHand(roomId);
        else broadcastState(roomId);
    }, Math.max(0, game.nextHandAt - Date.now()));
}

// 现金桌兑出：剩余筹码按汇率兑回金币，返回兑出金币数
function cashOut(p) {
    if (p.settledAt) return p.settlementGold || 0;
    const payout = Math.max(0, Math.floor((p.chips || 0) * CASHOUT_RATE));
    const roomId = Object.keys(roomGames).find(id => {
        const game = roomGames[id];
        return game.players.includes(p) || (game.vacatedPlayers || []).includes(p);
    });
    const game = roomId && roomGames[roomId];
    const previousSettlement = { settlementGold: p.settlementGold, settledAt: p.settledAt };
    p.settlementGold = payout;
    p.settledAt = Date.now();
    try {
        if (payout > 0) {
            const committed = persistence.commitWithWallet(roomId, [{
                userId: p.userId,
                delta: payout,
                type: 'cash_cashout',
                matchId: game.matchId,
                operationKey: `cash-cashout:${game.matchId}:${p.userId}`,
                metadata: { chips: p.chips || 0 }
            }], 'cash_cashout', p.userId, { payout });
            const balance = committed.wallets[0].balance;
            const s = io.sockets.sockets.get(p.socketId);
            if (s) s.emit('gold_update', { gold: balance });
        } else if (roomId) {
            persistence.commit(roomId, 'cash_cashout', p.userId, { payout: 0 });
        }
    } catch (error) {
        p.settlementGold = previousSettlement.settlementGold;
        p.settledAt = previousSettlement.settledAt;
        throw error;
    }
    return payout;
}


    return { onTableTimeUp, startTableTimer, restoreTableTimer, adjustTableEnd, extendTable, endCashTable, scheduleEmptyCleanup, scheduleNextHand, restoreNextHandTimer, cashOut };
}

module.exports = { createCashMatchService };
