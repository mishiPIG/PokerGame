'use strict';
const { nameOf } = require('../../account/display-name');
const { bind } = require('./room-context');
const { createMembershipService } = require('../../rooms/membership-service');
function createJoinRoomHandler(context) {
    const { socket, user, io, runtime, tableService, config } = bind(context);
    const membershipService = createMembershipService({ io, runtime, tableService, config });
    return roomId => membershipService.joinRoom(socket, user, roomId);
}
function registerMembershipEvents(context) {
    const { socket, user, io, db, roomGames, lobbySockets, PHASES, broadcastState, broadcastRoomList, persistence,
        clearActionTimer, afterAction, isBettingRoundComplete, advanceStage, liveCount,
        restoreVacatedPlayer, seatPlayer, occupiedSeats, standUpPlayer, clearStraddleDecision, advanceStraddleChain, resolveRunIt,
        prepareNextStraddleDecision, emitStraddleOffer, scheduleNextHand, listRooms,
        endCashTable, sngPrize, buildRanking, sendMatchResult, extendTable, chargeRebuy,
        gameBB, BUYIN_RATE, CASHOUT_RATE, clampInt, joinAsSpectator, startHand, listSpectators,
        scheduleEmptyCleanup } = bind(context);
    // 坐下入座（现金桌坐下式）：观众点空座位 → 带入筹码正式入座
    socket.on('sit_down', ({ buyInChips, seat }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.roomType !== 'cash') { socket.emit('server_msg', '⚠️ 该房间无需坐下'); return; }
        if (game.players.find(p => p.userId === user.id)) { socket.emit('server_msg', '⚠️ 你已入座'); return; }
        // 站起围观者点座位坐下：带原筹码回座（不重复扣买入 + 清 vacated 记录），杜绝「两个自己」
        if (restoreVacatedPlayer(roomId, socket, user, seat)) return;
        // 防陌生人捣乱：从大厅列表点进来的是观战，必须先验证邀请链接或四位房间码。
        if (socket.playRoom !== roomId) { socket.emit('server_msg', '👀 你在观战——请使用邀请链接或四位房间码加入后再入座'); return; }
        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', '⚠️ 座位已满'); return; }
        if (occupiedSeats(game).has(seat)) { socket.emit('server_msg', '⚠️ 该座位已被占用'); return; }
        if (seatPlayer(roomId, socket, user, buyInChips, seat)) {
            // 带入额已在 seatPlayer 内记录（buyIn=chips），此处不再重复累加
            // 入座后若满足开局条件且现金桌进行中/可开，尝试开局
            if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) {
                if (game.status === 'running') { if (liveCount(game) >= 2) startHand(roomId); }
            }
        }
    });

    // 站起围观（现金桌）：离座腾位（座位变空、他人可坐），转观众；筹码保留，只在结束/解散时结算
    socket.on('stand_up', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') { socket.emit('server_msg', '⚠️ 仅现金桌可站起'); return; }
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        standUpPlayer(roomId, idx, false);
    });

    // 房主强制某玩家站起到观战席（腾出座位，让退出游戏的玩家让位）。筹码保留、结束时结算。
    socket.on('force_stand', ({ targetUserId }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') { socket.emit('server_msg', '⚠️ 仅现金桌可操作'); return; }
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可强制玩家站起'); return; }
        if (targetUserId === user.id) { socket.emit('server_msg', '⚠️ 不能强制自己，请用「站起围观」'); return; }
        const idx = game.players.findIndex(p => p.userId === targetUserId);
        if (idx < 0) { socket.emit('server_msg', '⚠️ 该玩家不在座'); return; }
        standUpPlayer(roomId, idx, true);
    });

    // 房主暂停/继续发牌：暂停后本手结束不开新局；继续后立即续局
    socket.on('pause_dealing', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可暂停发牌'); return; }
        game.paused = true;
        io.in(roomId).emit('server_msg', '⏸️ 房主已暂停发牌（当前这手打完后暂停，可随时继续）');
        broadcastState(roomId);
    });

    socket.on('set_utg_straddle', ({ enabled }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        if (game.ownerUserId !== user.id) {
            socket.emit('server_msg', '⚠️ 只有房主可修改 Straddle 设置'); return;
        }
        const next = enabled === true;
        if (!!game.config.allowUtgStraddle === next) return;
        game.config.allowUtgStraddle = next;
        if (!next) {
            const d = game.straddleDecision;
            if (d && d.status === 'pending') {
                const p = game.players.find(x => x.userId === d.candidateUserId);
                const s = p && io.sockets.sockets.get(p.socketId);
                if (s) s.emit('straddle_decision_result', {
                    targetHandSeq: d.targetHandSeq, status: 'invalidated'
                });
            }
            clearStraddleDecision(game);
            game.straddleDecision = null;
        } else if (game.status === 'running'
            && game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            prepareNextStraddleDecision(roomId);
        }
        io.in(roomId).emit('server_msg', next
            ? '🔥 房主已开启 UTG Straddle（2BB），下一手起生效'
            : '房主已关闭 UTG Straddle');
        broadcastState(roomId);
        broadcastRoomList();
    });

    socket.on('straddle_decision', ({ targetHandSeq, accept }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        const d = game && game.straddleDecision;
        if (!game || game.roomType !== 'cash' || !d) return;
        if (d.status !== 'pending' || !d.offeredAt || d.deadlineAt <= Date.now()
            || d.targetHandSeq !== parseInt(targetHandSeq)
            || d.candidateUserId !== user.id) {
            socket.emit('straddle_decision_result', {
                targetHandSeq: parseInt(targetHandSeq), status: 'invalidated'
            });
            return;
        }
        clearTimeout(d.timer); d.timer = null;
        d.status = accept === true ? 'accepted' : 'declined';
        socket.emit('straddle_decision_result', {
            targetHandSeq: d.targetHandSeq,
            status: d.status,
            amount: d.amount
        });
        persistence.commit(roomId, 'straddle_decided', user.id, { status: d.status, targetHandSeq: d.targetHandSeq });
        // 链式：接受后记入链，并立刻问下一位要不要再翻一倍（4BB → 8BB → …）
        if (d.status === 'accepted') advanceStraddleChain(roomId, d);
    });

    socket.on('resume_dealing', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可继续发牌'); return; }
        if (!game.paused) return;
        game.paused = false;
        io.in(roomId).emit('server_msg', '▶️ 房主已继续发牌');
        // 若当前在局间且满足开局条件，立即续上一局
        if (game.status === 'running' && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2) {
            startHand(roomId);
        } else broadcastState(roomId);
    });

    // 留座离座（现金桌）：保留座位、坐出本手，2 分钟内不回来自动站起兑出
    socket.on('reserve_leave', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        const p = game.players.find(pl => pl.userId === user.id);
        if (!p) return;
        p.away = true; p.reserved = true; p.sittingOut = true;
        p.reserveLeaveAt = Date.now() + 120000;
        if (p.reserveTimer) clearTimeout(p.reserveTimer);
        p.reserveTimer = setTimeout(() => {
            const g = roomGames[roomId]; if (!g) return;
            const pp = g.players.find(x => x.userId === user.id);
            if (!pp || !pp.reserved) return;
            // 留座超时：转为「站起围观」（坐出、筹码保留，不兑出），结束时再结算
            pp.reserved = false; pp.standing = true; pp.sittingOut = true; pp.reserveTimer = null;
            io.in(roomId).emit('server_msg', `⌛ ${nameOf(pp)} 留座超时，自动站起围观（筹码保留）`);
            broadcastState(roomId); broadcastRoomList();
        }, 120000);
        io.in(roomId).emit('server_msg', `💺 ${nameOf(user)} 留座离座（2 分钟内回来保留座位）`);
        // 若本手进行中：本手弃牌坐出并推进行动（尤其正轮到他时，别让全桌干等到超时）
        // ⚠️ 已全押者除外——筹码已在池中、无需再行动，改判弃牌会剥夺池权并造成筹码凭空增加
        const idx = game.players.findIndex(pl => pl.userId === user.id);
        const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded && !p.allIn;
        if (midHand) {
            p.folded = true; p.hasActed = true;
            if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
            else if (isBettingRoundComplete(game)) advanceStage(roomId);
            else broadcastState(roomId);
        } else broadcastState(roomId);
        broadcastRoomList();
    });

    // 回到座位（取消留座/坐出；站起围观者带原筹码回到一个空座）
    socket.on('sit_back', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        // 站起围观回座：从 vacatedPlayers 带原筹码回一个空座（与 sit_down 共用同一逻辑，避免重复条目）
        if (restoreVacatedPlayer(roomId, socket, user, -1)) return;
        const p = game.players.find(pl => pl.userId === user.id);
        if (!p) return;
        if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
        p.away = false; p.reserved = false; p.standing = false;
        if (p.chips > 0) p.sittingOut = false;   // 有筹码才能立即回桌
        io.in(roomId).emit('server_msg', `🪑 ${nameOf(user)} 回到座位`);
        if (game.roomType === 'cash' && game.status === 'running'
            && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2)
            scheduleNextHand(roomId);
        broadcastState(roomId);
    });

    // 退出房间，返回大厅
    socket.on('leave_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const idx = game.players.findIndex(p => p.userId === user.id);
            if (idx >= 0) {
                const p = game.players[idx];
                // ⚠️ 已全押者不算 midHand：筹码已在池中、本就无需再行动，退出时若把他改判弃牌，
                // 既剥夺其池权，又会让「未跟注退还」把对手已被跟的注错误退回 → 凭空造筹码。
                // 他应留在局里正常跑马/摊牌，离座延后到本手结束（vacateAfter/standing 已处理）。
                const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded && !p.allIn;
                if (game.roomType === 'cash') {
                    // 训练赛：退出房间 = 站起离桌，保留座位+筹码，【不立即兑出】；
                    // 只在本局结束/解散/全员离开时统一结算金币。回大厅可随时「重新进入」
                    // 接上原座位、带入与盈亏（战绩不清零）。
                    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
                    p.standing = true; p.away = true; p.reserved = false; p.sittingOut = true;
                    // 多次发牌协商中、而离开的正是要做决定的人 → 别让全桌干等满 45s，
                    // 立刻按「超时兜底」的同一结果回落成发 1 次（结论一致，只是不必再等）。
                    if (game.runItPending && game.runIt
                        && (game.runIt.deciderId === user.id || game.runIt.leaderId === user.id)) {
                        resolveRunIt(roomId, 1, 'left');
                    }
                    socket.leave(roomId);
                    socket.emit('left_room');
                    io.to(roomId).emit('server_msg', `🚪 ${nameOf(user)} 离开牌桌（座位与筹码保留，结束时结算）`);
                    if (midHand) { p.folded = true; p.hasActed = true; }
                    // 全员离桌(无人在座)且无观众 → 直接结算收尾，避免空房悬挂持有筹码
                    const anyActive = game.players.some(pl => !pl.standing && !pl.away);
                    if (!anyActive && listSpectators(roomId).length === 0) {
                        scheduleEmptyCleanup(roomId);   // 全员离开：空房保留 3 分钟再结算关闭（退出≠立即解散）
                    } else if (midHand) {
                        if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
                        else if (isBettingRoundComplete(game)) advanceStage(roomId);
                        else broadcastState(roomId);
                        broadcastRoomList();
                    } else { broadcastState(roomId); broadcastRoomList(); }
                } else if (game.status === 'waiting') {
                    // SNG 开赛前退出：退还报名费、移除座位（仅"从未开赛"才退，避免结束后离场被误退款）
                    const refund = game.config.buyIn || 0;
                    const oldPrizePool = game.prizePool || 0;
                    const oldButtonIdx = game.buttonIdx;
                    const oldSettlement = {
                        settlementGold: p.settlementGold,
                        settledAt: p.settledAt,
                        leftAt: p.leftAt
                    };
                    if (refund > 0) game.prizePool = Math.max(0, (game.prizePool || 0) - refund);
                    game.players.splice(idx, 1);
                    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
                    try {
                        if (refund > 0) {
                            p.settlementGold = refund; p.settledAt = Date.now(); p.leftAt = Date.now();
                            const committed = persistence.commitWithWallet(roomId, [{
                                userId: user.id,
                                delta: refund,
                                type: 'sng_refund',
                                matchId: game.matchId,
                                operationKey: `sng-refund:${game.matchId}:${user.id}`,
                                metadata: { reason: 'left_before_start' }
                            }], 'sng_refund', user.id, { refund }, [{
                                userId: p.userId,
                                username: p.username,
                                seat: p.seat,
                                status: 'settled',
                                buyinGoldTotal: p.buyInGold || refund,
                                buyinChipsTotal: p.buyIn || 0,
                                currentChips: p.chips || 0,
                                handsPlayed: p.handsPlayed || 0,
                                settlementGold: refund,
                                settledAt: p.settledAt,
                                joinedAt: p.joinedAt,
                                leftAt: p.leftAt
                            }]);
                            user.gold = committed.wallets[0].balance;
                            socket.emit('gold_update', { gold: user.gold });
                        } else persistence.commit(roomId, 'player_left', user.id);
                    } catch (error) {
                        game.players.splice(idx, 0, p);
                        game.prizePool = oldPrizePool;
                        game.buttonIdx = oldButtonIdx;
                        Object.assign(p, oldSettlement);
                        throw error;
                    }
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${nameOf(user)} 离开房间`);
                    if (game.players.length === 0) {
                        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
                        clearActionTimer(game); persistence.finish(roomId, 'cancelled'); delete roomGames[roomId];
                    } else broadcastState(roomId);
                } else if (game.tournamentOver || game.status === 'finished') {
                    // SNG 已分出胜负：奖金已结算，【不退报名费】；直接离开（房间会在宽限后自动解散）
                    game.players.splice(idx, 1);
                    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
                    socket.leave(roomId); socket.emit('left_room');
                    if (game.players.length === 0) {
                        clearTimeout(game.dissolveTimer); clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer);
                        clearTimeout(game.runoutTimer); clearActionTimer(game); persistence.finish(roomId, 'finished'); delete roomGames[roomId]; broadcastRoomList();
                    } else broadcastState(roomId);
                } else {
                    // SNG 开赛后退出：保留座位（离桌挂机），本局自动弃牌推进
                    p.away = true;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${nameOf(user)} 离桌（座位保留，盲注照扣，可重连）`);
                    if (midHand) {
                        p.folded = true; p.hasActed = true;
                        if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
                        else if (isBettingRoundComplete(game)) advanceStage(roomId);
                        else broadcastState(roomId);
                    } else broadcastState(roomId);
                }
            } else {
                // 观众离开（现金桌未入座）：退出 socket.io 房间并刷新观众列表
                socket.leave(roomId);
                // 仅当房间真的空了（无任何 socket，含未坐下的房主观众）才关房——
                // 否则房主创建后未落座、被路人观战一下再走会误删房间。
                const room = io.sockets.adapter.rooms.get(roomId);
                const trulyEmpty = game.players.length === 0 && (!room || room.size === 0);
                if (trulyEmpty) scheduleEmptyCleanup(roomId);   // 空房保留 3 分钟再关，可凭房号回来
                else { broadcastState(roomId); broadcastRoomList(); }
            }
        }
        socket.currentRoom = null;
        lobbySockets.add(socket.id);
        socket.emit('left_room');
        socket.emit('room_list', listRooms(user.id));
        broadcastRoomList();
    });


}
module.exports = { createJoinRoomHandler, registerMembershipEvents };
