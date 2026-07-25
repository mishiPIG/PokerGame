'use strict';

function createHandService({ io, roomGames, Deck, HandEvaluator, equity, config, rules, pots, presenter, straddle, runIt, showdown, history, hooks }) {
    const { PHASES, ACTION_TIME, EXTRA_STEP, EXTRA_MAX, RUNOUT_DELAY, STANDARD_BLIND_LEVELS, gameSB, gameBB, gameAnte, timeCardsFor } = config;
    const { activePlayers, canAct, needsToAct, findNextActionIdx, isBettingRoundComplete } = rules;
    const { collectBetsToPot, returnUncalledBets } = pots;
    const { broadcastState } = presenter;
    const { cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction, prepareNextStraddleDecision, clearStraddleDecision } = straddle;
    const { offerRunIt } = runIt;
    const { doShowdown } = showdown;
    const { recordAction, saveHandHistory } = history;
    const { applyPendingLevelUp, maybeEndSNG, scheduleNextHand, startLevelTimer, startTableTimer, broadcastRoomList } = hooks;
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
    const actor = game.players[game.actionOnIdx];
    if (actor && game.straddleDecision?.status === 'pending'
        && game.straddleDecision.offeredAt
        && actor.userId === game.straddleDecision.candidateUserId) {
        cancelVisibleStraddleForTurn(roomId); // 当前手再次轮到他：当前决策优先，Straddle 默认取消
    }
    // 掉线/离桌者也给「正常行动时间」，不再 800ms 秒判——防网络波动瞬断被直接弃牌；
    // 到点由 onActionTimeout 处理：无注则自动过牌(留在局里)、面对下注才弃牌。重连后计时重置。
    const ms = ACTION_TIME;
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

    return { clearActionTimer, startActionTimer, onActionTimeout, afterAction, dealCommunity, emitEquity, advanceStage, tryStartHand, canPlay, liveCount, nextLiveIdx, drawForButton, beginPlay, startHand };
}

module.exports = { createHandService };
