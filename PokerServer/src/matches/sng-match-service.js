'use strict';

const SNG_DISSOLVE_GRACE_MS = 25000;   // SNG 分出胜负后，留 25s 看结算排名，再自动解散房间

function createSngMatchService({ io, db, roomGames, lobbySockets, sngPrize, PHASES, hooks }) {
    const { broadcastState, broadcastRoomList, buildRanking, sendMatchResult, listRooms, clearActionTimer } = hooks;

// SNG 结束后清房：清所有定时器、通知客户端回大厅、把玩家踢回大厅、删房。奖金已在 maybeEndSNG 结算，此处不再发奖。
function finalizeSngRoom(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
    clearTimeout(game.runItTimer); clearTimeout(game.dissolveTimer); game.runItPending = false;
    clearActionTimer(game);
    for (const p of game.players) if (p.reserveTimer) clearTimeout(p.reserveTimer);
    io.in(roomId).emit('room_dissolved');
    for (const p of game.players) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('room_list', listRooms(p.userId)); }
    }
    delete roomGames[roomId];
    broadcastRoomList();
}
// SNG 升盲计时器
function startLevelTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng') return;
    clearTimeout(game.levelTimer);
    game.levelTimer = setTimeout(() => onLevelUp(roomId), game.config.levelMinutes * 60000);
}

function onLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.status !== 'running') return;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    if (inHand) {
        // 牌局进行中：挂起涨盲，等本局结束再应用并重启倒计时（不在此重启计时）
        game.pendingLevelUp = true;
        io.in(roomId).emit('server_msg', `⏫ 涨盲时间到，将于本局结束后升盲`);
        broadcastState(roomId);
        return;
    }
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

function doLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.currentLevel < game.blindLevels.length - 1) {
        game.currentLevel++;
        const lvl = game.blindLevels[game.currentLevel];
        io.in(roomId).emit('server_msg', `⏫ 升盲！级别 ${game.currentLevel + 1}：${lvl.sb}/${lvl.bb}`);
    }
    game.levelStartTime = Date.now();
}

// 本局结束时若有挂起的涨盲，则应用并重启倒计时
function applyPendingLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || !game.pendingLevelUp) return;
    game.pendingLevelUp = false;
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

// SNG 结束判定：仅剩 1 人有筹码 → 比赛结束，奖池给赢家
function maybeEndSNG(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng' || game.tournamentOver) return;
    const alive = game.players.filter(p => p.chips > 0);
    if (alive.length <= 1) {
        game.tournamentOver = true;
        game.status = 'finished';
        clearTimeout(game.levelTimer);
        const winner = alive[0];
        if (winner) {
            const prize = sngPrize(game.prizePool);
            if (prize > 0) {
                const fresh = db.getUserById(winner.userId).gold;
                db.setGold(winner.userId, fresh + prize);
                if (winner.socketId) io.to(winner.socketId).emit('gold_update', { gold: fresh + prize });
            }
            io.in(roomId).emit('server_msg', `🏆🏆 ${winner.username} 夺冠！奖池 ${prize} 金币`);
            io.in(roomId).emit('tournament_over', { winner: winner.username, prize });
        }
        // 公布按名次排名（冠军→淘汰倒序）+ 给每位玩家（含已淘汰离开者）发消息
        sendMatchResult(roomId, `【${game.config.name}】比赛结束`, buildRanking(game, winner && winner.userId, sngPrize(game.prizePool)));
        // 分出胜负 → 自动结算(上面已发奖) + 宽限后自动解散房间(玩家看完排名回大厅，无需手动解散)
        clearTimeout(game.dissolveTimer);
        game.dissolveTimer = setTimeout(() => finalizeSngRoom(roomId), SNG_DISSOLVE_GRACE_MS);
        broadcastRoomList();
    }
}


    return { startLevelTimer, onLevelUp, doLevelUp, applyPendingLevelUp, maybeEndSNG, finalizeSngRoom };
}

module.exports = { createSngMatchService };
