// 生涯数据统计：从 hands.jsonl 聚合某玩家的扑克指标（VPIP/PFR/3bet/AF/WTSD…）
// 数据来源是已落库的牌谱，无需额外存储；量大后可换 SQLite，接口不变。
const db = require('./database');

// 曲线降采样到最多 maxPts 个点
function sampleCurve(curve, maxPts) {
    if (curve.length <= maxPts) return curve;
    const step = curve.length / maxPts;
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(curve[Math.floor(i * step)]);
    out.push(curve[curve.length - 1]);
    return out;
}

function computeUserStats(userId, mode) {
    const m = (mode === 'cash' || mode === 'sng') ? mode : null;
    const hands = db.getHandsForUser(userId, { limit: 200000, mode: m });
    const chrono = hands.slice().reverse();   // getHandsForUser 是倒序（新→旧），翻成时序

    let totalHands = 0, netTotal = 0, biggestWin = 0;
    let vpip = 0, pfr = 0;
    let threeBet = 0, threeBetOpp = 0;
    let foldTo3bet = 0, faced3betAfterOpen = 0;
    let cbet = 0, cbetOpp = 0;
    let postBets = 0, postCalls = 0;          // 激进度 AF（翻后）
    let sawFlop = 0, wentSD = 0, wonSD = 0;
    let thinkSum = 0, thinkCount = 0;
    const curve = [];

    for (const h of chrono) {
        const seat = (h.seats || []).find(s => s.userId === userId);
        if (!seat) continue;
        totalHands++;
        const res = (h.results || []).find(r => r.userId === userId);
        const won = res ? (res.won || 0) : 0;
        const net = res ? ((res.endChips ?? seat.startChips) - seat.startChips) : 0;
        netTotal += net; curve.push(netTotal);
        if (won > biggestWin) biggestWin = won;

        const acts = h.actions || [];
        const myActs = acts.filter(a => a.userId === userId);
        const myPre = myActs.filter(a => a.street === 'preflop');
        const myPost = myActs.filter(a => a.street !== 'preflop');
        const isAgg = a => a.action === 'bet' || a.action === 'raise';

        // VPIP / PFR（翻前自愿入池 / 翻前加注）
        if (myPre.some(a => a.action === 'call' || isAgg(a))) vpip++;
        if (myPre.some(isAgg)) pfr++;

        // 翻前序列解析：3bet、弃3bet、翻前最后加注者（aggressor）
        const preSeq = acts.filter(a => a.street === 'preflop');
        let raisesBefore = 0, iOpened = false, faced3 = false, foldedTo3 = false, aggressor = null;
        for (const a of preSeq) {
            if (a.userId === userId) {
                if (raisesBefore >= 1) { threeBetOpp++; if (isAgg(a)) threeBet++; }     // 面对加注的再加注机会
                if (isAgg(a) && raisesBefore === 0) iOpened = true;                      // 我开池加注
                else if (iOpened && raisesBefore >= 2) { faced3 = true; if (a.action === 'fold') foldedTo3 = true; }
            }
            if (isAgg(a)) { raisesBefore++; aggressor = a.userId; }
        }
        if (iOpened && faced3) { faced3betAfterOpen++; if (foldedTo3) foldTo3bet++; }

        const communityLen = (h.community || []).length;
        const iFoldedPre = myPre.some(a => a.action === 'fold');
        if (communityLen >= 3 && !iFoldedPre) sawFlop++;

        // 持续下注 C-bet：我是翻前最后加注者 + 见到翻牌 + 翻牌首个动作是下注/加注
        if (aggressor === userId && communityLen >= 3) {
            cbetOpp++;
            const myFlop = myActs.filter(a => a.street === 'flop');
            if (myFlop.length && isAgg(myFlop[0])) cbet++;
        }

        // 激进度 AF（翻后下注+加注 / 跟注）
        for (const a of myPost) { if (isAgg(a)) postBets++; else if (a.action === 'call') postCalls++; }

        // 摊牌率 / 摊牌胜率：全程未弃牌 + 发到河牌（community=5）视为到摊牌
        const iFoldedAny = myActs.some(a => a.action === 'fold');
        if (communityLen === 5 && !iFoldedAny) { wentSD++; if (won > 0) wonSD++; }

        for (const a of myActs) if (a.thinkMs) { thinkSum += a.thinkMs; thinkCount++; }
    }

    const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
    return {
        mode: m || 'all',
        totalHands,
        net: netTotal,
        biggestWin,
        winRateBB: 0,   // 预留（需稳定 BB 基准，暂不计）
        vpip: pct(vpip, totalHands),
        pfr: pct(pfr, totalHands),
        threeBet: pct(threeBet, threeBetOpp),
        foldTo3bet: pct(foldTo3bet, faced3betAfterOpen),
        cbet: pct(cbet, cbetOpp),
        af: postCalls > 0 ? Math.round((postBets / postCalls) * 10) / 10 : (postBets > 0 ? 99 : 0),
        wtsd: pct(wentSD, sawFlop),
        wsd: pct(wonSD, wentSD),
        avgThinkMs: thinkCount > 0 ? Math.round(thinkSum / thinkCount) : 0,
        curve: sampleCurve(curve, 120)
    };
}

module.exports = { computeUserStats };
