'use strict';

function createStraddleService({ io, roomGames, PHASES, gameBB, gameAnte, STRADDLE_DECISION_MS }) {
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


    return { projectedPositions, clearStraddleDecision, emitStraddleOffer, showStraddleDecision, prepareNextStraddleDecision, cancelVisibleStraddleForTurn, maybeShowStraddleAfterAction };
}

module.exports = { createStraddleService };
