'use strict';

function registerTableControlEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, adjustTableEnd, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction, buildRanking, sendMatchResult, dissolveSngRoom, persistence } = tableService;
    // 解散/提前结束：仅房主。现金桌=结算筹码+公布排名；SNG=奖池给筹码领先者+公布排名
    socket.on('dissolve_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以解散房间'); return; }

        // 牌局进行中 → 不打断这手牌，等它打完再解散（与「涨盲/训练时长到点」一致的做法）。
        // 直接解散会让正在进行的这手牌凭空消失，玩家投入池里的筹码只能按当前状态草草结算。
        const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
        if (inHand) {
            if (game.pendingDissolve) { socket.emit('server_msg', '⚠️ 已在等本手结束后解散'); return; }
            game.pendingDissolve = true;
            io.in(roomId).emit('server_msg', '🛑 房主已结束比赛，本手打完后解散');
            broadcastState(roomId);
            return;
        }
        if (game.roomType === 'cash') {
            io.in(roomId).emit('server_msg', `🛑 房主提前结束了比赛`);
            endCashTable(roomId, '房主提前结束');   // 结算 + 排名 + 收件箱
            return;
        }
        dissolveSngRoom(roomId);   // SNG：奖池给筹码领先者 + 公布排名 + 清房（见 sng-match-service）
    });

    // 比赛加时（现金桌房主）：延长训练时长
    socket.on('extend_match', ({ minutes }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以加时'); return; }
        const m = clampInt(minutes, 0, 120, 0);
        if (m <= 0) return;
        extendTable(roomId, m * 60000);
        io.in(roomId).emit('server_msg', `⏱ 房主加时 ${m} 分钟`);
        broadcastState(roomId);
        const betweenHands = game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN;
        if (!game.paused && game.status === 'running' && betweenHands && liveCount(game) >= 2) startHand(roomId);
    });

    // 调整预计结束时间：可延长或缩短；到点只暂停发新牌，不自动结算。
    socket.on('adjust_match_end', ({ endAt }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以调整结束时间'); return; }
        const requested = Number(endAt);
        const now = Date.now();
        if (!Number.isFinite(requested) || requested < now - 10000 || requested > now + 24 * 3600000) {
            socket.emit('server_msg', '⚠️ 结束时间无效（最多可设置到 24 小时后）'); return;
        }
        const result = adjustTableEnd(roomId, requested);
        if (!result) return;
        const format = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        if (result.timeExpired) {
            io.in(roomId).emit('server_msg', '⏸️ 房主已将比赛调整为现在到时，暂停发新牌');
        } else {
            io.in(roomId).emit('server_msg', `⏱ 房主将预计结束时间调整为 ${format(result.endAt)}`);
        }
        broadcastState(roomId);
        const betweenHands = game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN;
        if (!game.timeExpired && !game.paused && game.status === 'running' && betweenHands && liveCount(game) >= 2) startHand(roomId);
    });

    // 现金桌补码：金币按汇率买入筹码，下一手生效（不能超过带入上限）；可设自动补码
    socket.on('rebuy', ({ amount, auto }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        const p = game.players.find(x => x.userId === user.id);
        if (!p) return;
        if (typeof auto === 'boolean') p.autoRebuy = auto;
        const maxB = game.config.maxBuyIn || 1e9;
        const cap = maxB - p.chips - (p.pendingRebuy || 0);
        if (amount === 0 || amount == null) {   // 仅切换自动补码、不补当前码
            io.in(roomId).emit('server_msg', `🔁 ${user.username} ${p.autoRebuy ? '开启' : '关闭'}自动补码`);
            broadcastState(roomId); return;
        }
        if (cap <= 0) { socket.emit('server_msg', '⚠️ 已达带入上限'); return; }
        const chips = clampInt(amount, gameBB(game), cap, Math.min(cap, game.config.minBuyIn));
        if (!chargeRebuy(game, p, chips)) { socket.emit('server_msg', `⚠️ 金币不足，补 ${chips} 筹码需 ${Math.ceil(chips * BUYIN_RATE)} 金币`); return; }
        user.gold = db.getUserById(user.id).gold;
        const between = game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN;
        const inActiveHand = !between && !p.folded;
        if (inActiveHand) {
            io.in(roomId).emit('server_msg', `💵 ${user.username} 补码 ${chips}（下一手生效）`);
        } else {
            // 不在牌局中：立即生效，回到座位
            p.chips += p.pendingRebuy; p.pendingRebuy = 0; p.sittingOut = false;
            io.in(roomId).emit('server_msg', `💵 ${user.username} 补码 ${chips} 筹码`);
            // 若比赛进行中且当前停摆，重新排下一手
            if (game.status === 'running' && between && liveCount(game) >= 2) scheduleNextHand(roomId);
        }
        broadcastState(roomId);
    });

    // 房主点「开始」：开赛前手动开局（≥2 名在座可玩玩家）
    socket.on('start_game', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以开始'); return; }
        if (game.status === 'running') { socket.emit('server_msg', '⚠️ 比赛已开始'); return; }
        if (liveCount(game) < 2) { socket.emit('server_msg', '⚠️ 至少 2 名玩家入座才能开始'); return; }
        beginPlay(roomId);
    });

    // 准备 / 取消准备：全员准备且 >=2 人时自动开局
    socket.on('toggle_ready', (roomId) => {
        const game = roomGames[roomId];
        if (!game) return;
        // 仅开赛前需要准备；比赛开始后自动续局，无需重新准备
        if (game.roomType === 'sng' && game.status === 'running') return;
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', '⚠️ 牌局进行中，无法更改准备状态'); return;
        }
        const p = game.players.find(p => p.userId === user.id);
        if (!p) { socket.emit('server_msg', '⚠️ 你还未入座'); return; }
        p.ready = !p.ready;
        io.in(roomId).emit('server_msg', `${p.ready ? '✅' : '⬜'} ${p.username} ${p.ready ? '已准备' : '取消准备'}`);
        broadcastState(roomId);
        tryStartHand(roomId);
    });


}

module.exports = { registerTableControlEvents };
