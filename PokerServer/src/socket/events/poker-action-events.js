'use strict';

function registerPokerActionEvents(context) {
    const { socket, user, io, db, stats, Deck, config, runtime, tableService, syncRecentVoices } = context;
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, RUNIT_MAX, RUNIT_DECIDE_MS, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, clampInt, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, onActionTimeout, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction, persistence } = tableService;
    socket.on('player_action', ({ roomId, action, amount }) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.actionOnIdx < 0 || game.players[game.actionOnIdx]?.userId !== user.id) {
            socket.emit('server_msg', '⚠️ 不是你的回合'); return;
        }

        const player = game.players[game.actionOnIdx];
        // 兜底：已全押/已弃牌的人一律不能再行动——他的筹码已在池中、本就无需决策。
        // 万一 actionOnIdx 因任何原因指错（曾出现：全押亮牌后没清行动位，导致他能把牌弃掉、白丢池权），
        // 也不能让这类操作落地。这是服务端权威校验，不依赖客户端是否把按钮藏好。
        if (!canAct(player)) { socket.emit('server_msg', '⚠️ 你已全押/已弃牌，无需再行动'); return; }
        const tag = player.username;

        switch (action) {
            case 'fold':
                player.folded = true; player.hasActed = true;
                io.in(roomId).emit('server_msg', `❌ ${tag} 弃牌`);
                break;

            case 'check':
                if (player.currentBet < game.currentBet) {
                    socket.emit('server_msg', '⚠️ 有未跟注，不能 Check'); return;
                }
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `✓ ${tag} 过牌`);
                break;

            case 'call': {
                const toCall = game.currentBet - player.currentBet;
                if (toCall <= 0) { socket.emit('server_msg', '⚠️ 无需跟注'); return; }
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay; player.currentBet += pay;
                if (player.chips === 0) player.allIn = true;
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `📞 ${tag} 跟注 ${pay}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'bet': {
                if (game.currentBet > 0) { socket.emit('server_msg', '⚠️ 已有下注，请用 Raise'); return; }
                const betTo = parseInt(amount);
                const maxBet = player.currentBet + player.chips;   // 全下额
                const allInBet = betTo === maxBet;
                const minBet = gameBB(game);
                // 最小下注 = 大盲（不足大盲只能全下）
                if (!betTo || (betTo < minBet && !allInBet)) {
                    socket.emit('server_msg', `⚠️ 下注最少 ${minBet}`); return;
                }
                if (betTo > maxBet) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                player.chips -= betTo; player.currentBet = betTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = betTo;
                game.lastRaiseSize = betTo;   // 首注额即为后续最小加注增量基准
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `💸 ${tag} 下注 ${betTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'raise': {
                if (game.currentBet === 0) { socket.emit('server_msg', '⚠️ 无人下注，请用 Bet'); return; }
                // 无效加注规则：若我本街已行动过，且现在面对的加注量不足「一个完整加注」（前方只是短码全押/无效加注），
                // 则行动没有被重开——我只能跟注或弃牌，不能再加注。（正常德扑规则）
                if (player.hasActed && (game.currentBet - player.currentBet) < game.lastRaiseSize) {
                    socket.emit('server_msg', '⚠️ 前方是无效加注（全押不足一个完整加注），你只能跟注或弃牌'); return;
                }
                const raiseTo = parseInt(amount);
                const maxRaise = player.currentBet + player.chips;          // 全下额
                const allInRaise = raiseTo === maxRaise;
                const minRaiseTo = game.currentBet + game.lastRaiseSize;    // 最小加注目标
                if (!raiseTo || raiseTo <= game.currentBet) {
                    socket.emit('server_msg', `⚠️ 加注须大于当前注 ${game.currentBet}`); return;
                }
                // 未达最小加注：仅当全下时允许（all-in for less）
                if (raiseTo < minRaiseTo && !allInRaise) {
                    socket.emit('server_msg', `⚠️ 至少加注到 ${minRaiseTo}（最小加注增量 ${game.lastRaiseSize}）`); return;
                }
                const needed = raiseTo - player.currentBet;
                if (needed > player.chips) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                const increment = raiseTo - game.currentBet;
                const fullRaise = increment >= game.lastRaiseSize;   // 达到完整加注增量才算「完整加注」
                if (fullRaise) game.lastRaiseSize = increment;       // 完整加注才刷新最小增量
                player.chips -= needed; player.currentBet = raiseTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = raiseTo;
                // 只有「完整加注」才重开行动（前方已行动者可再加注）；短码全押=无效加注，不重开，
                // 前方已行动者保持 hasActed=true → 只需补齐跟注、不能再加（配合上面的拒绝逻辑）。
                if (fullRaise) {
                    game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                }
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `🔼 ${tag} 加注到 ${raiseTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            default: return;
        }

        recordAction(game, player, action, player.currentBet);   // 牌谱

        // 行动音效
        let sfxType = action;
        if ((action === 'bet' || action === 'raise' || action === 'call') && player.allIn) sfxType = 'allin';
        io.in(roomId).emit('sfx', sfxType);

        clearActionTimer(game);   // 玩家已行动，取消其计时
        afterAction(roomId);
        maybeShowStraddleAfterAction(roomId, player.userId);
    });

    // 多次发牌：落后方选发几次（1~5）。n=1 直接单次；n>1 交由领先方同意
    socket.on('propose_runs', ({ n } = {}) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || !game.runItPending || !game.runIt) return;
        if (game.runIt.deciderId !== user.id) { socket.emit('server_msg', '⚠️ 由落后方选择发牌次数'); return; }
        n = Math.max(1, Math.min(RUNIT_MAX, parseInt(n) || 1));
        if (n <= 1) { resolveRunIt(roomId, 1, 'single'); return; }
        game.runIt.n = n;
        // 为领先方重置一个完整的决策窗口（落后方选号已耗掉部分时间，否则领先方时间被压缩、
        // 容易错过同意 → 误退化成发 1 次。线上事故 room150331 就是这么丢的钱）
        const deadlineAt = Date.now() + RUNIT_DECIDE_MS;
        game.runIt.deadlineAt = deadlineAt;
        clearTimeout(game.runItTimer);
        game.runItTimer = setTimeout(() => resolveRunIt(roomId, 1, 'timeout'), RUNIT_DECIDE_MS);
        persistence.commit(roomId, 'runit_proposed', user.id, { n });   // 持久化：重启可恢复协商状态
        io.in(roomId).emit('runit_proposal', { n, byUserId: user.id, leaderId: game.runIt.leaderId, deadlineAt });
        io.in(roomId).emit('server_msg', `🎲 落后方提议发 ${n} 次，等待领先方同意…`);
    });
    // 领先方回应：同意→发 n 次；拒绝→发 1 次
    socket.on('respond_runs', ({ agree } = {}) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || !game.runItPending || !game.runIt) return;
        if (game.runIt.leaderId !== user.id) { socket.emit('server_msg', '⚠️ 由领先方同意'); return; }
        resolveRunIt(roomId, agree ? game.runIt.n : 1, agree ? 'agreed' : 'declined');
    });

    // 加时：仅当前行动玩家可用；每次 +15s 消耗 1 张时间卡；单次行动累计仍上限 EXTRA_MAX(2min)
    socket.on('add_time', (roomId) => {
        const game = roomGames[roomId] || roomGames[socket.currentRoom];
        if (!game || game.actionOnIdx < 0) return;
        const actor = game.players[game.actionOnIdx];
        if (!actor || actor.userId !== user.id) return;
        if ((game.extraAddedThisTurn || 0) >= EXTRA_MAX) {
            socket.emit('server_msg', '⚠️ 本次行动加时已达上限（2 分钟）'); return;
        }
        if ((actor.timeCards || 0) <= 0) { socket.emit('server_msg', '⚠️ 没有时间卡了'); return; }
        const add = Math.min(EXTRA_STEP, EXTRA_MAX - (game.extraAddedThisTurn || 0));
        actor.timeCards -= 1;
        game.extraAddedThisTurn = (game.extraAddedThisTurn || 0) + add;
        game.actionDeadline += add;
        game.actionTotalMs = (game.actionTotalMs || ACTION_TIME) + add;
        clearActionTimer(game);
        game.actionTimer = setTimeout(() => onActionTimeout(roomId), Math.max(0, game.actionDeadline - Date.now()));
        io.in(roomId).emit('server_msg', `⏱ ${user.username} 加时 +${add / 1000}s（剩 ${actor.timeCards} 张时间卡）`);
        broadcastState(roomId);
    });


}

module.exports = { registerPokerActionEvents };
