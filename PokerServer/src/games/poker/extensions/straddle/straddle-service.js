'use strict';

function createStraddleService({ io, roomGames, PHASES, gameBB, gameAnte, STRADDLE_DECISION_MS, persistence }) {
// 小标志的存活上限：正常情况下由「下一手开始」清掉，这个只是防止某条路径漏清而永久挂着。
const STRADDLE_WINDOW_MS = 10 * 60 * 1000;
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
    // 链式 straddle 需要「BB 之后、按翻前行动顺序」的完整名单：UTG, UTG+1, …, CO, BTN。
    // 注意按钮位也在其中——翻前顺序是 UTG→…→CO→BTN→SB→BB，BTN 在盲注之前行动，同样可以 straddle。
    // 只排除 SB / BB 本身（他们已经贴了盲注），故长度 = 总人数 - 2。
    const afterBB = [];
    if (ordered.length >= 3) {
        for (let i = 1; i <= ordered.length - 2; i++) afterBB.push(ordered[(bbPos + i) % ordered.length]);
    }
    return {
        ordered, buttonSeat,
        sb: ordered[sbPos], bb: ordered[bbPos],
        utg: utgPos >= 0 ? ordered[utgPos] : null,
        afterBB
    };
}

function emitStraddleOffer(game, socket) {
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || !d.offeredAt || d.deadlineAt <= Date.now()) return;
    if (!socket || socket.user?.id !== d.candidateUserId) return;
    socket.emit('straddle_offer', {
        targetHandSeq: d.targetHandSeq,
        amount: d.amount,
        chainIndex: d.chainIndex || 0,     // 第几档：客户端小标志显示 STR ×1 / ×2 …
        deadlineAt: d.deadlineAt
    });
}

// 邀请一准备好就亮出来，不再等他「这手打完/弃牌之后」——
// 玩家反馈：只有弃牌出局的人才会被问下一手要不要 straddle，很不方便。
// 现在客户端把它做成桌边一个小标志（STR ×N），不打断行动，所以轮到他行动时也可以一直挂着。
// 有效期 = 到下一手开始为止（durationMs 只作为兜底上限，不再是 15 秒的紧窗口）。
function showStraddleDecision(roomId, durationMs = STRADDLE_WINDOW_MS) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending') return false;
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
        persistence.commit(roomId, 'straddle_expired', d.candidateUserId);
    }, durationMs);
    emitStraddleOffer(game, io.sockets.sockets.get(
        game.players.find(x => x.userId === d.candidateUserId)?.socketId
    ));
    persistence.commit(roomId, 'straddle_offered', d.candidateUserId, { targetHandSeq: d.targetHandSeq });
    return true;
}

function restoreStraddleTimer(roomId) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || !d.deadlineAt) return;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.straddleDecision !== d || d.status !== 'pending') return;
        d.status = 'expired'; d.timer = null;
        const p = g.players.find(x => x.userId === d.candidateUserId);
        const s = p && io.sockets.sockets.get(p.socketId);
        if (s) s.emit('straddle_decision_result', { targetHandSeq: d.targetHandSeq, status: 'expired' });
        persistence.commit(roomId, 'straddle_expired', d.candidateUserId);
    }, Math.max(0, d.deadlineAt - Date.now()));
}

// 链式 straddle（re-straddle）：UTG 接受 2BB 后，轮到 UTG+1 决定要不要 straddle 到 4BB，
// 再往后 8BB、16BB…… 每接受一次翻一倍，一路可以加到翻前全押。
// chainIndex = 0 表示 UTG，1 表示 UTG+1，以此类推；金额 = BB * 2^(chainIndex+1)。
function straddleAmountFor(game, chainIndex) {
    return gameBB(game) * Math.pow(2, chainIndex + 1);
}

// 给链上的第 chainIndex 位准备一个决策（不立即弹出，由 showStraddleDecision 决定时机）
function prepareChainDecision(roomId, chainIndex) {
    const game = roomGames[roomId];
    if (!game) return false;
    clearStraddleDecision(game);
    game.straddleDecision = null;
    if (game.roomType !== 'cash' || !game.config.allowUtgStraddle) return false;
    // ⚠️ 这里【不能】排除 SHOWDOWN：straddle 邀请本来就在局间(SHOWDOWN)弹出，
    // 上一版沿用了「SHOWDOWN 不准备」的判断，导致玩家在局间接受后根本轮不到下一位 —— 链永远只有 1 档。
    if (game.status !== 'running' || game.phase === PHASES.WAITING) return false;
    const pos = projectedPositions(game);
    if (!pos || pos.ordered.length < 3) return false;
    const cand = pos.afterBB[chainIndex];
    if (!cand) return false;                       // 链已经排到最后一位，没有下一个人了
    // 同一个人不能吃两档：中途有人入座/离座会让预测位置整体挪一位，
    // 上一档刚接受的人可能又被算成下一档的候选人（线上真出现过，见 hand-service 的位置校验）。
    if ((game.straddleChain || []).some(e => e.userId === cand.userId)) return false;
    const amount = straddleAmountFor(game, chainIndex);
    const projectedStack = cand.chips + (cand.currentBet || 0) + (cand.committed || 0);
    // 付不起这一档就不再往下问（他可以全押跟注，但 straddle 必须足额贴出）
    if (projectedStack < gameAnte(game) + amount) return false;
    game.straddleDecision = {
        sourceHandSeq: game.handSeq,
        targetHandSeq: game.handSeq + 1,
        chainIndex,
        candidateUserId: cand.userId,
        candidateSeat: cand.seat,
        amount,
        status: 'pending',
        offeredAt: null,
        deadlineAt: null,
        timer: null
    };
    return true;
}

function prepareNextStraddleDecision(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    game.straddleChain = [];        // 新一手的链从头开始累积
    if (prepareChainDecision(roomId, 0)) showStraddleDecision(roomId);   // 立刻亮小标志
}

// 有人接受后：把他记进链，并立刻问下一位要不要再翻一倍
function advanceStraddleChain(roomId, decision) {
    const game = roomGames[roomId];
    if (!game || !decision) return;
    if (!game.straddleChain) game.straddleChain = [];
    game.straddleChain.push({
        userId: decision.candidateUserId,
        seat: decision.candidateSeat,
        amount: decision.amount,
        chainIndex: decision.chainIndex ?? 0,
        targetHandSeq: decision.targetHandSeq
    });
    // 下一位立刻进入决策；若没有下一位/付不起，链到此为止
    if (prepareChainDecision(roomId, (decision.chainIndex ?? 0) + 1)) showStraddleDecision(roomId);
}

// 旧行为：轮到他行动时把 straddle 邀请撤掉（那时它是个抢注意力的弹条）。
// 现在是桌边小标志、不遮不挡，轮到他行动也可以继续挂着 → 不再撤销。
function cancelVisibleStraddleForTurn() { /* 保留空实现：调用点仍在，语义上已不需要撤销 */ }

function maybeShowStraddleAfterAction(roomId, actedUserId) {
    const game = roomGames[roomId];
    const d = game && game.straddleDecision;
    if (!d || d.status !== 'pending' || d.offeredAt || d.candidateUserId !== actedUserId) return;
    if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) return;
    showStraddleDecision(roomId);
}


    return { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, restoreStraddleTimer, prepareNextStraddleDecision, prepareChainDecision, advanceStraddleChain, straddleAmountFor, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction };
}

module.exports = { createStraddleService };
