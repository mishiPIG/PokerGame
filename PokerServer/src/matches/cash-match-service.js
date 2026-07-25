'use strict';
const { createRoomLifecycle } = require('../rooms/room-lifecycle');

function createCashMatchService({ io, db, roomGames, lobbySockets, config, hooks }) {
    const { CASHOUT_RATE, PHASES, gameBB, STRADDLE_INTERMISSION_MS } = config;
    const { buildRanking, sendMatchResult, clearActionTimer, clearStraddleDecision, showStraddleDecision, broadcastState, broadcastRoomList, listRooms, removeBustedPlayers, liveCount, startHand } = hooks;
// 现金桌训练时长倒计时：到点自动结束并结算排名
// 训练时长到点：若正有牌局进行，不打断——挂起 pendingEnd，本手结束后再结算，并提醒房主加时；
// 若在局间（无牌局），直接结算。
function onTableTimeUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    if (inHand) {
        game.pendingEnd = true;
        io.in(roomId).emit('server_msg', '⏰ 训练时长已到——本手结束后结算；房主可加时继续');
        io.in(roomId).emit('match_ending_soon', {});
        broadcastState(roomId);
    } else {
        endCashTable(roomId, '训练时长已到');
    }
}
function startTableTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return;
    const ms = Math.round((game.config.durationH || 2) * 3600 * 1000) + (game.extraMs || 0);
    game.tableEndAt = Date.now() + ms;
    clearTimeout(game.tableTimer);
    game.tableTimer = setTimeout(() => onTableTimeUp(roomId), ms);
}
function extendTable(roomId, addMs) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return;
    game.extraMs = (game.extraMs || 0) + addMs;
    game.pendingEnd = false;   // 加时了 → 取消「本手后结束」的挂起
    if (game.tableEndAt) {
        game.tableEndAt = Math.max(game.tableEndAt, Date.now()) + addMs;   // 若已过点，从现在起加
        clearTimeout(game.tableTimer);
        game.tableTimer = setTimeout(() => onTableTimeUp(roomId), Math.max(0, game.tableEndAt - Date.now()));
    }
    // 比赛加时 → 按增加的时长给各家补时间卡（时长 × 买入BB × 0.25）
    const addH = addMs / 3600000, bb = gameBB(game) || 1;
    const grant = p => { p.timeCards = (p.timeCards || 0) + Math.round(addH * ((p.buyIn || 0) / bb) * 0.25); };
    game.players.forEach(grant);
    (game.vacatedPlayers || []).forEach(grant);
}

// 结束现金桌：结算所有在座筹码→金币，公布排名+发消息，全员（含观众）回大厅
function endCashTable(roomId, reason) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
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
    delete roomGames[roomId];
    broadcastRoomList();
}

const { scheduleEmptyCleanup } = createRoomLifecycle({ io, roomGames, hooks: { endCashTable, clearActionTimer, broadcastRoomList } });

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
    game.nextHandTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.tournamentOver || g.phase !== PHASES.SHOWDOWN) return;
        removeBustedPlayers(g);   // 结算后：SNG 淘汰 / 现金桌兑出离场者移除、坐出者保留、挂起补码生效
        if (g.pendingEnd) { endCashTable(roomId, '训练时长已到'); return; }   // 到点：本手已结束→结算收桌
        if (g.paused) { io.in(roomId).emit('server_msg', '⏸️ 房主已暂停发牌（本手结束）'); broadcastState(roomId); return; }
        if (liveCount(g) >= 2) startHand(roomId);
        else broadcastState(roomId);   // 人不够：停摆，等补码/坐下（坐出状态已标记）
    }, 5000);
}

// 现金桌兑出：剩余筹码按汇率兑回金币，返回兑出金币数
function cashOut(p) {
    const payout = Math.max(0, Math.floor((p.chips || 0) * CASHOUT_RATE));
    if (payout > 0) {
        const fresh = db.getUserById(p.userId).gold;
        db.setGold(p.userId, fresh + payout);
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('gold_update', { gold: fresh + payout });
    }
    return payout;
}


    return { onTableTimeUp, startTableTimer, extendTable, endCashTable, scheduleEmptyCleanup, scheduleNextHand, cashOut };
}

module.exports = { createCashMatchService };
