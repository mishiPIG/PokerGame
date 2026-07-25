'use strict';

function createMatchResultService({ io, db, roomGames }) {
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


    return { recordLeft, buildRanking, sendMatchResult };
}

module.exports = { createMatchResultService };
