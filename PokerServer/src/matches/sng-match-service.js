'use strict';

const SNG_DISSOLVE_GRACE_MS = 25000;   // SNG 分出胜负后，留 25s 看结算排名，再自动解散房间

function createSngMatchService({ io, db, roomGames, lobbySockets, sngPrize, sngPayouts, sngEntrants, persistence, PHASES, hooks }) {
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
    persistence.finish(roomId, 'finished');
    delete roomGames[roomId];
    broadcastRoomList();
}
// 房主解散 SNG：奖池（抽水后）给当前筹码领先者 + 公布排名 + 清房。
// 抽出来是为了让「牌局进行中解散」能延后到本手结束再执行（见 cash-match-service 的 pendingDissolve）。
function dissolveSngRoom(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    // ⚠️ 已自然结束(tournamentOver)的 SNG 奖金已在 maybeEndSNG 发过 —— 此时只清房，绝不再发奖/再弹排名
    if (!game.tournamentOver && game.status === 'waiting') {
        // 🔴 从没开过赛：大家筹码一样多，「筹码领先者」只是座位号最小的那位（通常是房主）。
        //    原来会把所有人的报名费（抽水后）判给他 —— 房主在等待室点一下解散就能拿走；
        //    全员掉线 3 分钟后的空房清理走的也是这条路。没开赛就该原数退还。
        const refunds = game.players
            .map(p => ({ p, gold: p.buyInGold || 0 }))
            .filter(r => r.gold > 0);
        if (refunds.length) {
            const committed = persistence.commitWithWallet(roomId, refunds.map(({ p, gold }) => ({
                userId: p.userId, delta: gold, type: 'sng_refund', matchId: game.matchId,
                operationKey: `sng-refund:${game.matchId}:${p.userId}:${db.wallet.countOperations(`sng-refund:${game.matchId}:${p.userId}`) + 1}`,
                metadata: { reason: 'dissolved_before_start' }
            })), 'sng_refund', null, { reason: 'dissolved_before_start' });
            refunds.forEach(({ p, gold }, i) => {
                p.settlementGold = gold; p.settledAt = Date.now();
                if (p.socketId) io.to(p.socketId).emit('gold_update', { gold: committed.wallets[i].balance });
            });
        }
        game.prizePool = 0;
    } else if (!game.tournamentOver) {
        // 开赛后解散：按当前名次发（还在桌上的按筹码多少排，已出局的按出局先后）。
        // 原来是奖池全给筹码领先者 —— 现在名次多了，照名次表发才和「打到最后」一致。
        const leader = [...game.players].sort((a, b) => b.chips - a.chips)[0];
        const ranking = buildRanking(game, leader && leader.userId, sngPayouts(game.prizePool, sngEntrants(game)));
        settleSngPlaces(roomId, game, ranking, 'owner_dissolve');
        sendMatchResult(roomId, `【${game.config.name}】房主提前结束`, ranking);
    }
    io.in(roomId).emit('server_msg', { k: 'host.dissolved' });
    finalizeSngRoom(roomId);
}

// 按名次发奖（2026-11-18）：ranking 是 buildRanking 的结果（每一名带 prize），把 prize > 0 的一次性写进钱包。
// 自然结束、开赛后解散两条路径共用。被淘汰的人已经不在座位上（在观战或已离开），金币照发、能找到连接就推一下余额。
// operationKey 沿用 sng-prize:<场>:<人> —— 同一场同一个人只会拿一次，重复调用钱包直接挡回。
function settleSngPlaces(roomId, game, ranking, reason) {
    const paid = ranking.filter(r => (r.prize || 0) > 0);
    if (!paid.length) return;
    const pool = game.prizePool;
    const committed = persistence.commitWithWallet(roomId, paid.map(r => ({
        userId: r.userId, delta: r.prize, type: 'sng_prize', matchId: game.matchId,
        operationKey: `sng-prize:${game.matchId}:${r.userId}`,
        metadata: { prizePool: pool, rank: r.rank, entrants: sngEntrants(game), ...(reason ? { reason } : {}) }
    })), 'sng_prize', paid[0].userId, { payouts: paid.map(r => ({ userId: r.userId, rank: r.rank, prize: r.prize })), ...(reason ? { reason } : {}) });
    paid.forEach((r, i) => {
        const seat = game.players.find(p => p.userId === r.userId);
        if (seat) { seat.settlementGold = r.prize; seat.settledAt = Date.now(); }
        for (const s of io.sockets.sockets.values()) {
            if (s.user && s.user.id === r.userId) s.emit('gold_update', { gold: committed.wallets[i].balance });
        }
    });
}

// SNG 升盲计时器
function startLevelTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng') return;
    clearTimeout(game.levelTimer);
    const ms = game.config.levelMinutes * 60000;
    game.nextLevelAt = Date.now() + ms;
    game.levelTimer = setTimeout(() => onLevelUp(roomId), ms);
}

function restoreLevelTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng' || game.status !== 'running') return;
    const deadline = game.nextLevelAt || (game.levelStartTime + game.config.levelMinutes * 60000);
    game.nextLevelAt = deadline;
    clearTimeout(game.levelTimer);
    game.levelTimer = setTimeout(() => onLevelUp(roomId), Math.max(0, deadline - Date.now()));
}

function onLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.status !== 'running') return;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    if (inHand) {
        // 牌局进行中：挂起涨盲，等本局结束再应用并重启倒计时（不在此重启计时）
        game.pendingLevelUp = true;
        io.in(roomId).emit('server_msg', { k: 'blind.pending' });
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
        io.in(roomId).emit('server_msg', { k: 'blind.up', p: { level: game.currentLevel + 1, sb: lvl.sb, bb: lvl.bb } });
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
        // 按名次发奖（2026-11-18）：原来冠军一个人拿走整个奖池，现在按报名人数照名次表发（config.sngPayouts）
        const ranking = buildRanking(game, winner && winner.userId, sngPayouts(game.prizePool, sngEntrants(game)));
        try {
            settleSngPlaces(roomId, game, ranking, null);
        } catch (error) {
            game.tournamentOver = false;
            game.status = 'running';
            throw error;
        }
        if (winner) {
            const prize = (ranking[0] && ranking[0].prize) || 0;
            io.in(roomId).emit('server_msg', { k: 'sng.champion', p: { name: winner.displayName || winner.username, prize } });
            io.in(roomId).emit('tournament_over', { winnerId: winner.userId, prize });
        }
        // 公布按名次排名（冠军→淘汰倒序，每一名带奖金）+ 给每位玩家（含已淘汰离开者）发消息
        sendMatchResult(roomId, `【${game.config.name}】比赛结束`, ranking);
        // 分出胜负 → 自动结算(上面已发奖) + 宽限后自动解散房间(玩家看完排名回大厅，无需手动解散)
        clearTimeout(game.dissolveTimer);
        game.dissolveAt = Date.now() + SNG_DISSOLVE_GRACE_MS;
        game.dissolveTimer = setTimeout(() => finalizeSngRoom(roomId), SNG_DISSOLVE_GRACE_MS);
        persistence.commit(roomId, 'sng_dissolve_scheduled', null, { dissolveAt: game.dissolveAt });
        broadcastRoomList();
    }
}


    function restoreDissolveTimer(roomId) {
        const game = roomGames[roomId];
        if (!game) return;
        // 奖金和结束状态可能已经原子提交，而进程恰好在写入 dissolveAt 前退出。
        // 此时不能留下一个永久无法解散的已结束房间。
        if (!game.dissolveAt) game.dissolveAt = Date.now() + SNG_DISSOLVE_GRACE_MS;
        clearTimeout(game.dissolveTimer);
        game.dissolveTimer = setTimeout(() => finalizeSngRoom(roomId), Math.max(0, game.dissolveAt - Date.now()));
    }

    return { startLevelTimer, restoreLevelTimer, restoreDissolveTimer, onLevelUp, doLevelUp, applyPendingLevelUp, maybeEndSNG, finalizeSngRoom, dissolveSngRoom };
}

module.exports = { createSngMatchService };
