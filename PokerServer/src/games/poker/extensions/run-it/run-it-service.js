'use strict';

function createRunItService({ io, roomGames, HandEvaluator, equity, config, activePlayers, hooks }) {
    const { RUNIT_MAX, RUNIT_DECIDE_MS, RUNOUT_DELAY, PHASES } = config;
    const { broadcastState, saveHandHistory, applyPendingLevelUp, maybeEndSNG, scheduleNextHand, advanceStage } = hooks;
function offerRunIt(roomId, act) {
    const game = roomGames[roomId];
    if (!game) return false;
    if (game.roomType !== 'cash') return false;              // 只有现金桌才协商多次发牌；SNG(锦标赛)固定发 1 次
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
    const deadlineAt = Date.now() + RUNIT_DECIDE_MS;
    game.runIt = { activeIds: act.map(p => p.userId), deciderId, leaderId, n: 1, equities: eq, maxRuns, deadlineAt };
    game.runItPending = true;
    clearTimeout(game.runItTimer);
    io.in(roomId).emit('runit_offer', { deciderId, leaderId, max: maxRuns, equities: eq, deadlineAt });
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


    return { offerRunIt, resolveRunIt, maxRunsByDeck, dealRunStreets, chunkRun, executeRunouts, finishRunouts };
}

module.exports = { createRunItService };
