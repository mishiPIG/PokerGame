'use strict';

function registerSocketHandlers({ io, db, stats, Deck, config, runtime, tableService, syncRecentVoices }) {
    const { PHASES, STANDARD_BLIND_LEVELS, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE,
        RUNIT_MAX, EXTRA_MAX, EXTRA_STEP, ACTION_TIME, gameBB, sngPrize } = config;
    const { roomGames, lobbySockets } = runtime;
    const { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList, genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer, startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand, liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer, doShowdown, dealCommunity, recordAction } = tableService;
io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`[+] ${user.username} 上线`);
    socket.emit('gold_update', { gold: user.gold });
    socket.emit('profile', { avatar: db.getUserById(user.id)?.avatar || null });

    // 网络延迟测量：回声
    socket.on('latency_ping', (t) => socket.emit('latency_pong', t));

    // 设置头像：持久化 + 更新在座玩家 + 重广播
    socket.on('set_avatar', ({ avatar }) => {
        if (avatar && typeof avatar !== 'string') return;
        db.setAvatar(user.id, avatar || null);
        user.avatar = avatar || null;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const p = game.players.find(pl => pl.userId === user.id);
            if (p) { p.avatar = avatar || null; broadcastState(roomId); }
        }
        socket.emit('profile', { avatar: avatar || null });
    });

    // 进入大厅：订阅房间列表
    socket.on('enter_lobby', () => {
        lobbySockets.add(socket.id);
        socket.currentRoom = null;
        socket.emit('room_list', listRooms(user.id));
    });

    // 创建 SNG 房间（双人升盲），创建者自动入座
    socket.on('create_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'sng', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            config: {
                name:        (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的比赛`,
                maxPlayers:  clampInt(cfg.maxPlayers, 2, 9, 2),              // 2–9 人（引擎已支持多人）
                startingStack: clampInt(cfg.startingStack, 5000, 30000, 10000),
                levelMinutes:  clampInt(cfg.levelMinutes, 3, 10, 3),
                buyIn:         SNG_BUYIN_TIERS.includes(+cfg.buyIn) ? +cfg.buyIn : SNG_BUYIN_TIERS[0]
            },
            blindLevels: STANDARD_BLIND_LEVELS,
            currentLevel: 0, levelStartTime: null, prizePool: 0, tournamentOver: false,
            statsHistory: []
        };
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格
        if (!seatPlayer(roomId, socket, user)) { delete roomGames[roomId]; }
        else emitRoomInviteInfo(socket, roomGames[roomId], true);
    });

    // 创建现金桌（2–9 人，固定盲注，金币↔筹码买入），创建者按 buyInChips 买入
    socket.on('create_cash_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        const bb = clampInt(cfg.bb, 20, 1000, 40);
        const sb = clampInt(cfg.sb, 10, bb, Math.floor(bb / 2));
        const minBuyIn = clampInt(cfg.minBuyIn, 2000, 8000, 2000);
        const maxBuyIn = clampInt(cfg.maxBuyIn, 0, 60000, 0);   // 0=无限制
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'cash', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            config: {
                name:      (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的现金桌`,
                maxPlayers: clampInt(cfg.maxPlayers, 2, 9, 6),
                sb, bb, ante: clampInt(cfg.ante, 0, 80, 0), minBuyIn, maxBuyIn,
                allowUtgStraddle: cfg.allowUtgStraddle === true,
                durationH: [0.5, 1, 2, 3, 4, 5, 6].includes(+cfg.durationH) ? +cfg.durationH : 2
            },
            prizePool: 0, tournamentOver: false,
            statsHistory: [], tableEndAt: null, extraMs: 0
        };
        // 现金桌：房主先以观众身份进桌，点空座位「坐下」再带入（坐下式入座）
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格（无需再输房号）
        joinAsSpectator(roomId, socket);
        emitRoomInviteInfo(socket, roomGames[roomId], true);
    });

    // 统一加入已有房间：公开 roomId 只能用于观战；下场资格完全来自服务端 authorized。
    const handleJoinRoom = (roomId) => {
        roomId = String(roomId || '');
        const game = roomGames[roomId];
        if (!game) { socket.emit('server_msg', '⚠️ 房间不存在或已结束'); socket.emit('room_list', listRooms(user.id)); return; }
        clearTimeout(game.emptyCleanupTimer);   // 有人（回来/加入）→ 取消空房清理

        // 已验证邀请、原座上成员、站起围观者本就有资格。绝不信任客户端 byCode 布尔值。
        const isKnownMember = game.authorized?.has(user.id)
            || game.players.some(p => p.userId === user.id)
            || (game.vacatedPlayers || []).some(v => v.userId === user.id);
        if (isKnownMember) {
            socket.playRoom = roomId;
            authorize(roomId, user.id);
        } else if (socket.playRoom === roomId) {
            socket.playRoom = null;
        }

        // 断线重连
        const existing = game.players.find(p => p.userId === user.id);
        if (existing) {
            existing.socketId = socket.id;
            existing.away = false;   // 重连后恢复在桌
            // 重连/重新进入即取消留座倒计时；站起或留座回来，有筹码则接上原座位继续（战绩不清零）
            if (existing.reserveTimer) { clearTimeout(existing.reserveTimer); existing.reserveTimer = null; }
            if (existing.reserved || existing.standing) {
                existing.reserved = false; existing.standing = false;
                if (existing.chips > 0) existing.sittingOut = false;
            }
            lobbySockets.delete(socket.id);
            socket.join(roomId);
            socket.currentRoom = roomId;
            socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
            socket.emit('server_msg', '🔄 重新连接成功');
            if (game.holeCards[user.id]) {
                socket.emit('hole_cards', game.holeCards[user.id].map(c => ({ suit: c.suit, rank: c.rank })));
            }
            // 若正轮到他行动，重连后重启计时（away 已置 false → 恢复满时长，并取消可能的 away 快速超时）
            if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN
                && game.actionOnIdx >= 0 && game.players[game.actionOnIdx]?.userId === user.id) {
                startActionTimer(roomId);
            }
            // 现金桌：重新进入后若在局间且够人，恢复续局
            else if (game.roomType === 'cash' && game.status === 'running' && !existing.sittingOut
                && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2) {
                scheduleNextHand(roomId);
            }
            broadcastState(roomId);
            emitStraddleOffer(game, socket); // 重连时恢复仍在有效期内的一次性选择卡
            broadcastRoomList();
            return;
        }

        if (game.roomType === 'cash') {
            // 现金桌：先进桌当观众，点空座「坐下」再带入（坐下时校验 playRoom）
            joinAsSpectator(roomId, socket);
            return;
        }
        // SNG：从大厅列表点进=只观战；只有服务端已授权成员才能落座。
        if (!isKnownMember) { joinAsSpectator(roomId, socket); return; }
        // SNG 不许中途加入（开赛即锁定座位）
        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', '⚠️ 房间已满'); return; }
        if (game.status === 'running') { socket.emit('server_msg', '⚠️ 比赛已开始，无法加入'); return; }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) { socket.emit('server_msg', '⚠️ 牌局进行中，请稍后'); return; }
        seatPlayer(roomId, socket, user);
    };

    // byCode 保留在形参外：旧页面即使发送 byCode:true，也只能按未授权用户观战。
    socket.on('join_room', (payload = {}) => handleJoinRoom(payload?.roomId));

    socket.on('join_by_code', (payload = {}) => {
        const code = String(payload?.code || '').trim();
        if (codeAttemptLimited(socket, user.id)) {
            socket.emit('invite_error', { source: 'code', message: '尝试次数过多，请稍后再试' });
            return;
        }
        const match = findRoomByJoinCode(code);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            recordCodeFailure(socket, user.id);
            socket.emit('invite_error', { source: 'code', message: '房间码无效或当前不可加入' });
            return;
        }
        const [roomId] = match;
        clearUserCodeFailures(user.id);
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('join_by_invite', (payload = {}) => {
        const token = String(payload?.token || '').trim();
        const match = findRoomByInviteToken(token);
        if (!match || !canAuthorizeNewUser(match[1], user.id)) {
            socket.emit('invite_error', { source: 'link', message: '邀请已失效或当前不可加入' });
            return;
        }
        const [roomId] = match;
        authorize(roomId, user.id);
        socket.playRoom = roomId;
        handleJoinRoom(roomId);
    });

    socket.on('get_room_invite', () => {
        const game = socket.currentRoom && roomGames[socket.currentRoom];
        if (!game || game.ownerUserId !== user.id) return;
        emitRoomInviteInfo(socket, game);
    });

    socket.on('set_entry_locked', (payload = {}) => {
        const locked = payload?.locked;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id || typeof locked !== 'boolean') return;
        game.invite.entryLocked = locked;
        emitRoomInviteInfo(socket, game);
        io.in(roomId).emit('server_msg', locked ? '🔒 房主已锁定新玩家入场' : '🔓 房主已开放新玩家入场');
    });

    socket.on('reset_room_invite', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.ownerUserId !== user.id) return;
        const locked = !!game.invite?.entryLocked;
        const version = (game.invite?.version || 0) + 1;
        const oldCode = game.invite?.joinCode || '';
        game.invite = createRoomInvite(roomId, oldCode);
        game.invite.entryLocked = locked;
        game.invite.version = version;
        emitRoomInviteInfo(socket, game);
        socket.emit('server_msg', '🔄 邀请链接和房间码已重置');
    });

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
            io.in(roomId).emit('server_msg', `⌛ ${pp.username} 留座超时，自动站起围观（筹码保留）`);
            broadcastState(roomId); broadcastRoomList();
        }, 120000);
        io.in(roomId).emit('server_msg', `💺 ${user.username} 留座离座（2 分钟内回来保留座位）`);
        // 若本手进行中：本手弃牌坐出并推进行动（尤其正轮到他时，别让全桌干等到超时）
        const idx = game.players.findIndex(pl => pl.userId === user.id);
        const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded;
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
        io.in(roomId).emit('server_msg', `🪑 ${user.username} 回到座位`);
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
                const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded;
                if (game.roomType === 'cash') {
                    // 训练赛：退出房间 = 站起离桌，保留座位+筹码，【不立即兑出】；
                    // 只在本局结束/解散/全员离开时统一结算金币。回大厅可随时「重新进入」
                    // 接上原座位、带入与盈亏（战绩不清零）。
                    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
                    p.standing = true; p.away = true; p.reserved = false; p.sittingOut = true;
                    socket.leave(roomId);
                    socket.emit('left_room');
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开牌桌（座位与筹码保留，结束时结算）`);
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
                } else if (game.status !== 'running') {
                    // SNG 开赛前退出：退还报名费、移除座位
                    if (game.config.buyIn > 0) {
                        const fresh = db.getUserById(user.id).gold;
                        db.setGold(user.id, fresh + game.config.buyIn);
                        game.prizePool = Math.max(0, (game.prizePool || 0) - game.config.buyIn);
                        user.gold = fresh + game.config.buyIn;
                        socket.emit('gold_update', { gold: user.gold });
                    }
                    game.players.splice(idx, 1);
                    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开房间`);
                    if (game.players.length === 0) {
                        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
                        clearActionTimer(game); delete roomGames[roomId];
                    } else broadcastState(roomId);
                } else {
                    // SNG 开赛后退出：保留座位（离桌挂机），本局自动弃牌推进
                    p.away = true;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离桌（座位保留，盲注照扣，可重连）`);
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

    // 解散/提前结束：仅房主。现金桌=结算筹码+公布排名；SNG=奖池给筹码领先者+公布排名
    socket.on('dissolve_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以解散房间'); return; }

        if (game.roomType === 'cash') {
            io.in(roomId).emit('server_msg', `🛑 房主提前结束了比赛`);
            endCashTable(roomId, '房主提前结束');   // 结算 + 排名 + 收件箱
            return;
        }
        // SNG：奖池（抽水后）给当前筹码最多者，并公布排名
        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer); clearTimeout(game.runItTimer); game.runItPending = false; clearActionTimer(game);
        for (const p of game.players) if (p.reserveTimer) clearTimeout(p.reserveTimer);
        const prize = sngPrize(game.prizePool);
        const leader = [...game.players].sort((a, b) => b.chips - a.chips)[0];
        if (leader && prize > 0) {
            const fresh = db.getUserById(leader.userId).gold;
            db.setGold(leader.userId, fresh + prize);
            if (leader.socketId) io.to(leader.socketId).emit('gold_update', { gold: fresh + prize });
        }
        sendMatchResult(roomId, `【${game.config.name}】房主提前结束`, buildRanking(game, leader && leader.userId, prize));
        io.in(roomId).emit('server_msg', `🛑 房主解散了房间`);
        io.in(roomId).emit('room_dissolved');
        for (const p of game.players) {
            const s = io.sockets.sockets.get(p.socketId);
            if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('room_list', listRooms(p.userId)); }
        }
        delete roomGames[roomId];
        broadcastRoomList();
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

    // 主动亮牌：摊牌阶段（含弃牌结束的局间）玩家可选择亮出自己某张/全部底牌
    socket.on('show_card', ({ roomId, index }) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const hole = game.holeCards[user.id];
        if (!hole) return;
        index = parseInt(index);
        if (index !== 0 && index !== 1) return;
        game.shownCards = game.shownCards || {};
        const set = game.shownCards[user.id] || (game.shownCards[user.id] = new Set());
        if (set.has(index)) return;
        set.add(index);
        const shown = [...set].map(i => ({ index: i, suit: hole[i].suit, rank: hole[i].rank }));
        io.in(roomId).emit('show_cards', { userId: user.id, cards: shown });
        io.in(roomId).emit('server_msg', `👁️ ${user.username} 亮出一张牌`);
        // 每亮一张牌就重置局间倒计时，给大家看牌的时间
        scheduleNextHand(roomId);
    });

    // 看后续牌（rabbit hunt）：弃牌结束的局间，任一玩家可逐步发出剩余公共牌仅供观看
    socket.on('rabbit_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const n = game.communityCards.length;
        if (n >= 5) return;                       // 已到河牌（含真摊牌），无可发
        const count = n === 0 ? 3 : 1;            // 0→翻牌3张，3→转牌1张，4→河牌1张
        const streetName = n === 0 ? '翻牌' : (n === 3 ? '转牌' : '河牌');
        // 公共牌下方显示一行字：谁想看（不走弹幕、不加表情）
        io.in(roomId).emit('table_notice', { text: `${user.username} 想看${streetName}` });
        const dealt = dealCommunity(game, count);
        io.in(roomId).emit('server_msg', `🐰 看后续牌：${dealt.map(c => c.toString()).join(' ')}`);
        scheduleNextHand(roomId);                 // 重置局间倒计时，给看牌时间
        broadcastState(roomId);
    });

    // 桌内文字聊天：广播给同房间（含观众）。限频 + 长度限制
    socket.on('chat_msg', ({ text }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        text = (text || '').toString().slice(0, 120).trim();
        if (!text) return;
        const now = Date.now();
        if (now - (socket._lastChat || 0) < 600) return;   // 限频 0.6s
        socket._lastChat = now;
        io.in(roomId).emit('chat_broadcast', { userId: user.id, username: user.username, text, ts: now });
    });

    // 表情/互动：在发送者座位上方冒一个大表情（可带目标=扔给某人）。限频
    socket.on('emote', ({ emote, targetUserId }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        if (typeof emote !== 'string' || emote.length > 8) return;
        const now = Date.now();
        if (now - (socket._lastEmote || 0) < 800) return;   // 限频 0.8s
        socket._lastEmote = now;
        io.in(roomId).emit('emote_broadcast', { userId: user.id, emote, targetUserId: targetUserId || null });
    });

    // 点头像看「本局」数据（VPIP/PFR/3bet/ATS…）：按当前房间聚合，摊牌信息公开可见
    socket.on('req_player_stats', ({ targetUserId }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        const uid = targetUserId || user.id;
        socket.emit('player_stats', { userId: uid, stats: stats.computeUserStats(uid, null, roomId) });
    });

    // 重连/刷新后只恢复尚在 10 秒展示期内的语音气泡，不构成聊天历史。
    socket.on('voice_sync', (roomId) => {
        roomId = String(roomId || '');
        if (socket.currentRoom !== roomId || !roomGames[roomId]) return;
        syncRecentVoices(socket, roomId);
    });

    socket.on('player_action', ({ roomId, action, amount }) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.actionOnIdx < 0 || game.players[game.actionOnIdx]?.userId !== user.id) {
            socket.emit('server_msg', '⚠️ 不是你的回合'); return;
        }

        const player = game.players[game.actionOnIdx];
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
                // 完整加注才刷新最小增量；all-in for less 不重开下注（保持原增量）
                if (increment >= game.lastRaiseSize) game.lastRaiseSize = increment;
                player.chips -= needed; player.currentBet = raiseTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = raiseTo;
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
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
        io.in(roomId).emit('runit_proposal', { n, byUserId: user.id, leaderId: game.runIt.leaderId });
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

    socket.on('disconnect', () => {
        console.log(`[-] ${user.username} 下线`);
        lobbySockets.delete(socket.id);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        const player = game.players[idx];
        player.away = true;   // 标记掉线（座位保留，可重连）

        io.to(roomId).emit('server_msg', `🔌 ${user.username} 掉线（保留座位，可重连）`);

        // ⚠️ 不再「掉线即立即弃牌」！socket.io 网络抖动/传输切换会瞬断重连，
        // 立即弃牌会误杀正常玩家（表现为「闪回大厅再进来就成了弃牌」）。
        // 改为交给行动计时器兜底：
        //  · 若正轮到掉线者：保留当前计时不动，给重连留出时间；到点 onActionTimeout
        //    会「无注则自动过牌(留在局里)、有注才弃牌」——比无条件弃牌合理得多。
        //  · 若没轮到他：留在本局，等轮到他时 startActionTimer 见 away 走快速超时自动处理。
        // 重连(join_room)会把 away 置回 false 并（若轮到他）重启计时。
        broadcastState(roomId);
    });
});


}

module.exports = { registerSocketHandlers };
