'use strict';

function createMatchResultService({ io, db, roomGames }) {
// 记录离开/淘汰玩家的最终战绩（供战绩面板灰显 + 结束排名）
function recordLeft(game, p) {
    if (!game.statsHistory) game.statsHistory = [];
    const net = (p.chips || 0) - (p.buyIn || 0);
    const ex = game.statsHistory.find(h => h.userId === p.userId);
    if (ex) { ex.net = net; ex.handsPlayed = p.handsPlayed || 0; ex.buyIn = p.buyIn || 0; }
    else game.statsHistory.push({ userId: p.userId, username: p.username, displayName: p.displayName || p.username, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, net, left: true });
}

// 构建结束排名：现金=按盈亏(筹码)；SNG=冠军→淘汰倒序(盈亏金币)
// 附带 handsPlayed / avatar —— 颁奖台（老板/MVP/力工）与结算面板要用
function buildRanking(game, winnerId, prize) {
    const avatarOf = userId => {
        const p = game.players.find(x => x.userId === userId) || (game.vacatedPlayers || []).find(x => x.userId === userId);
        return p?.avatar || db.getUserById(userId)?.avatar || null;
    };
    if (game.roomType === 'cash') {
        const cur = game.players.map(p => ({ userId: p.userId, username: p.username, displayName: p.displayName || p.username, net: (p.chips || 0) - (p.buyIn || 0), handsPlayed: p.handsPlayed || 0 }));
        const vac = (game.vacatedPlayers || []).map(v => ({ userId: v.userId, username: v.username, displayName: v.displayName || v.username, net: (v.chips || 0) - (v.buyIn || 0), handsPlayed: v.handsPlayed || 0 }));
        const covered = new Set([...cur, ...vac].map(r => r.userId));
        const hist = (game.statsHistory || []).filter(h => !covered.has(h.userId))
            .map(h => ({ userId: h.userId, username: h.username, displayName: h.displayName || h.username, net: h.net, handsPlayed: h.handsPlayed || 0 }));
        return [...cur, ...vac, ...hist].sort((a, b) => b.net - a.net)
            .map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, displayName: r.displayName, net: r.net, handsPlayed: r.handsPlayed, avatar: avatarOf(r.userId), unit: '筹码' }));
    }
    const fee = game.config.buyIn || 0;
    const order = [];
    const w = game.players.find(p => p.userId === winnerId);
    if (w) order.push({ userId: w.userId, username: w.username, displayName: w.displayName || w.username, net: (prize || 0) - fee, handsPlayed: w.handsPlayed || 0 });
    (game.statsHistory || []).slice().reverse().forEach(h => order.push({ userId: h.userId, username: h.username, displayName: h.displayName || h.username, net: -fee, handsPlayed: h.handsPlayed || 0 }));
    return order.map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, displayName: r.displayName, net: r.net, handsPlayed: r.handsPlayed, avatar: avatarOf(r.userId), unit: '金币' }));
}

// 颁奖台（纯娱乐/调侃）：🥇老板=亏最多（玩梗"输最多的请客"）、🥈MVP=赢最多、🥉力工=手数最多。
// 少于 2 人不评（自娱自乐没意思）；同一个人可以同时拿多个称号。
function buildAwards(ranking) {
    if (!ranking || ranking.length < 2) return null;
    const pick = (cmp, guard) => {
        const cand = ranking.filter(guard);
        if (!cand.length) return null;
        const best = cand.reduce((a, b) => (cmp(b, a) ? b : a));
        return { userId: best.userId, username: best.username, displayName: best.displayName, avatar: best.avatar || null, net: best.net, handsPlayed: best.handsPlayed || 0, unit: best.unit };
    };
    return {
        boss: pick((b, a) => b.net < a.net, r => r.net < 0),          // 老板：必须真亏了才评
        mvp: pick((b, a) => b.net > a.net, r => r.net > 0),           // MVP：必须真赢了才评
        worker: pick((b, a) => (b.handsPlayed || 0) > (a.handsPlayed || 0), r => (r.handsPlayed || 0) > 0)
    };
}

// 公布排名：在线玩家弹结算面板；所有参与者（含离线/已离开）进收件箱
function sendMatchResult(roomId, title, ranking) {
    if (!ranking || !ranking.length) return;
    const awards = buildAwards(ranking);
    io.in(roomId).emit('match_result', { title, ranking, awards });
    // 收件箱：之前只有一行「第几名/盈亏」太简略，补上手数、称号与完整排名（含手数）
    const label = u => {
        const tags = [];
        if (awards?.boss?.userId === u) tags.push('🥇老板');
        if (awards?.mvp?.userId === u) tags.push('🥈MVP');
        if (awards?.worker?.userId === u) tags.push('🥉力工');
        return tags.length ? ' ' + tags.join(' ') : '';
    };
    const line = ranking.map(x =>
        `${x.rank}. ${x.displayName || x.username}${label(x.userId)}  ${x.net >= 0 ? '+' : ''}${x.net} ${x.unit}  ${x.handsPlayed || 0} 手`
    ).join('\n');
    const awardText = awards ? [
        awards.boss ? `🥇 老板（亏最多，该请客了）：${awards.boss.displayName || awards.boss.username} ${awards.boss.net} ${awards.boss.unit}` : '',
        awards.mvp ? `🥈 MVP（赢最多）：${awards.mvp.displayName || awards.mvp.username} +${awards.mvp.net} ${awards.mvp.unit}` : '',
        awards.worker ? `🥉 力工（手数最多）：${awards.worker.displayName || awards.worker.username} ${awards.worker.handsPlayed} 手` : ''
    ].filter(Boolean).join('\n') : '';
    ranking.forEach(r => {
        const sign = r.net >= 0 ? '+' : '';
        db.addMessage(r.userId, {
            type: 'result',
            text: `${title}\n你第 ${r.rank}/${ranking.length} 名，盈亏 ${sign}${r.net} ${r.unit}，共打 ${r.handsPlayed || 0} 手${label(r.userId)}`
                + (awardText ? `\n\n—— 本场称号 ——\n${awardText}` : '')
                + `\n\n—— 完整排名 ——\n${line}`
        });
    });
}


    return { recordLeft, buildRanking, buildAwards, sendMatchResult };
}

module.exports = { createMatchResultService };
