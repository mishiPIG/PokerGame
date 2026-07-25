'use strict';

function createTableService({ io, db, stats, equity, Deck, HandEvaluator, crypto, config, runtime }) {
    const { PHASES, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND, STANDARD_BLIND_LEVELS, INITIAL_BB, gameSB, gameBB, gameAnte, timeCardsFor, ACTION_TIME, EXTRA_STEP, EXTRA_MAX, RUNOUT_DELAY, RUNIT_MAX, RUNIT_DECIDE_MS, STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS, FIXED_BUYIN, SNG_BUYIN_TIERS, BUYIN_RATE, CASHOUT_RATE, CONFIGURED_PUBLIC_ORIGIN, sngPrize } = config;
    const { roomGames, lobbySockets, inviteCodeFailuresByUser, inviteCodeFailuresByIp } = runtime;
function clearStraddleDecision(game, status = 'invalidated') {
    if (!game || !game.straddleDecision) return;
    clearTimeout(game.straddleDecision.timer);
    game.straddleDecision.timer = null;
    if (game.straddleDecision.status === 'pending') game.straddleDecision.status = status;
}

// 按预计可参与阵容计算下一手位置。game.buttonSeat 是当前/上一手按钮。
function projectedPositions(game, players = game.players.filter(p =>
    !p.sittingOut && (p.chips + (p.currentBet || 0) + (p.committed || 0)) > 0)) {
    const ordered = players.slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    if (ordered.length < 2) return null;
    const seats = ordered.map(p => p.seat);
    let buttonSeat;
    if (game.buttonSeat == null || game.buttonSeat < 0) buttonSeat = seats[0];
    else {
        buttonSeat = seats.find(s => s > game.buttonSeat);
        if (buttonSeat == null) buttonSeat = seats[0];
    }
    const buttonPos = ordered.findIndex(p => p.seat === buttonSeat);
    const sbPos = ordered.length === 2 ? buttonPos : (buttonPos + 1) % ordered.length;
    const bbPos = (sbPos + 1) % ordered.length;
    const utgPos = ordered.length >= 3 ? (bbPos + 1) % ordered.length : -1;
    return {
        ordered, buttonSeat,
        sb: ordered[sbPos], bb: ordered[bbPos],
        utg: utgPos >= 0 ? ordered[utgPos] : null
    };
}

function emitStraddleOffer(game, socket) {
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || !d.offeredAt || d.deadlineAt <= Date.now()) return;
    if (!socket || socket.user?.id !== d.candidateUserId) return;
    socket.emit('straddle_offer', {
        targetHandSeq: d.targetHandSeq,
        amount: d.amount,
        deadlineAt: d.deadlineAt
    });
}

function showStraddleDecision(roomId, durationMs = STRADDLE_DECISION_MS) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending') return false;
    const actorId = game.actionOnIdx >= 0 ? game.players[game.actionOnIdx]?.userId : null;
    if (actorId === d.candidateUserId) return false;
    clearTimeout(d.timer);
    d.offeredAt = Date.now();
    d.deadlineAt = d.offeredAt + durationMs;
    d.timer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.straddleDecision !== d || d.status !== 'pending') return;
        d.status = 'expired'; d.timer = null;
        const p = g.players.find(x => x.userId === d.candidateUserId);
        const s = p && io.sockets.sockets.get(p.socketId);
        if (s) s.emit('straddle_decision_result', { targetHandSeq: d.targetHandSeq, status: 'expired' });
    }, durationMs);
    emitStraddleOffer(game, io.sockets.sockets.get(
        game.players.find(x => x.userId === d.candidateUserId)?.socketId
    ));
    return true;
}

function prepareNextStraddleDecision(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearStraddleDecision(game);
    game.straddleDecision = null;
    if (game.roomType !== 'cash' || !game.config.allowUtgStraddle) return;
    if (game.status !== 'running'
        || game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) return;
    const pos = projectedPositions(game);
    if (!pos || !pos.utg || pos.ordered.length < 3) return;
    const amount = gameBB(game) * 2;
    const projectedStack = pos.utg.chips + (pos.utg.currentBet || 0) + (pos.utg.committed || 0);
    if (projectedStack < gameAnte(game) + amount) return;
    const d = game.straddleDecision = {
        sourceHandSeq: game.handSeq,
        targetHandSeq: game.handSeq + 1,
        candidateUserId: pos.utg.userId,
        candidateSeat: pos.utg.seat,
        amount,
        status: 'pending',
        offeredAt: null,
        deadlineAt: null,
        timer: null
    };
}

function cancelVisibleStraddleForTurn(roomId) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || !d.offeredAt) return;
    clearStraddleDecision(game, 'expired');
    const p = game.players.find(x => x.userId === d.candidateUserId);
    const s = p && io.sockets.sockets.get(p.socketId);
    if (s) s.emit('straddle_decision_result', { targetHandSeq: d.targetHandSeq, status: 'expired' });
}

function maybeShowStraddleAfterAction(roomId, actedUserId) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || d.offeredAt || d.candidateUserId !== actedUserId) return;
    if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) return;
    showStraddleDecision(roomId);
}

function activePlayers(game) {
    return game.players.filter(p => !p.folded);
}

function canAct(p) {
    return !p.folded && !p.allIn;
}

// 某玩家本街是否还需要行动：能行动(未弃牌未全押) 且 (还没行动过 或 面对更高的注还没跟平)
function needsToAct(p, game) {
    return canAct(p) && !(p.hasActed && p.currentBet === game.currentBet);
}
function findNextActionIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (needsToAct(game.players[idx], game)) return idx;   // 跳过已行动且已跟平者，避免又轮到他
    }
    return -1;
}

function isBettingRoundComplete(game) {
    const active = activePlayers(game);
    if (active.length <= 1) return true;
    const canStill = active.filter(canAct);
    if (canStill.length === 0) return true;
    return canStill.every(p => p.hasActed && p.currentBet === game.currentBet);
}

// 收注：把本街各家下注累加到本手累计投入 committed（真边池在摊牌时按 committed 计算）
function collectBetsToPot(game) {
    game.players.forEach(p => {
        p.committed = (p.committed || 0) + p.currentBet;
        p.currentBet = 0;
        p.hasActed = false;
    });
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    game.currentBet = 0;
    game.lastRaiseSize = gameBB(game);   // 新街最小加注增量重置为大盲
}

// 构建主池 + 边池：返回 [{ amount, eligible:[player,...] }]（按 all-in 档位分层）
function buildSidePots(game) {
    const contribs = game.players
        .filter(p => (p.committed || 0) > 0)
        .map(p => ({ p, amt: p.committed, folded: p.folded }));
    const pots = [];
    let remaining = contribs.filter(c => c.amt > 0);
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0;
        const eligible = [];
        for (const c of remaining) {
            amount += minAmt;
            c.amt -= minAmt;
            if (!c.folded) eligible.push(c.p);
        }
        pots.push({ amount, eligible });
        remaining = remaining.filter(c => c.amt > 0);
    }
    // 合并相邻「有资格赢家完全相同」的档位。弃牌者的盲注 / 半路弃牌零头会在池里切出一个
    // 额外档位边界，但它与相邻档位的赢家范围其实一样 → 应并成一个池（结算等价，
    // 只是不再显示成一长串「边池1/2/3/4/5」）。
    return mergeAdjacentPots(pots);
}

// 相邻档位若有资格玩家集合完全相同则合并（按 userId 判等）
function samePlayerSet(a, b) {
    return a.length === b.length && a.every(p => b.some(q => q.userId === p.userId));
}
function mergeAdjacentPots(pots) {
    const merged = [];
    for (const pot of pots) {
        const last = merged[merged.length - 1];
        if (last && samePlayerSet(last.eligible, pot.eligible)) last.amount += pot.amount;
        else merged.push(pot);
    }
    return merged;
}

// 退还未被跟到的下注：最高投入者超过「第二高投入」的部分无人能跟 → 退回给他。
// （否则会残留一个只有他自己有资格的「边池」——显示成多余边池；对 run-it 更是会把这笔钱错误地并进均分底池。）
// 须在 collectBetsToPot 之后调用（此时投入都在 committed、currentBet=0）。幂等：无未跟注则不动。
function returnUncalledBets(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const commits = game.players.map(p => p.committed || 0);
    const sorted = commits.slice().sort((a, b) => b - a);
    const top = sorted[0] || 0, second = sorted[1] || 0;
    if (top <= second) return;                       // 最高不唯一或无超出 → 无未跟注
    const topPlayers = game.players.filter(p => (p.committed || 0) === top);
    if (topPlayers.length !== 1) return;             // 并列最高 → 都被跟到，无退还
    const refund = top - second;
    const tp = topPlayers[0];
    tp.chips += refund;
    tp.committed -= refund;
    if (tp.allIn && tp.chips > 0) tp.allIn = false;  // 退回后不再是全押
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    io.in(roomId).emit('server_msg', `↩️ ${tp.username} 未被跟注，退还 ${refund}`);
}

// 实时分池：仅当「某未弃牌玩家 all-in 且投入 < 其他未弃牌玩家」才分主/边池；
// 否则（只是有人还没跟注/加注）视为单一底池——避免行动未完成时误显边池
function livePots(game) {
    const contribs = game.players
        .map(p => ({ userId: p.userId, amt: (p.committed || 0) + (p.currentBet || 0), folded: p.folded, allIn: !!p.allIn }))
        .filter(c => c.amt > 0);
    if (!contribs.length) return [];
    const maxLive = Math.max(0, ...contribs.filter(c => !c.folded).map(c => c.amt));
    const hasAllInSide = contribs.some(c => !c.folded && c.allIn && c.amt < maxLive);
    if (!hasAllInSide) {
        const total = contribs.reduce((s, c) => s + c.amt, 0);
        return [{ amount: total, eligibleCount: contribs.filter(c => !c.folded).length }];
    }
    // 确有 all-in 边池：按档位分层（记录每层有资格玩家）
    const layers = [];
    let remaining = contribs.slice();
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0; const elig = [];
        for (const c of remaining) { amount += minAmt; c.amt -= minAmt; if (!c.folded) elig.push(c.userId); }
        layers.push({ amount, elig });
        remaining = remaining.filter(c => c.amt > 0);
    }
    // 合并相邻「同资格集合」的层：弃牌者盲注/零头切出的多余边池会被并回，避免显示成一长串边池
    const merged = [];
    for (const L of layers) {
        const last = merged[merged.length - 1];
        if (last && last.elig.length === L.elig.length && L.elig.every(id => last.elig.includes(id))) last.amount += L.amount;
        else merged.push({ amount: L.amount, elig: L.elig.slice() });
    }
    return merged.map(m => ({ amount: m.amount, eligibleCount: m.elig.length }));
}

function broadcastState(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const state = {
        phase: game.phase,
        pot: game.pot,
        currentBet: game.currentBet,
        smallBlind: gameSB(game),
        bigBlind: gameBB(game),
        ante:       gameAnte(game),
        allowUtgStraddle: !!game.config?.allowUtgStraddle,
        straddle: game.straddle ? {
            type: 'utg', userId: game.straddle.userId, amount: game.straddle.amount
        } : null,
        minBuyIn:   game.config?.minBuyIn || 0,
        maxBuyIn:   game.config?.maxBuyIn || 0,
        minBet:     gameBB(game),                                       // 本街首注最小额
        minRaiseTo: game.currentBet + (game.lastRaiseSize || gameBB(game)), // 最小加注目标额
        roomType:   game.roomType || 'cash',
        roomName:   game.config?.name || roomId,
        maxPlayers: game.config?.maxPlayers || 9,
        sidePots:   livePots(game),
        spectators: listSpectators(roomId),
        vacatedUserIds: (game.vacatedPlayers || []).map(v => v.userId),   // 站起围观者（可带原筹码回座）
        // 站起围观者的战绩（战绩面板灰显保留，别让带入过又离座的人从战绩里消失）
        vacated: (game.vacatedPlayers || []).map(v => ({ userId: v.userId, username: v.username, buyIn: v.buyIn || 0, handsPlayed: v.handsPlayed || 0, net: (v.chips || 0) - (v.buyIn || 0) })),
        statsHistory: game.statsHistory || [],       // 已离开/淘汰玩家（战绩面板灰显）
        tableEndAt: game.tableEndAt || null,         // 现金桌训练结束时间戳
        pendingEnd: !!game.pendingEnd,               // 训练时长已到、本手结束后结算（房主可加时）
        paused:      !!game.paused,                  // 房主暂停发牌（本手结束后不开新局，等继续）
        runIt:       game.runItPending && game.runIt   // 多次发牌协商中（落后方选/领先方同意）
                     ? { deciderId: game.runIt.deciderId, leaderId: game.runIt.leaderId, n: game.runIt.n, equities: game.runIt.equities }
                     : null,
        ownerUserId:    game.ownerUserId || null,
        status:         game.status || 'waiting',
        currentLevel:   game.currentLevel || 0,
        nextLevelAt:    game.roomType === 'sng' && game.status === 'running' && game.levelStartTime
                        ? game.levelStartTime + game.config.levelMinutes * 60000 : null,
        pendingLevelUp: !!game.pendingLevelUp,
        tournamentOver: game.tournamentOver || false,
        actionDeadline: game.actionOnIdx >= 0 ? (game.actionDeadline || null) : null, // 行动截止时间戳(ms)
        actionTotalMs:  game.actionOnIdx >= 0 ? (game.actionTotalMs || ACTION_TIME) : null, // 本次行动总时长(环形进度)
        canAddTime:     game.actionOnIdx >= 0 && (game.extraAddedThisTurn || 0) < EXTRA_MAX
                        && (game.players[game.actionOnIdx]?.timeCards || 0) > 0, // 还能加时(未达2min上限且有时间卡)
        buttonUserId:   game.players[game.buttonIdx]?.userId || null,
        actionOnUserId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.userId || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            userId:     p.userId,
            username:   p.username,
            seat:       p.seat ?? 0,
            avatar:     p.avatar || null,
            chips:      p.chips,
            currentBet: p.currentBet,
            folded:     p.folded,
            allIn:      p.allIn,
            ready:      p.ready,
            away:       !!p.away,
            sittingOut: !!p.sittingOut,            // 现金桌坐出（等补码）
            reserved:   !!p.reserved,              // 留座离座中
            standing:   !!p.standing,              // 站起围观中（筹码保留，结束时结算）
            reserveLeaveAt: p.reserveLeaveAt || null,
            pendingRebuy: p.pendingRebuy || 0,     // 下一手生效的补码
            autoRebuy:  !!p.autoRebuy,             // 现金桌自动补码
            buyIn:      p.buyIn || 0,              // 累计带入（战绩面板）
            handsPlayed: p.handsPlayed || 0,       // 已玩手数（战绩面板）
            timeCards:  p.timeCards || 0           // 剩余时间卡（加时消耗）
        }))
    };
    io.in(roomId).emit('game_state', state);
    emitHandHints(roomId);
}

// 房间内未入座的观众（在 room 但不在 players）
function listSpectators(roomId) {
    const game = roomGames[roomId];
    if (!game) return [];
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    const seated = new Set(game.players.map(p => p.socketId));
    const specs = [];
    for (const sid of room) {
        if (seated.has(sid)) continue;
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) specs.push({ userId: s.user.id, username: s.user.username, avatar: db.getUserById(s.user.id)?.avatar || null });
    }
    return specs;
}

// 向每位在局玩家私发其「当前最强 5 张牌」+ 牌型名（仅 flop 起，showdown 由 reveal 接管）
function emitHandHints(roomId) {
    const game = roomGames[roomId];
    if (!game || game.phase === PHASES.SHOWDOWN) return;
    const comLen = game.communityCards.length;
    if (comLen < 3) return;
    game.players.forEach(p => {
        if (p.folded || !p.socketId || !game.holeCards[p.userId]) return;
        const cards = game.communityCards.concat(game.holeCards[p.userId]);
        const bh = HandEvaluator.bestHandFrom(cards);
        if (!bh) return;
        const community = bh.indices.filter(i => i < comLen);
        const hole = bh.indices.filter(i => i >= comLen).map(i => i - comLen);
        io.to(p.socketId).emit('my_hand', { community, hole, category: bh.category });
    });
}

// ===== 行动计时器（服务器权威）=====

function clearActionTimer(game) {
    if (game.actionTimer) { clearTimeout(game.actionTimer); game.actionTimer = null; }
}

// 给当前行动玩家开始计时；超时自动 check / fold
function startActionTimer(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearActionTimer(game);
    if (game.actionOnIdx < 0) { game.actionDeadline = null; return; }
    game.extraAddedThisTurn = 0;
    game.actionStartedAt = Date.now();   // 用于记录思考时间（牌谱）
    // 离桌挂机的玩家：快速自动行动，避免每步等满 15s
    const actor = game.players[game.actionOnIdx];
    if (actor && game.straddleDecision?.status === 'pending'
        && game.straddleDecision.offeredAt
        && actor.userId === game.straddleDecision.candidateUserId) {
        cancelVisibleStraddleForTurn(roomId); // 当前手再次轮到他：当前决策优先，Straddle 默认取消
    }
    const ms = (actor && actor.away) ? 800 : ACTION_TIME;
    game.actionDeadline = Date.now() + ms;
    game.actionTotalMs = ms;
    game.actionTimer = setTimeout(() => onActionTimeout(roomId), ms);
}

function onActionTimeout(roomId) {
    const game = roomGames[roomId];
    if (!game || game.actionOnIdx < 0) return;
    const player = game.players[game.actionOnIdx];
    if (!player) return;
    // 兜底：全押/已弃牌者不应被超时处理（否则会把已全押玩家误判为弃牌，剥夺其应得的池权）→ 直接推进
    if (!canAct(player)) { afterAction(roomId); return; }
    const toCall = game.currentBet - player.currentBet;
    if (toCall <= 0) {
        player.hasActed = true;
        recordAction(game, player, 'check', player.currentBet);
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动过牌`);
    } else {
        player.folded = true; player.hasActed = true;
        recordAction(game, player, 'fold', 0);
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动弃牌`);
    }
    afterAction(roomId);
    maybeShowStraddleAfterAction(roomId, player.userId);
}

// 一次行动后推进：本街结束则进下一阶段，否则轮到下一位并重启计时
function afterAction(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (isBettingRoundComplete(game)) {
        advanceStage(roomId);
    } else {
        game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
        startActionTimer(roomId);
        broadcastState(roomId);
    }
}

function dealCommunity(game, count) {
    game.deck.drawCard(); // burn
    const dealt = [];
    for (let i = 0; i < count; i++) {
        const c = game.deck.drawCard();
        game.communityCards.push(c);
        dealt.push(c);
    }
    return dealt;
}

// 全押跑马实时胜率：仅在已亮牌的全押跑马中计算并广播
function emitEquity(roomId) {
    const game = roomGames[roomId];
    if (!game || !game.allinRevealed || game.phase === PHASES.SHOWDOWN) return;
    const holes = {};
    activePlayers(game).forEach(p => { if (game.holeCards[p.userId]) holes[p.userId] = game.holeCards[p.userId]; });
    if (Object.keys(holes).length < 2) return;
    try { io.in(roomId).emit('equity', equity.computeEquity(holes, game.communityCards)); } catch (e) {}
}

function advanceStage(roomId) {
    const game = roomGames[roomId];
    clearActionTimer(game);   // 进入新阶段前先停掉上一位的计时

    // all-in 跑马：当至多 1 名活跃玩家还能行动（其余已全押且已跟齐）→ 无更多下注，先亮牌再发完
    const act = activePlayers(game);
    const bettingClosed = act.length > 1 && act.filter(canAct).length <= 1;
    if (!game.allinRevealed && bettingClosed) {
        game.allinRevealed = true;
        collectBetsToPot(game);                 // 先把全押筹码收进底池
        returnUncalledBets(roomId);             // 退还未被跟到的多余下注（否则会错误并入 run-it 均分池/多显边池）
        const reveals = {};
        act.forEach(p => {
            const h = game.holeCards[p.userId];
            if (h) reveals[p.userId] = h.map(c => ({ suit: c.suit, rank: c.rank }));
        });
        io.in(roomId).emit('server_msg', `🃏 双方全押，亮牌！`);
        io.in(roomId).emit('allin_reveal', { reveals });
        broadcastState(roomId);                 // 先展示亮牌（公共牌暂不变）
        emitEquity(roomId);                     // 亮牌即算一次当前胜率
        // 恰两人 all-in 且还有公共牌未发 → 进入「发几次」协商（落后方选、领先方同意）；否则照常单次跑马
        if (offerRunIt(roomId, act)) return;
        clearTimeout(game.runoutTimer);
        game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
        return;                                 // 下一次 advanceStage 才开始发公共牌
    }

    while (true) {
        const active = activePlayers(game);
        if (active.length <= 1) {
            collectBetsToPot(game);
            if (active.length === 1) {
                const winner = active[0];
                winner.chips += game.pot;   // 其余全弃，独得全部投入
                io.in(roomId).emit('server_msg', `🏆 ${winner.username} 赢得底池 ${game.pot}（其余弃牌）`);
                io.in(roomId).emit('sfx', 'win');
                saveHandHistory(game, { [winner.userId]: game.pot });
            } else {
                saveHandHistory(game, {});
            }
            game.pot = 0;
            game.players.forEach(p => p.committed = 0);
            game.phase = PHASES.SHOWDOWN;
            game.actionOnIdx = -1;
            applyPendingLevelUp(roomId);
            broadcastState(roomId);
            maybeEndSNG(roomId);
            if (!game.tournamentOver) scheduleNextHand(roomId);
            return;
        }
        collectBetsToPot(game);
        if (game.phase === PHASES.PREFLOP) {
            game.phase = PHASES.FLOP;
            const flop = dealCommunity(game, 3);
            io.in(roomId).emit('server_msg', `🌅 Flop: ${flop.map(c => c.toString()).join(' | ')}`);
        } else if (game.phase === PHASES.FLOP) {
            game.phase = PHASES.TURN;
            const [turn] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌇 Turn: ${turn.toString()}`);
        } else if (game.phase === PHASES.TURN) {
            game.phase = PHASES.RIVER;
            const [river] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌃 River: ${river.toString()}`);
        } else if (game.phase === PHASES.RIVER) {
            game.phase = PHASES.SHOWDOWN;
            doShowdown(roomId);
            return;
        }
        // 至多 1 人能行动（其余全押）→ 不再要任何人行动，直接跑马
        const act2 = activePlayers(game);
        if (act2.length > 1 && act2.filter(canAct).length <= 1) {
            game.actionOnIdx = -1;
        } else {
            game.actionOnIdx = findNextActionIdx(game, game.buttonIdx);
        }
        if (game.actionOnIdx < 0) {
            // 无人可行动（全押 all-in 跑马）：发完这条街先展示，间隔一段时间再发下一张
            broadcastState(roomId);
            emitEquity(roomId);                 // 每发一条街重算胜率（跳动）
            clearTimeout(game.runoutTimer);
            game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
            return;
        }
        startActionTimer(roomId);
        broadcastState(roomId);
        return;
    }
}

// ===== 多次发牌（run it N times）：恰两人 all-in，落后方选发几次(1~5)，领先方同意 =====

// 亮牌后判断是否发起协商。返回 true 表示已进入协商（暂不跑马），false 表示照常单次跑马。
function offerRunIt(roomId, act) {
    const game = roomGames[roomId];
    if (!game) return false;
    if (!act || act.length !== 2) return false;              // 只有恰两人对局才协商；多人固定发 1 次
    if (game.communityCards.length >= 5) return false;       // 已到河牌，无牌可发
    // 计算双方胜率，定「落后方=选次数」「领先方=同意」
    const holes = {};
    act.forEach(p => { if (game.holeCards[p.userId]) holes[p.userId] = game.holeCards[p.userId]; });
    if (Object.keys(holes).length !== 2) return false;
    let eq = {};
    try { eq = equity.computeEquity(holes, game.communityCards); } catch (e) { return false; }
    const [a, b] = act;
    const ea = eq[a.userId] ?? 50, eb = eq[b.userId] ?? 50;
    const deciderId = ea <= eb ? a.userId : b.userId;        // 落后方（胜率低）选发几次
    const leaderId  = deciderId === a.userId ? b.userId : a.userId;
    const maxRuns = Math.min(RUNIT_MAX, maxRunsByDeck(game));  // 牌堆不足则少给几次，防崩/卡
    if (maxRuns < 2) return false;                             // 只够发 1 次 → 无需协商，照常单次跑马
    game.runIt = { activeIds: act.map(p => p.userId), deciderId, leaderId, n: 1, equities: eq, maxRuns };
    game.runItPending = true;
    clearTimeout(game.runItTimer);
    io.in(roomId).emit('runit_offer', { deciderId, leaderId, max: maxRuns, equities: eq });
    io.in(roomId).emit('server_msg', `🎲 可协商「发几次牌」：由落后方选择次数，领先方同意`);
    // 协商超时兜底：默认发 1 次，绝不卡住牌局
    game.runItTimer = setTimeout(() => resolveRunIt(roomId, 1, 'timeout'), RUNIT_DECIDE_MS);
    return true;
}

// 结束协商并执行：n<=1 走原单次跑马；n>1 执行多次发牌
function resolveRunIt(roomId, n, reason) {
    const game = roomGames[roomId];
    if (!game || !game.runItPending) return;                 // 防重复结算
    game.runItPending = false;
    clearTimeout(game.runItTimer); game.runItTimer = null;
    n = Math.max(1, Math.min(RUNIT_MAX, maxRunsByDeck(game), parseInt(n) || 1));   // 再按牌堆兜底夹一次
    io.in(roomId).emit('runit_decided', { n, reason });
    if (n <= 1) {
        io.in(roomId).emit('server_msg', `🎲 本手发 1 次`);
        clearTimeout(game.runoutTimer);
        game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
        return;
    }
    io.in(roomId).emit('server_msg', `🎲 双方同意发 ${n} 次！底池均分为 ${n} 份`);
    executeRunouts(roomId, n);
}

// 牌堆还够发几次（每次 = 剩余街的牌 + 每街 1 张烧牌）——防多人多次弃牌后牌堆不足发 N 次而崩/卡
function maxRunsByDeck(game) {
    const baseLen = game.communityCards.length;
    const streets = baseLen <= 0 ? 3 : (baseLen <= 3 ? 2 : 1);
    const perRun = (5 - baseLen) + streets;            // 需发的公共牌 + 每街 1 张烧牌
    const avail = (game.deck && game.deck.cards) ? game.deck.cards.length : 0;
    return Math.max(1, Math.floor(avail / Math.max(1, perRun)));
}

// 发 baseLen 之后剩余的公共牌（含烧牌），返回新发出的牌数组
function dealRunStreets(game, baseLen) {
    const out = [];
    if (baseLen <= 0) { game.deck.drawCard(); out.push(game.deck.drawCard(), game.deck.drawCard(), game.deck.drawCard()); } // flop
    if (baseLen <= 3) { game.deck.drawCard(); out.push(game.deck.drawCard()); }   // turn
    if (baseLen <= 4) { game.deck.drawCard(); out.push(game.deck.drawCard()); }   // river
    return out;
}

// 执行多次发牌：共享已发公共牌为底，剩余街发 n 组不同 runout。桌面呈现方式：
// N 组公共牌各占一行「都显示出来」（不覆盖），逐组逐街发牌（flop 停顿→turn 停顿→river 停顿），
// 该组 river 发完后比牌→该份底池飞向本组赢家，再进入下一组。
const RUNIT_STREET_MS = 1300;   // 每街发牌后停顿（保持和真实跑马节奏一致）
const RUNIT_AWARD_MS  = 1600;   // 该份底池飞向赢家后、进入下一组前的停顿
// 把某组剩余公共牌按街分块（flop 3 / turn 1 / river 1），随 baseLen 决定发哪些街
function chunkRun(newCards, baseLen) {
    const chunks = []; let k = 0;
    if (baseLen <= 0) { chunks.push({ street: 'flop', cards: newCards.slice(0, 3) }); k = 3; }
    if (baseLen <= 3) { chunks.push({ street: 'turn', cards: newCards.slice(k, k + 1) }); k += 1; }
    if (baseLen <= 4) { chunks.push({ street: 'river', cards: newCards.slice(k, k + 1) }); k += 1; }
    return chunks;
}
function executeRunouts(roomId, n) {
    const game = roomGames[roomId];
    if (!game) return;
    clearTimeout(game.runoutTimer);
    const ids = game.runIt ? game.runIt.activeIds : activePlayers(game).map(p => p.userId);
    const contenders = ids.filter(id => game.holeCards[id]);
    const baseLen = game.communityCards.length;
    const base = game.communityCards.slice();          // Card 对象（共享底：已发的公共牌）
    const pot = game.pot;
    const share = Math.floor(pot / n);
    const remainder = pot - share * n;

    // 预先从牌堆连续发好 N 组不同 runout，算好各自赢家/该份金额（发放推迟到动画到该组时）
    const winByUser = {};
    const runs = [];
    for (let i = 0; i < n; i++) {
        const newCards = dealRunStreets(game, baseLen);
        const board = base.concat(newCards);
        let best = Infinity, winners = [];
        for (const id of contenders) {
            const sc = HandEvaluator.evaluate7Cards(board.concat(game.holeCards[id]));
            if (sc < best) { best = sc; winners = [id]; }
            else if (sc === best) winners.push(id);
        }
        const thisPot = share + (i === 0 ? remainder : 0);
        const w = Math.floor(thisPot / winners.length), wr = thisPot - w * winners.length;
        const awards = {};
        winners.forEach((id, k) => { const amt = w + (k === 0 ? wr : 0); awards[id] = amt; winByUser[id] = (winByUser[id] || 0) + amt; });
        runs.push({ newCards, board, chunks: chunkRun(newCards, baseLen), winners, awards, thisPot,
            categories: winners.reduce((m, id) => { m[id] = HandEvaluator.handCategory(HandEvaluator.evaluate7Cards(board.concat(game.holeCards[id]))); return m; }, {}) });
    }
    const reveals = {};
    contenders.forEach(id => { reveals[id] = game.holeCards[id].map(c => ({ suit: c.suit, rank: c.rank })); });

    io.in(roomId).emit('server_msg', `🎲 开始发 ${n} 次…`);
    io.in(roomId).emit('runit_begin', { n, baseLen, base: base.map(c => ({ suit: c.suit, rank: c.rank })), reveals });

    // 时间线：逐组逐街发牌 + 每组末尾飞池，最后收尾
    const steps = [];
    runs.forEach((run, i) => {
        run.chunks.forEach(ch => steps.push({ type: 'street', run: i, street: ch.street, cards: ch.cards.map(c => ({ suit: c.suit, rank: c.rank })), delay: RUNIT_STREET_MS }));
        steps.push({ type: 'award', run: i, delay: RUNIT_AWARD_MS });
    });
    steps.push({ type: 'done' });

    let si = 0;
    const runStep = () => {
        const g = roomGames[roomId]; if (!g) return;
        if (si >= steps.length) return;
        const step = steps[si++];
        if (step.type === 'street') {
            io.in(roomId).emit('runit_street', { run: step.run, n, street: step.street, cards: step.cards });
            g.runoutTimer = setTimeout(runStep, step.delay);
        } else if (step.type === 'award') {
            const run = runs[step.run];
            run.winners.forEach(id => { const p = g.players.find(x => x.userId === id); if (p) p.chips += run.awards[id]; });
            g.pot = Math.max(0, g.pot - run.thisPot);
            io.in(roomId).emit('runit_award', { run: step.run, n, winners: run.winners.map(id => ({ userId: id, amount: run.awards[id] })), categories: run.categories });
            broadcastState(roomId);
            g.runoutTimer = setTimeout(runStep, step.delay);
        } else {
            finishRunouts(roomId, runs, base, winByUser);
        }
    };
    game.runoutTimer = setTimeout(runStep, 600);   // 先让 begin 渲染出 N 行，再开始逐街发
}

// 全部发完：落库牌谱（完整记录多次发牌）、收尾进摊牌、续局
function finishRunouts(roomId, runs, base, winByUser) {
    const game = roomGames[roomId];
    if (!game) return;
    io.in(roomId).emit('runit_done', { totalByUser: winByUser });
    io.in(roomId).emit('sfx', 'win');
    game.communityCards = base.concat(runs.length ? runs[0].newCards : []);   // 主 community = 第 1 次（stats/回放用）
    const label = Object.keys(winByUser).map(id => { const p = game.players.find(x => x.userId === id); return `${p ? p.username : id} +${winByUser[id]}`; }).join('，');
    io.in(roomId).emit('server_msg', `🏆 发 ${runs.length} 次结果：${label}`);
    // 牌谱：完整记录 N 组公共牌 + 各组赢家 + 各份金额（数据资产：run-it 需保留每次 runout）
    if (game.hand) {
        game.hand.runIt = {
            n: runs.length,
            boards: runs.map(r => r.board.map(c => `${c.rank}${c.suit[0]}`)),
            winners: runs.map(r => r.winners),
            amounts: runs.map(r => r.thisPot)
        };
    }
    saveHandHistory(game, winByUser);   // community 落为第 1 次 board（向后兼容）
    game.pot = 0;
    game.players.forEach(p => p.committed = 0);
    game.phase = PHASES.SHOWDOWN;
    game.actionOnIdx = -1;
    game.runIt = null;
    applyPendingLevelUp(roomId);
    broadcastState(roomId);
    maybeEndSNG(roomId);
    if (!game.tournamentOver) scheduleNextHand(roomId);
}

function doShowdown(roomId) {
    const game = roomGames[roomId];
    returnUncalledBets(roomId);   // 摊牌前退还未被跟到的多余下注（幂等；已在 all-in 亮牌时退过则不动）
    const active = activePlayers(game);
    io.in(roomId).emit('server_msg', `\n--- 🃏 Showdown ---`);

    // 每位仍在局玩家的 7 张牌得分
    const scoreOf = {};
    active.forEach(p => {
        scoreOf[p.userId] = HandEvaluator.evaluate7Cards(game.communityCards.concat(game.holeCards[p.userId]));
    });

    // 广播所有手牌
    const reveals = {};
    active.forEach(p => {
        reveals[p.userId] = game.holeCards[p.userId].map(c => ({ suit: c.suit, rank: c.rank }));
    });

    // 真边池：逐池在「有资格的玩家」中取最强手分配；平局均分，余数给第一位
    const pots = buildSidePots(game);
    const winShare = {};   // userId -> 赢得总额
    const potResults = []; // 逐池结果（主池在前，边池在后），供客户端依次飞币动画
    pots.forEach((pot, idx) => {
        if (!pot.eligible.length) return;
        const best = Math.min(...pot.eligible.map(p => scoreOf[p.userId]));
        const winners = pot.eligible.filter(p => scoreOf[p.userId] === best);
        const split = Math.floor(pot.amount / winners.length);
        const rem = pot.amount - split * winners.length;
        winners.forEach((w, i) => {
            const amt = split + (i === 0 ? rem : 0);
            w.chips += amt;
            winShare[w.userId] = (winShare[w.userId] || 0) + amt;
        });
        potResults.push({
            amount: pot.amount, main: idx === 0,
            label: idx === 0 ? '主池' : `边池${idx}`,
            winners: winners.map(w => ({ userId: w.userId, amount: split + 0 }))
        });
    });

    // 每个赢家各自的最强 5 张（分池/平分时两位赢家都要高亮各自的牌，不能只亮一个）
    const winnerIds = Object.keys(winShare);
    const overallId = winnerIds.sort((a, b) => winShare[b] - winShare[a])[0];
    const bestByWinner = {};
    winnerIds.forEach(id => {
        if (!game.holeCards[id]) return;
        const wb = HandEvaluator.bestHand(game.communityCards.concat(game.holeCards[id]));
        bestByWinner[id] = {
            community: wb.indices.filter(i => i < 5),
            hole: wb.indices.filter(i => i >= 5).map(i => i - 5),
            category: wb.category
        };
    });
    const ob = bestByWinner[overallId] || { community: [], hole: [], category: '' };
    io.in(roomId).emit('showdown_reveal', {
        reveals, winners: winnerIds, winnerId: overallId,
        bestCommunity: ob.community, bestHole: ob.hole, category: ob.category,
        bestByWinner, pots: potResults
    });
    const label = winnerIds.map(id => {
        const p = game.players.find(x => x.userId === id);
        return `${p ? p.username : id} +${winShare[id]}`;
    }).join('，');
    io.in(roomId).emit('server_msg', `🏆 ${label}（边池数 ${pots.length}）`);

    saveHandHistory(game, winShare);   // 牌谱落库
    game.pot = 0;
    game.players.forEach(p => p.committed = 0);
    game.actionOnIdx = -1;
    applyPendingLevelUp(roomId);
    broadcastState(roomId);
    io.in(roomId).emit('sfx', 'win');
    maybeEndSNG(roomId);
    if (!game.tournamentOver) scheduleNextHand(roomId);
}

// 全员准备就绪后自动开新局
function tryStartHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.tournamentOver) return;
    if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) return;
    if (game.players.length < 2) return;
    if (!game.players.every(p => p.ready)) return;
    beginPlay(roomId);
}

// 该玩家本手是否参与发牌（有筹码且未坐出）
function canPlay(p) { return p.chips > 0 && !p.sittingOut; }
function liveCount(game) { return game.players.filter(canPlay).length; }
// 从 fromIdx 起（不含）找下一个可参与的玩家索引；找不到返回 -1
function nextLiveIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (canPlay(game.players[idx])) return idx;
    }
    return -1;
}

// ===== 高牌定庄（开赛首手）=====
const BUTTON_DRAW_MS = 2800;   // 定庄动画时长
const RANK_ORDER = '23456789TJQKA';
const SUIT_RANK = { Spades: 3, Hearts: 2, Diamonds: 1, Clubs: 0 };
const cardScore = c => RANK_ORDER.indexOf(c.rank) * 4 + (SUIT_RANK[c.suit] ?? 0);
function drawForButton(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const live = game.players.filter(canPlay);
    if (live.length < 2) { startHand(roomId); return; }
    const d = new Deck(); d.reset(); d.shuffle();
    const draws = live.map(p => ({ userId: p.userId, username: p.username, seat: p.seat, card: d.drawCard() }));
    let win = draws[0];
    for (const x of draws) if (cardScore(x.card) > cardScore(win.card)) win = x;
    game.forceButtonSeat = win.seat;   // 首手强制此人为庄（startHand 不轮转）
    io.in(roomId).emit('button_draw', {
        draws: draws.map(x => ({ userId: x.userId, card: { suit: x.card.suit, rank: x.card.rank } })),
        winnerId: win.userId
    });
    io.in(roomId).emit('server_msg', `🎴 高牌定庄：${win.username} 拿到最大牌，本场首庄`);
    clearTimeout(game.nextHandTimer);
    game.nextHandTimer = setTimeout(() => startHand(roomId), BUTTON_DRAW_MS);
}
// 开赛入口：首手走高牌定庄动画，之后正常发牌
function beginPlay(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.status !== 'running' && (game.buttonSeat == null || game.buttonSeat < 0) && liveCount(game) >= 2) {
        drawForButton(roomId);
    } else startHand(roomId);
}

function startHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.paused) { broadcastState(roomId); return; }   // 房主已暂停发牌：不开新局，等「继续」

    const BB = gameBB(game), SB = gameSB(game);
    const targetHandSeq = (game.handSeq || 0) + 1;
    const acceptedStraddle = game.straddleDecision
        && game.straddleDecision.status === 'accepted'
        && game.straddleDecision.targetHandSeq === targetHandSeq
        ? game.straddleDecision : null;
    // 至少 2 名可参与玩家（有筹码、未坐出）才能开局
    if (liveCount(game) < 2) {
        io.in(roomId).emit('server_msg', `⏳ 在座可玩玩家不足 2 人，等待补码 / 入座`);
        return;
    }
    clearTimeout(game.nextHandTimer);
    clearTimeout(game.runoutTimer);
    clearTimeout(game.runItTimer);
    game.runItPending = false; game.runIt = null;   // 清多次发牌协商残留
    clearStraddleDecision(game);
    game.straddleDecision = null;
    game.rabbitStreets = 0;   // 重置「看后续牌」状态
    // 第一手开始：标记 running；SNG 启动升盲计时；现金桌启动训练时长倒计时
    if (game.status !== 'running') {
        game.status = 'running';
        if (game.roomType === 'sng') { game.levelStartTime = Date.now(); startLevelTimer(roomId); }
        if (game.roomType === 'cash') startTableTimer(roomId);
        broadcastRoomList();
    }
    // 按座位号排序数组（开局前安全：数组顺序=环桌顺序，决定行动/盲注方向）
    game.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    // 按钮位按「座位号」轮转到下一个可参与玩家（与数组插入/删除解耦）
    const liveSeats = game.players.filter(canPlay).map(p => p.seat).sort((a, b) => a - b);
    let bseat;
    if (game.forceButtonSeat != null && liveSeats.includes(game.forceButtonSeat)) {
        bseat = game.forceButtonSeat; game.forceButtonSeat = null;   // 高牌定庄：首手用抽出的庄，不轮转
    } else if (game.buttonSeat == null || game.buttonSeat < 0) bseat = liveSeats[0];
    else { bseat = liveSeats.find(s => s > game.buttonSeat); if (bseat == null) bseat = liveSeats[0]; }
    game.buttonSeat = bseat;
    game.buttonIdx = game.players.findIndex(p => p.seat === bseat);
    game.handSeq = targetHandSeq;

    game.deck.reset(); game.deck.shuffle();
    console.log(`[deal] 房间 ${roomId} 新一手已重新洗牌（crypto） shuffleId=${game.deck.lastShuffleId}`);
    game.holeCards = {}; game.communityCards = [];
    game.shownCards = {};   // 本局主动亮牌记录（userId -> Set(牌索引)）
    game.allinRevealed = false;   // 全押亮牌标志
    game.pot = 0; game.currentBet = 0; game.straddle = null;
    game.lastRaiseSize = BB;   // 本街最小加注增量（每条街在 collectBetsToPot 重置）
    game.players.forEach(p => {
        p.currentBet = 0; p.committed = 0; p.allIn = false; p.hasActed = false;
        p.ready = false;   // 开局即清空准备状态，下一局需重新准备
        // 坐出（无筹码/等补码）玩家本手不参与：标记 folded、不发牌
        p.folded = !canPlay(p);
    });
    game.phase = PHASES.PREFLOP;

    // 位置：可参与玩家中 N=2（heads-up）按钮位=SB、preflop 先动；N≥3 按钮后第一位=SB、+1=BB、BB 后(UTG)先动
    const live = liveCount(game);
    const headsUp = live === 2;
    const sbIdx = headsUp ? game.buttonIdx : nextLiveIdx(game, game.buttonIdx);
    const bbIdx = nextLiveIdx(game, sbIdx);
    const sb = game.players[sbIdx];
    const bb = game.players[bbIdx];
    const utgIdx = live >= 3 ? nextLiveIdx(game, bbIdx) : -1;
    const utg = utgIdx >= 0 ? game.players[utgIdx] : null;

    // 前注 ante（现金桌可选）：先收 Ante，再收盲注/Straddle；直接进底池，不计入当前下注。
    const ante = gameAnte(game);
    if (ante > 0) {
        game.players.forEach(p => {
            if (p.folded) return;   // 坐出玩家不交前注
            const a = Math.min(ante, p.chips);
            p.chips -= a; p.committed += a;
            if (p.chips === 0) p.allIn = true;
        });
        game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    }

    const sbAmt = Math.min(SB, sb.chips);
    const bbAmt = Math.min(BB, bb.chips);
    sb.chips -= sbAmt; sb.currentBet = sbAmt;
    bb.chips -= bbAmt; bb.currentBet = bbAmt;
    if (sb.chips === 0) sb.allIn = true;
    if (bb.chips === 0) bb.allIn = true;
    game.currentBet = bbAmt;

    // 开手时按最终阵容重新校验：必须仍是该 UTG、仍能完整支付 2BB。
    const straddleAmt = BB * 2;
    const straddleValid = game.roomType === 'cash'
        && game.config.allowUtgStraddle
        && acceptedStraddle
        && acceptedStraddle.candidateUserId === utg?.userId
        && acceptedStraddle.candidateSeat === utg?.seat
        && acceptedStraddle.amount === straddleAmt
        && utg.chips >= straddleAmt;
    if (straddleValid) {
        utg.chips -= straddleAmt;
        utg.currentBet = straddleAmt;
        if (utg.chips === 0) utg.allIn = true;
        game.currentBet = straddleAmt;
        game.lastRaiseSize = straddleAmt;
        game.straddle = { type: 'utg', userId: utg.userId, amount: straddleAmt };
    } else if (acceptedStraddle) {
        const p = game.players.find(x => x.userId === acceptedStraddle.candidateUserId);
        const s = p && io.sockets.sockets.get(p.socketId);
        if (s) s.emit('straddle_decision_result', { targetHandSeq, status: 'invalidated' });
    }

    io.in(roomId).emit('server_msg', `\n--- 🎲 新一局开始 ---`);
    io.in(roomId).emit('server_msg', `💰 SB: ${sb.username} (${sbAmt}) | BB: ${bb.username} (${bbAmt})`);
    if (game.straddle) {
        io.in(roomId).emit('server_msg', `🔥 ${utg.username} UTG Straddle ${straddleAmt}`);
        io.in(roomId).emit('straddle_posted', { userId: utg.userId, amount: straddleAmt });
    }

    game.players.forEach(p => {
        if (p.folded) return;   // 坐出玩家不发牌
        const c1 = game.deck.drawCard();
        const c2 = game.deck.drawCard();
        game.holeCards[p.userId] = [c1, c2];
        io.to(p.socketId).emit('hole_cards', [
            { suit: c1.suit, rank: c1.rank },
            { suit: c2.suit, rank: c2.rank }
        ]);
    });

    // 牌谱记录初始化（数据资产：玩家×模式×时序）——仅记录参与本手的玩家
    game.hand = {
        ts: Date.now(), roomId, mode: game.roomType, handSeq: game.handSeq,
        sb: SB, bb: BB, ante,
        straddle: game.straddle ? { ...game.straddle } : null,
        buttonUserId: game.players[game.buttonIdx]?.userId || null,
        seats: game.players.filter(p => !p.folded).map(p => ({
            userId: p.userId, username: p.username,
            seat: p.seat ?? 0, avatar: p.avatar || null,          // 座位号/头像（回放布局用）
            startChips: p.chips + p.currentBet + (p.committed || 0),   // 还原下盲前筹码
            hole: game.holeCards[p.userId].map(c => `${c.rank}${c.suit[0]}`)
        })),
        actions: game.straddle ? [{
            userId: game.straddle.userId, street: PHASES.PREFLOP,
            action: 'straddle', amount: game.straddle.amount, thinkMs: 0
        }] : []   // amount=该街行动后的 currentBet 总额
    };
    game.players.forEach(p => { if (!p.folded) p.handsPlayed = (p.handsPlayed || 0) + 1; });

    // preflop 第一个行动：heads-up = SB（按钮）；N≥3 = BB 后第一位（UTG）
    // 注意：heads-up 时若 SB 已因下盲全押，则不能让 SB 行动（否则超时会误弃全押者）→ 顺延找下一个能行动的
    let firstIdx = headsUp ? sbIdx : findNextActionIdx(game, game.straddle ? utgIdx : bbIdx);
    if (headsUp && !needsToAct(game.players[sbIdx], game)) firstIdx = findNextActionIdx(game, sbIdx);
    game.actionOnIdx = firstIdx;
    // 无人可行动（所有参与者已因盲注/前注全押）→ 没有玩家能下注，直接进入全押跑马，否则本手会永久卡住
    if (game.actionOnIdx < 0) {
        broadcastState(roomId);
        advanceStage(roomId);
        return;
    }
    startActionTimer(roomId);
    broadcastState(roomId);
    prepareNextStraddleDecision(roomId);
}

// 记录一次行动到牌谱
function recordAction(game, player, action, amount) {
    if (!game.hand) return;
    game.hand.actions.push({
        userId: player.userId, street: game.phase, action,
        amount: amount || 0,
        thinkMs: game.actionStartedAt ? Date.now() - game.actionStartedAt : 0
    });
}

// 一手结束落库牌谱（含公共牌与各家结果）
function saveHandHistory(game, winShare) {
    if (!game.hand) return;
    game.hand.community = game.communityCards.map(c => `${c.rank}${c.suit[0]}`);
    game.hand.results = game.hand.seats.map(s => ({
        userId: s.userId,
        won: (winShare && winShare[s.userId]) || 0,
        endChips: (game.players.find(p => p.userId === s.userId) || {}).chips ?? 0
    }));
    db.appendHand(game.hand);
    game.hand = null;
}

// ===== 房间 / 大厅 =====

function clampInt(v, min, max, def) {
    v = parseInt(v);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
}

function genRoomId() {
    let id;
    do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (roomGames[id]);
    return id;
}

function genJoinCode(excludeRoomId = '', disallowedCode = '') {
    // 四位码只需在活跃房间中唯一；保留前导零。
    for (let attempts = 0; attempts < 20000; attempts++) {
        const code = String(crypto.randomInt(10000)).padStart(4, '0');
        if (code === disallowedCode) continue;
        const used = Object.entries(roomGames).some(([roomId, game]) =>
            roomId !== excludeRoomId && game.invite?.joinCode === code);
        if (!used) return code;
    }
    throw new Error('无法生成唯一房间码：活跃房间过多');
}

function createRoomInvite(excludeRoomId = '', disallowedCode = '') {
    return {
        token: crypto.randomBytes(16).toString('base64url'),
        joinCode: genJoinCode(excludeRoomId, disallowedCode),
        entryLocked: false,
        version: 1,
        createdAt: Date.now()
    };
}

function findRoomByInviteToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    return Object.entries(roomGames).find(([, game]) => game.invite?.token === token) || null;
}

function findRoomByJoinCode(code) {
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return null;
    return Object.entries(roomGames).find(([, game]) => game.invite?.joinCode === code) || null;
}

function emitRoomInviteInfo(socket, game, autoOpen = false) {
    if (!game || game.ownerUserId !== socket.user?.id || !game.invite) return;
    const requestOrigin = String(socket.handshake.headers.origin || '');
    const publicOrigin = CONFIGURED_PUBLIC_ORIGIN
        || (/^https?:\/\/[^/]+$/i.test(requestOrigin) ? requestOrigin : 'https://pokerdojo.space');
    socket.emit('room_invite_info', {
        joinCode: game.invite.joinCode,
        inviteUrl: `${publicOrigin}/#/join/${game.invite.token}`,
        entryLocked: !!game.invite.entryLocked,
        version: game.invite.version,
        autoOpen
    });
}

function clientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    return String(forwarded || socket.handshake.address || '').split(',')[0].trim();
}

function recentFailures(map, key, windowMs) {
    const cutoff = Date.now() - windowMs;
    const recent = (map.get(key) || []).filter(ts => ts > cutoff);
    if (recent.length) map.set(key, recent);
    else map.delete(key);
    return recent;
}

function codeAttemptLimited(socket, userId) {
    return recentFailures(inviteCodeFailuresByUser, userId, 60_000).length >= 5
        || recentFailures(inviteCodeFailuresByIp, clientIp(socket), 600_000).length >= 20;
}

function recordCodeFailure(socket, userId) {
    const ip = clientIp(socket);
    inviteCodeFailuresByUser.set(userId, [...recentFailures(inviteCodeFailuresByUser, userId, 60_000), Date.now()]);
    inviteCodeFailuresByIp.set(ip, [...recentFailures(inviteCodeFailuresByIp, ip, 600_000), Date.now()]);
}

function clearUserCodeFailures(userId) {
    inviteCodeFailuresByUser.delete(userId);
}

function canAuthorizeNewUser(game, userId) {
    if (!game || game.status === 'finished') return false;
    if (game.authorized?.has(userId)) return true;
    if (game.invite?.entryLocked) return false;
    if (game.roomType === 'sng') {
        if (game.status === 'running' || game.players.length >= game.config.maxPlayers) return false;
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) return false;
    }
    return true;
}

// 记住"有下场资格"的用户（房主/验证过邀请/坐过）：即使退到大厅，列表仍显示「重新加入」
function authorize(roomId, userId) {
    const g = roomGames[roomId];
    if (!g) return;
    if (!g.authorized) g.authorized = new Set();
    g.authorized.add(userId);
}
function roomSummary(roomId, userId) {
    const g = roomGames[roomId];
    return {
        roomId,
        roomType:   g.roomType,
        name:       g.config?.name || roomId,
        ownerName:  g.ownerName || '',
        maxPlayers: g.config?.maxPlayers || 2,
        playerCount: g.players.length,
        status:     g.status,                    // waiting | running | finished
        levelMinutes: g.config?.levelMinutes || 0,
        startingStack: g.config?.startingStack || 0,
        buyIn:      g.config?.buyIn || 0,
        sb:         g.config?.sb || 0,
        bb:         g.config?.bb || 0,
        ante:       g.config?.ante || 0,
        allowUtgStraddle: !!g.config?.allowUtgStraddle,
        minBuyIn:   g.config?.minBuyIn || 0,
        // 我是否本房成员/有下场资格（在座 / 站起 / 输过房号授权）→ 列表显示「重新加入」而非「观战」
        isMember:   !!(userId && (g.players.some(p => p.userId === userId)
                    || (g.vacatedPlayers || []).some(v => v.userId === userId)
                    || (g.authorized && g.authorized.has(userId))))
    };
}

function listRooms(userId) {
    return Object.keys(roomGames)
        .filter(id => roomGames[id].roomType && roomGames[id].status !== 'finished')
        .map(id => roomSummary(id, userId));
}

function broadcastRoomList() {
    for (const sid of lobbySockets) {
        const s = io.sockets.sockets.get(sid);
        io.to(sid).emit('room_list', listRooms(s && s.user && s.user.id));
    }
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
        broadcastRoomList();
    }
}

// 记录离开/淘汰玩家的最终战绩（供战绩面板灰显 + 结束排名）
function recordLeft(game, p) {
    if (!game.statsHistory) game.statsHistory = [];
    const net = (p.chips || 0) - (p.buyIn || 0);
    const ex = game.statsHistory.find(h => h.userId === p.userId);
    if (ex) { ex.net = net; ex.handsPlayed = p.handsPlayed || 0; ex.buyIn = p.buyIn || 0; }
    else game.statsHistory.push({ userId: p.userId, username: p.username, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, net, left: true });
}

// 构建结束排名：现金=按盈亏(筹码)；SNG=冠军→淘汰倒序(盈亏金币)
function buildRanking(game, winnerId, prize) {
    if (game.roomType === 'cash') {
        const cur = game.players.map(p => ({ userId: p.userId, username: p.username, net: (p.chips || 0) - (p.buyIn || 0) }));
        const vac = (game.vacatedPlayers || []).map(v => ({ userId: v.userId, username: v.username, net: (v.chips || 0) - (v.buyIn || 0) }));
        const covered = new Set([...cur, ...vac].map(r => r.userId));
        const hist = (game.statsHistory || []).filter(h => !covered.has(h.userId))
            .map(h => ({ userId: h.userId, username: h.username, net: h.net }));
        return [...cur, ...vac, ...hist].sort((a, b) => b.net - a.net)
            .map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, net: r.net, unit: '筹码' }));
    }
    const fee = game.config.buyIn || 0;
    const order = [];
    const w = game.players.find(p => p.userId === winnerId);
    if (w) order.push({ userId: w.userId, username: w.username, net: (prize || 0) - fee });
    (game.statsHistory || []).slice().reverse().forEach(h => order.push({ userId: h.userId, username: h.username, net: -fee }));
    return order.map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, net: r.net, unit: '金币' }));
}

// 公布排名：在线玩家弹结算面板；所有参与者（含离线/已离开）进收件箱
function sendMatchResult(roomId, title, ranking) {
    if (!ranking || !ranking.length) return;
    io.in(roomId).emit('match_result', { title, ranking });
    ranking.forEach(r => {
        const sign = r.net >= 0 ? '+' : '';
        const line = ranking.map(x => `${x.rank}. ${x.username} ${x.net >= 0 ? '+' : ''}${x.net}`).join('\n');
        db.addMessage(r.userId, { type: 'result', text: `${title}\n你第 ${r.rank}/${ranking.length} 名，盈亏 ${sign}${r.net} ${r.unit}\n\n排名：\n${line}` });
    });
}

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

// 空房宽限清理：房间变空（无任何 socket）后保留 EMPTY_GRACE_MS，期间可凭房号回来/朋友加入；
// 到点仍空才真正关闭（有筹码则结算）。避免房主创建/退出后房间立即消失（退出≠解散）。
const EMPTY_GRACE_MS = 180000;   // 3 分钟
function scheduleEmptyCleanup(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearTimeout(game.emptyCleanupTimer);
    game.emptyCleanupTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.tournamentOver) return;
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size > 0) return;   // 有人回来了 → 不清理
        const hasChips = (g.vacatedPlayers || []).some(v => (v.chips || 0) > 0) || g.players.some(p => (p.chips || 0) > 0);
        if (hasChips) endCashTable(roomId, '房间空置已关闭');   // 有筹码：结算再关
        else {
            clearTimeout(g.levelTimer); clearTimeout(g.nextHandTimer); clearTimeout(g.runoutTimer);
            clearTimeout(g.tableTimer); clearActionTimer(g); delete roomGames[roomId]; broadcastRoomList();
        }
    }, EMPTY_GRACE_MS);
}

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

// 站起围观：把玩家移出座位（座位腾空、可被他人坐下），转为观众；筹码存入 vacatedPlayers，
// 结束/解散时统一结算（不立即兑出）。与「留座离桌」(reserved, 保留座位) 区分。
function vacateSeat(game, idx) {
    const p = game.players[idx];
    if (!p) return;
    if (!game.vacatedPlayers) game.vacatedPlayers = [];
    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
    game.vacatedPlayers.push({
        userId: p.userId, username: p.username, avatar: p.avatar || null,
        chips: p.chips, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, socketId: p.socketId,
        timeCards: p.timeCards || 0
    });
    game.players.splice(idx, 1);
    if (game.buttonIdx > idx) game.buttonIdx--;
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
    // 同步调整当前行动索引，避免 splice 后 actionOnIdx 指错人导致行动卡住/错位
    if (game.actionOnIdx > idx) game.actionOnIdx--;
    else if (game.actionOnIdx === idx) game.actionOnIdx = -1;   // 正被移除者恰是当前行动位（正常已改为 mid-hand 不 vacate，这里兜底）
}

// 让某座位玩家站起围观（自己主动 or 房主强制）。本手进行中一律延后离座(vacateAfter)，绝不 mid-hand splice。
function standUpPlayer(roomId, idx, byOwner) {
    const game = roomGames[roomId];
    if (!game) return;
    const p = game.players[idx];
    if (!p) return;
    const handInProgress = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    io.in(roomId).emit('server_msg', byOwner
        ? `🧍 房主请 ${p.username} 到观战席（座位空出，筹码保留至结束结算）`
        : `🧍 ${p.username} 站起围观（座位空出，筹码保留至结束结算）`);
    if (handInProgress) {
        // 本手进行中：延后到本手结束再真正离座（removeBustedPlayers 处理），避免 splice 打乱 actionOnIdx
        p.vacateAfter = true;
        if (!p.folded) {
            p.folded = true; p.hasActed = true;
            if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
            else if (isBettingRoundComplete(game)) advanceStage(roomId);
            else broadcastState(roomId);
        } else broadcastState(roomId);
    } else {
        vacateSeat(game, idx);   // 局间(WAITING/SHOWDOWN)：立即离座安全
        broadcastState(roomId);
    }
    broadcastRoomList();
    if (byOwner) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('server_msg', '⚠️ 房主已把你移到观战席（筹码保留，可点「回到座位」重新入座）');
    }
}

// 站起围观者回座：从 vacatedPlayers 取出、带原筹码放回一个空座（不重复扣买入），并清掉 vacated 记录。
// sit_down 和 sit_back 都走这里，避免「坐下新建 + 回座又恢复」产生两个自己。
// 返回 true 表示「本人是站起围观者、已处理（成功或明确无空座）」，调用方应就此 return，不再走普通入座。
function restoreVacatedPlayer(roomId, socket, user, preferSeat) {
    const game = roomGames[roomId];
    if (!game || !game.vacatedPlayers) return false;
    const vi = game.vacatedPlayers.findIndex(v => v.userId === user.id);
    if (vi < 0) return false;
    let seat = preferSeat;
    if (seat == null || seat < 0 || seat >= game.config.maxPlayers || occupiedSeats(game).has(seat)) seat = firstFreeSeat(game);
    if (seat < 0) { socket.emit('server_msg', '⚠️ 暂无空座，无法回座'); return true; }
    const vp = game.vacatedPlayers.splice(vi, 1)[0];
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    lobbySockets.delete(socket.id);
    socket.join(roomId); socket.currentRoom = roomId;
    game.players.push({
        userId: user.id, socketId: socket.id, username: user.username, seat,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips: vp.chips, currentBet: 0, buyIn: vp.buyIn, handsPlayed: vp.handsPlayed || 0,
        timeCards: vp.timeCards || 0,
        folded: inHand, allIn: false, hasActed: false, ready: false, sittingOut: vp.chips <= 0
    });
    io.in(roomId).emit('server_msg', `🪑 ${user.username} 回到座位（${seat + 1} 号位，带回原筹码）`);
    if (game.status === 'running' && !inHand && liveCount(game) >= 2) scheduleNextHand(roomId);
    broadcastState(roomId); broadcastRoomList();
    return true;
}

// 为某座位扣金币、登记挂起补码（下一手生效）。成功返回 true
function chargeRebuy(game, p, chips) {
    const fresh = db.getUserById(p.userId);
    if (!fresh) return false;
    const cost = Math.ceil(chips * BUYIN_RATE);
    if (fresh.gold < cost) return false;
    db.setGold(p.userId, fresh.gold - cost);
    if (p.socketId) io.to(p.socketId).emit('gold_update', { gold: fresh.gold - cost });
    p.pendingRebuy = (p.pendingRebuy || 0) + chips;
    p.buyIn = (p.buyIn || 0) + chips;
    p.timeCards = (p.timeCards || 0) + timeCardsFor(game, chips);   // 补码同步补时间卡
    return true;
}

// 下一手前的座位清理：
// - 现金桌：主动离场者兑出移除；筹码归零者「保留座位坐出」（可补码回来），不淘汰
// - SNG：筹码归零者淘汰移除
function removeBustedPlayers(game) {
    const roomId = Object.keys(roomGames).find(id => roomGames[id] === game);
    for (let i = game.players.length - 1; i >= 0; i--) {
        const p = game.players[i];
        if (game.roomType === 'cash') {
            // 站起围观待腾位（本手结束）：移出座位到 vacatedPlayers，座位空出
            if (p.vacateAfter) { vacateSeat(game, i); continue; }
            // 自动补码：耗尽且开启 autoRebuy 且无挂起 → 自动按最小带入补一手
            if (p.chips <= 0 && p.autoRebuy && !(p.pendingRebuy > 0) && !p.leaving) {
                if (chargeRebuy(game, p, game.config.minBuyIn)) io.in(roomId).emit('server_msg', `🔁 ${p.username} 自动补码 ${game.config.minBuyIn}`);
            }
            // 有挂起补码：下一手生效（加筹码，取消坐出）
            if (p.pendingRebuy > 0) { p.chips += p.pendingRebuy; p.pendingRebuy = 0; p.sittingOut = false; }
            if (p.leaving) {
                recordLeft(game, p);   // 战绩面板灰显 + 结束排名
                const payout = cashOut(p);
                io.in(roomId).emit('server_msg', `🚪 ${p.username} 离场，兑出 ${payout} 金币`);
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('busted_out'); }
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            } else if (p.chips <= 0 && !p.sittingOut) {
                p.sittingOut = true;   // 坐出（保留座位），等补码
                io.in(roomId).emit('server_msg', `💤 ${p.username} 记分牌耗尽，坐出（可补码回来）`);
            }
        } else {
            if (p.chips <= 0) {
                recordLeft(game, p);   // SNG 淘汰顺序（用于结束排名：先淘汰=末名）
                io.in(roomId).emit('server_msg', `💀 ${p.username} 出局`);
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('busted_out'); }
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            }
        }
    }
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// 以观众身份进桌（不入座、不带入）：用于现金桌「坐下式」入座
function joinAsSpectator(roomId, socket) {
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
    broadcastState(roomId);
    broadcastRoomList();
}

// 座位占用集合 / 找首个空座
function occupiedSeats(game) { return new Set(game.players.map(p => p.seat)); }
function firstFreeSeat(game) {
    const taken = occupiedSeats(game);
    for (let s = 0; s < game.config.maxPlayers; s++) if (!taken.has(s)) return s;
    return -1;
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// seat=指定座位号（现金桌坐下式由客户端点选；不传则取首个空座）
function seatPlayer(roomId, socket, user, buyInChips, seat) {
    const game = roomGames[roomId];
    const fresh = db.getUserById(user.id);
    // 座位分配（固定座位号；客户端按 seat 环形定位）
    if (seat == null || seat < 0 || seat >= game.config.maxPlayers || occupiedSeats(game).has(seat)) {
        seat = firstFreeSeat(game);
    }
    if (seat < 0) { socket.emit('server_msg', '⚠️ 没有空座位'); return false; }
    let chips;
    if (game.roomType === 'cash') {
        const maxB = game.config.maxBuyIn || 1e9;
        chips = clampInt(buyInChips, game.config.minBuyIn, maxB, game.config.minBuyIn);
        const cost = Math.ceil(chips * BUYIN_RATE);
        if (fresh.gold < cost) { socket.emit('server_msg', `⚠️ 金币不足：买入 ${chips} 筹码需 ${cost} 金币（当前 ${fresh.gold}）`); return false; }
        db.setGold(user.id, fresh.gold - cost); user.gold = fresh.gold - cost;
        socket.emit('gold_update', { gold: user.gold });
    } else {
        const fee = game.config.buyIn || 0;
        if (fresh.gold < fee) { socket.emit('server_msg', `⚠️ 金币不足报名费 ${fee}（当前 ${fresh.gold}）`); return false; }
        if (fee > 0) {
            db.setGold(user.id, fresh.gold - fee); user.gold = fresh.gold - fee;
            game.prizePool = (game.prizePool || 0) + fee;
            socket.emit('gold_update', { gold: user.gold });
        }
        chips = game.config.startingStack;
    }
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    const newP = {
        userId: user.id, socketId: socket.id, username: user.username, seat,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips, currentBet: 0, buyIn: chips,   // 入座即记录带入额（战绩 net=chips-buyIn=0，避免首次广播显示 +chips）
        timeCards: timeCardsFor(game, chips),   // 按买入BB×时长发时间卡（加时消耗）
        folded: inHand, allIn: false, hasActed: false, ready: false   // 中途加入则本局坐出（下一局开局重置）
    };
    // 牌局进行中：追加到末尾（避免打乱在用的数组索引），坐出本手；局间则按座位插入
    if (inHand) {
        game.players.push(newP);
    } else {
        let ins = game.players.findIndex(p => p.seat > seat);
        if (ins < 0) ins = game.players.length;
        game.players.splice(ins, 0, newP);
        if (ins <= game.buttonIdx) game.buttonIdx++;
    }
    socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
    socket.to(roomId).emit('server_msg', `🪑 ${user.username} 入座 ${seat + 1} 号位`);
    broadcastState(roomId);
    broadcastRoomList();
    return true;
}


    return {
        projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision,
        cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, broadcastState, listRooms, broadcastRoomList,
        genRoomId, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo,
        canAuthorizeNewUser, authorize, activePlayers, canAct, isBettingRoundComplete, clearActionTimer,
        startActionTimer, afterAction, advanceStage, resolveRunIt, startHand, beginPlay, tryStartHand,
        liveCount, scheduleNextHand, endCashTable, extendTable, chargeRebuy, removeBustedPlayers,
        joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer, standUpPlayer, restoreVacatedPlayer,
        doShowdown, dealCommunity, recordAction, gameSB, gameBB, gameAnte
    };
}

module.exports = { createTableService };
