// ===== 牌谱回放引擎（把一手记录还原成桌面场景，逐步/播放）=====
let rpFrames = [], rpIdx = 0, rpTimer = null, rpPlaying = false, rpSpeedIdx = 0, rpCommunity = [];
const RP_SPEEDS = [1, 1.5, 2, 0.5];
function rpParseCard(str) {
    const suit = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[str.slice(-1)] || 'Spades';
    return { suit, rank: str.slice(0, -1) };
}
function rpRingPos(i, n) {
    const cx = 50, cy = 44, rx = 40, ry = 37;
    const ang = Math.PI / 2 + (2 * Math.PI * i / n);
    return { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) };
}
function buildReplayFrames(h) {
    const players = (h.seats || []).slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)).map(s => ({
        userId: s.userId, name: s.username, avatar: s.avatar, seat: s.seat ?? 0,
        stack: s.startChips || 0, bet: 0, folded: false, showCards: false,
        hole: (s.hole || []).map(rpParseCard), isMe: s.userId === myUserId, pos: ''
    }));
    const byId = {}; players.forEach(p => byId[p.userId] = p);
    const n = players.length;
    const btnI = players.findIndex(p => p.userId === h.buttonUserId);
    if (btnI >= 0 && n >= 2) {
        const sbI = n === 2 ? btnI : (btnI + 1) % n;
        const bbI = n === 2 ? (btnI + 1) % n : (btnI + 2) % n;
        players[btnI].pos = 'BTN';
        players[sbI].pos = (players[sbI].pos ? players[sbI].pos + '/' : '') + 'SB';
        players[bbI].pos = players[bbI].pos ? players[bbI].pos + '/BB' : 'BB';
        if (n >= 3) players[(bbI + 1) % n].pos = 'UTG';
    }
    let pot = 0, community = 0, street = 'preflop';
    const frames = [];
    const snap = (caption, actingId) => frames.push({ players: players.map(p => ({ ...p })), pot, community, caption, actingId });
    if (h.ante > 0) players.forEach(p => { const a = Math.min(h.ante, p.stack); p.stack -= a; pot += a; });
    const sbP = players.find(p => (p.pos || '').includes('SB'));
    const bbP = players.find(p => (p.pos || '').includes('BB'));
    if (sbP) { const v = Math.min(h.sb, sbP.stack); sbP.stack -= v; sbP.bet = v; }
    if (bbP) { const v = Math.min(h.bb, bbP.stack); bbP.stack -= v; bbP.bet = v; }
    if (h.straddle && byId[h.straddle.userId]) {
        const sp = byId[h.straddle.userId];
        sp.stack -= h.straddle.amount; sp.bet = h.straddle.amount;
    }
    snap(`发牌 · 盲注 ${h.sb}/${h.bb}${h.ante ? ' ante ' + h.ante : ''}`
        + (h.straddle ? ` · UTG Straddle ${h.straddle.amount}` : ''), null);
    const stName = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
    for (const a of (h.actions || [])) {
        if (a.action === 'straddle') continue;
        if (a.street !== street) {
            players.forEach(p => { pot += p.bet; p.bet = 0; });
            street = a.street;
            community = street === 'flop' ? 3 : street === 'turn' ? 4 : street === 'river' ? 5 : community;
            snap(`${stName[street] || street}`, null);
        }
        const p = byId[a.userId]; if (!p) continue;
        const think = a.thinkMs ? ` · 思考 ${(a.thinkMs / 1000).toFixed(1)}s` : '';
        let cap;
        if (a.action === 'fold') { p.folded = true; cap = `${p.name} 弃牌`; }
        else if (a.action === 'check') cap = `${p.name} 过牌`;
        else if (a.action === 'call') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} 跟注 ${fmtChips(a.amount)}`; }
        else if (a.action === 'bet') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} 下注 ${fmtChips(a.amount)}`; }
        else if (a.action === 'raise') { p.stack -= (a.amount - p.bet); p.bet = a.amount; cap = `${p.name} 加注到 ${fmtChips(a.amount)}`; }
        else cap = `${p.name} ${a.action}`;
        snap(`${stName[street] || street} · ${cap}${think}`, a.userId);
    }
    players.forEach(p => { pot += p.bet; p.bet = 0; });
    community = (h.community || []).length;
    players.forEach(p => { if (!p.folded) p.showCards = true; });
    const winners = (h.results || []).filter(r => r.won > 0);
    winners.forEach(r => { const p = byId[r.userId]; if (p) p.stack += r.won; });
    const wn = winners.map(r => byId[r.userId] && byId[r.userId].name).filter(Boolean);
    snap(`摊牌 · ${wn.length ? wn.join('、') + ' 赢得 ' + fmtChips(winners.reduce((s, r) => s + r.won, 0)) : '结束'}`, null);
    return frames;
}
// ===== 牌谱详情（清爽 breakdown，参考商业软件截图3）=====
let curDetailHand = null;
const HD_ACT = { fold: { t: '弃', c: 'f' }, check: { t: '过', c: 'ck' }, call: { t: '跟', c: 'c' }, bet: { t: '下', c: 'b' }, raise: { t: '加', c: 'r' }, straddle: { t: 'STR', c: 'r' } };
const HD_STREET = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
function handPositions(seats, buttonUserId) {
    const order = seats.slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    const n = order.length, bi = order.findIndex(s => s.userId === buttonUserId), pos = {};
    if (bi < 0) return pos;
    if (n === 2) { pos[order[bi].userId] = 'D/SB'; pos[order[(bi + 1) % n].userId] = 'BB'; }
    else { pos[order[bi].userId] = 'BTN'; pos[order[(bi + 1) % n].userId] = 'SB'; pos[order[(bi + 2) % n].userId] = 'BB'; }
    return pos;
}
function openHandDetail(h) {
    curDetailHand = h;
    const seats = (h.seats || []).slice().sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    const foldedSet = new Set((h.actions || []).filter(a => a.action === 'fold').map(a => a.userId));
    const showdown = seats.filter(s => !foldedSet.has(s.userId)).length >= 2;
    const pos = handPositions(seats, h.buttonUserId);
    const resById = {}; (h.results || []).forEach(r => resById[r.userId] = r);
    const pot = (h.results || []).reduce((s, r) => s + (r.won || 0), 0);
    const community = (h.community || []).map(rpParseCard);
    const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    document.getElementById('hd-title').textContent = `牌谱详情 · ${h.mode === 'cash' ? '现金桌' : 'SNG'} ${h.sb}/${h.bb}`;
    const commHtml = [0, 1, 2, 3, 4].map(i => community[i] ? formatCard(community[i]) : emptySlot()).join('');
    // 多次发牌（run it N times）：完整展示每组公共牌 + 该组赢家 + 该份金额
    let runitHtml = '';
    if (h.runIt && h.runIt.n > 1) {
        const rr = h.runIt;
        runitHtml = `<div class="hd-runit"><div class="hd-runit-t">🎲 本手发了 ${rr.n} 次（底池均分）</div>`
            + (rr.boards || []).map((bd, i) => {
                const cards = (bd || []).map(cs => formatCard(rpParseCard(cs))).join('');
                const wn = ((rr.winners || [])[i] || []).map(id => { const s = seats.find(x => x.userId === id); return s ? s.username : id; }).join(' / ');
                return `<div class="hd-runit-row"><span class="hd-runit-no">第${i + 1}次</span><div class="hd-runit-bd">${cards}</div>`
                    + `<span class="hd-runit-w">🏆 ${escapeHtml(wn)} +${fmtChips((rr.amounts || [])[i] || 0)}</span></div>`;
            }).join('') + `</div>`;
    }
    document.getElementById('hd-board').innerHTML =
        `<div class="hd-pot">${time} · 底池 <b>${fmtChips(pot)}</b></div>`
        + (runitHtml ? runitHtml : `<div class="hd-comm">${commHtml}</div>`);
    document.getElementById('hd-rows').innerHTML = seats.map(s => {
        const isMe = s.userId === myUserId;
        const folded = foldedSet.has(s.userId);
        const showFace = isMe || (!folded && showdown);
        const holeHtml = (s.hole || []).map(cs => showFace ? formatCard(rpParseCard(cs)) : cardBack()).join('');
        const acts = (h.actions || []).filter(a => a.userId === s.userId);
        let actHtml = '', lastStreet = null;
        acts.forEach(a => {
            if (a.street !== lastStreet) { actHtml += `<span class="hd-st">${HD_STREET[a.street] || a.street}</span>`; lastStreet = a.street; }
            const m = HD_ACT[a.action] || { t: a.action, c: '' };
            const amt = (a.action === 'call' || a.action === 'bet' || a.action === 'raise') && a.amount ? ' ' + fmtChips(a.amount) : '';
            actHtml += `<span class="hd-act ${m.c}">${m.t}${amt}</span>`;
        });
        if (!actHtml) actHtml = '<span class="hd-act">—</span>';
        const res = resById[s.userId] || {};
        const net = (res.endChips ?? s.startChips ?? 0) - (s.startChips || 0);
        const netCls = net > 0 ? 'win' : (net < 0 ? 'lose' : '');
        const av = s.avatar ? `<img src="${s.avatar}" onerror="this.style.display='none'">` : escapeHtml((s.username || '?')[0].toUpperCase());
        return `<div class="hd-row${folded ? ' folded' : ''}">
            <div class="hd-who"><div class="hd-av" style="background:hsl(${hashHue(s.username)},45%,42%)">${av}</div>
              <div class="hd-nm">${escapeHtml(s.username)}${isMe ? '<span class="hd-me">你</span>' : ''}${pos[s.userId] ? `<span class="hd-pos">${pos[s.userId]}</span>` : ''}${folded ? '<span class="hd-fold">弃牌</span>' : ''}</div></div>
            <div class="hd-hole">${holeHtml}</div>
            <div class="hd-acts">${actHtml}</div>
            <div class="hd-net ${netCls}">${net > 0 ? '+' : ''}${fmtChips(net)}</div>
        </div>`;
    }).join('');
    document.getElementById('hand-detail').style.display = 'flex';
}
function closeHandDetail() { document.getElementById('hand-detail').style.display = 'none'; }
function replayCurrentDetail() { closeHandDetail(); if (curDetailHand) openReplay(curDetailHand); }

function openReplay(h) {
    rpFrames = buildReplayFrames(h);
    rpCommunity = (h.community || []).map(rpParseCard);
    rpIdx = 0; rpPlaying = false;
    const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const me = (h.seats || []).find(s => s.userId === myUserId);
    document.getElementById('rp-info').textContent =
        `${time} · ${h.mode === 'cash' ? '现金桌' : 'SNG'} · 盲注 ${h.sb}/${h.bb}${h.ante ? ' ante ' + h.ante : ''} · ${(h.seats || []).length} 人`
        + (me ? ` · 你的后手 ${Math.round((me.startChips || 0) / h.bb)}BB` : '');
    document.getElementById('replay-overlay').style.display = 'flex';
    renderReplayFrame();
    rpToggle();   // 自动播放
}
function closeReplay() {
    if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
    rpPlaying = false;
    document.getElementById('replay-overlay').style.display = 'none';
}
function renderReplayFrame() {
    const f = rpFrames[rpIdx]; if (!f) return;
    const n = f.players.length;
    const meIdx = f.players.findIndex(p => p.isMe);
    const base = meIdx >= 0 ? meIdx : 0;
    document.getElementById('rp-ring').innerHTML = f.players.map((p, i) => {
        const ri = ((i - base) % n + n) % n;
        const pos = rpRingPos(ri, n);
        const showFace = p.isMe || p.showCards;
        const cards = p.hole.map(c => showFace ? formatCard(c) : cardBack()).join('');
        const cls = 'rp-seat' + (p.folded ? ' folded' : '') + (p.userId === f.actingId ? ' acting' : '');
        const initial = (p.name || '?').charAt(0).toUpperCase();
        const av = p.avatar ? `<img src="${p.avatar}" onerror="this.style.display='none'">` : escapeHtml(initial);
        return `<div class="${cls}" style="left:${pos.x}%;top:${pos.y}%">
            <div class="rp-cards">${cards}</div>
            <div class="rp-avatar" style="background:hsl(${hashHue(p.name)},45%,42%)">${av}</div>
            <div class="rp-name">${escapeHtml(p.name)}${p.pos ? `<span class="pos">${p.pos}</span>` : ''}</div>
            <div class="rp-stack">${fmtChips(p.stack)}</div>
            ${p.bet > 0 ? `<div class="rp-bet">${fmtChips(p.bet)}</div>` : ''}
        </div>`;
    }).join('');
    let cc = '';
    for (let i = 0; i < 5; i++) cc += (i < f.community && rpCommunity[i]) ? formatCard(rpCommunity[i]) : emptySlot();
    document.getElementById('rp-community').innerHTML = cc;
    document.getElementById('rp-pot').textContent = '💰 底池 ' + fmtChips(f.pot);
    document.getElementById('rp-caption').textContent = f.caption || '';
    document.getElementById('rp-progress').textContent = `${rpIdx + 1}/${rpFrames.length}`;
}
function rpToggle() {
    rpPlaying = !rpPlaying;
    document.getElementById('rp-play').textContent = rpPlaying ? '⏸' : '▶';
    if (rpPlaying) rpAdvanceLoop(); else if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
}
function rpAdvanceLoop() {
    if (!rpPlaying) return;
    if (rpIdx >= rpFrames.length - 1) { rpPlaying = false; document.getElementById('rp-play').textContent = '▶'; return; }
    rpTimer = setTimeout(() => { rpIdx++; renderReplayFrame(); rpAdvanceLoop(); }, 1300 / RP_SPEEDS[rpSpeedIdx]);
}
function rpStep(dir) {
    rpPlaying = false; document.getElementById('rp-play').textContent = '▶';
    if (rpTimer) { clearTimeout(rpTimer); rpTimer = null; }
    rpIdx = Math.max(0, Math.min(rpFrames.length - 1, rpIdx + dir));
    renderReplayFrame();
}
function rpSpeed() {
    rpSpeedIdx = (rpSpeedIdx + 1) % RP_SPEEDS.length;
    document.getElementById('rp-speed').textContent = RP_SPEEDS[rpSpeedIdx] + '×';
}
function renderHistActions(h) {
    const nameOf = {}; (h.seats || []).forEach(s => nameOf[s.userId] = s.username);
    const streetName = { preflop: '翻前', flop: '翻牌', turn: '转牌', river: '河牌' };
    const A = { fold: '弃', check: '过', call: '跟', bet: '下注', raise: '加注', allin: '全下', straddle: 'Straddle' };
    return (h.actions || []).map(a =>
        `<span class="ha">${streetName[a.street] || a.street}·${escapeHtml(nameOf[a.userId] || '?')} ${A[a.action] || a.action}${a.amount ? ' ' + a.amount : ''}</span>`
    ).join('') || '<span style="opacity:.5">无动作</span>';
}

