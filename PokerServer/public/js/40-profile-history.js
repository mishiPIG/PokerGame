// ===== 牌谱回顾 (C9) =====
let histMode = '';
function openHistory() { document.getElementById('history-panel').style.display = ''; loadHistory('history-list', histMode, currentRoom); }
function closeHistory() { document.getElementById('history-panel').style.display = 'none'; }

// ===== 消息收件箱 =====
async function fetchMessages() {
    try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/my-messages', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}
async function refreshInboxBadge() {
    const msgs = await fetchMessages();
    const unread = msgs.filter(m => !m.read).length;
    const b = document.getElementById('inbox-badge');
    if (!b) return;
    if (unread > 0) { b.textContent = unread > 9 ? '9+' : unread; b.style.display = ''; }
    else b.style.display = 'none';
}
async function openInbox() {
    document.getElementById('inbox-panel').style.display = '';
    const list = document.getElementById('inbox-list');
    list.innerHTML = '<div class="hist-empty">加载中…</div>';
    const msgs = await fetchMessages();
    if (!msgs.length) { list.innerHTML = '<div class="hist-empty">暂无消息</div>'; return; }
    list.innerHTML = msgs.map(m => {
        const t = new Date(m.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `<div class="inbox-item${m.read ? '' : ' unread'}">
            <div class="ib-time">${t}</div>
            <div class="ib-text">${escapeHtml(m.text || '').replace(/\n/g, '<br>')}</div></div>`;
    }).join('');
    // 标记已读
    try {
        const token = localStorage.getItem('token');
        await fetch('/api/messages/read', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {}
    refreshInboxBadge();
}
function closeInbox() { document.getElementById('inbox-panel').style.display = 'none'; }

// ===== 每日签到 =====
async function fetchCheckinStatus() {
    try {
        const r = await fetch('/api/checkin/status', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
        if (r.ok) return await r.json();
    } catch {}
    return null;
}
async function refreshCheckinDot() {
    const dot = document.getElementById('checkin-dot'); if (!dot) return;
    const st = await fetchCheckinStatus();
    dot.style.display = (st && !st.claimed) ? '' : 'none';
}
async function openCheckin() {
    document.getElementById('checkin-overlay').style.display = 'flex';
    const body = document.getElementById('checkin-body');
    body.innerHTML = '<div class="hist-empty">加载中…</div>';
    const st = await fetchCheckinStatus();
    if (!st) { body.innerHTML = '<div class="hist-empty">加载失败，请重试</div>'; return; }
    renderCheckin(st);
}
function renderCheckin(st) {
    const body = document.getElementById('checkin-body');
    // 当前进度：已签到则 streak 就是今天所在天；未签到则今天将是第 (streak_shown+1) 天
    const doneDays = st.claimed ? st.streak : st.streak; // 已完成的连续天数
    const todayIdx = st.claimed ? st.streak : Math.min(st.streak + 1, 7); // 今天对应第几天（1~7）
    const grid = st.rewards.map((r, i) => {
        const day = i + 1;
        const claimed = day <= doneDays;
        const isToday = !st.claimed && day === todayIdx;
        return `<div class="ci-day${claimed ? ' claimed' : ''}${isToday ? ' today' : ''}">
            <div class="cd-d">第${day}天</div><div class="cd-r">+${r}</div></div>`;
    }).join('');
    body.innerHTML = `
        <div style="text-align:center;font-size:13px;opacity:.8">连续签到得更多，断签重置 · 当前连签 <b style="color:#f4d35e">${doneDays}</b> 天</div>
        <div class="ci-grid">${grid}</div>
        <button class="ci-claim" id="ci-claim-btn" ${st.claimed ? 'disabled' : ''} onclick="doCheckin()">
            ${st.claimed ? '今日已签到 ✓' : '签到领取 +' + st.todayReward}
        </button>`;
}
async function doCheckin() {
    const btn = document.getElementById('ci-claim-btn'); if (btn) btn.disabled = true;
    try {
        const r = await fetch('/api/checkin', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
        const data = await r.json();
        if (!r.ok) { if (btn) { btn.disabled = false; } alert(data.error || '签到失败'); return; }
        myGold = data.gold; updateUserBar();
        playSfx && playSfx('win');
        const body = document.getElementById('checkin-body');
        body.innerHTML = `<div style="text-align:center;padding:24px 8px">
            <div style="font-size:40px">🎉</div>
            <div style="font-size:18px;font-weight:bold;margin-top:8px">签到成功！+${data.reward} 🪙</div>
            <div style="opacity:.75;margin-top:6px">已连续签到 ${data.streak} 天，明天再来～</div>
            <div style="margin-top:10px;color:#f4d35e">当前金币：${myGold.toLocaleString()}</div></div>`;
        refreshCheckinDot();
    } catch { if (btn) btn.disabled = false; }
}
function closeCheckin() { document.getElementById('checkin-overlay').style.display = 'none'; }

// ===== Bug / 建议反馈 =====
function openFeedback() {
    document.getElementById('feedback-overlay').style.display = 'flex';
    document.getElementById('fb-text').value = '';
    document.getElementById('fb-contact').value = '';
    document.getElementById('fb-msg').textContent = '';
}
function closeFeedback() { document.getElementById('feedback-overlay').style.display = 'none'; }
async function submitFeedback() {
    const text = document.getElementById('fb-text').value.trim();
    const msg = document.getElementById('fb-msg');
    if (!text) { msg.style.color = '#f87171'; msg.textContent = '请先填写反馈内容'; return; }
    msg.style.color = '#8fa2c4'; msg.textContent = '提交中…';
    const { ok, data } = await authPostToken('/api/feedback', { text, contact: document.getElementById('fb-contact').value.trim() });
    if (ok) {
        msg.style.color = '#4ade80'; msg.textContent = '✅ 已收到，感谢反馈！';
        setTimeout(closeFeedback, 900);
    } else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || '提交失败，请重试'; }
}

// ===== 个人主页（资料 / 战绩 / 牌谱）=====
function openProfile() {
    document.getElementById('profile-overlay').style.display = 'flex';
    profileTab('info');
}
function closeProfile() { document.getElementById('profile-overlay').style.display = 'none'; }
function profileTab(t) {
    document.querySelectorAll('.prof-tab').forEach(b => b.classList.toggle('active', b.dataset.pt === t));
    ['info', 'stats', 'hands'].forEach(p => document.getElementById('pt-' + p).style.display = p === t ? '' : 'none');
    if (t === 'info') renderProfileInfo();
    else if (t === 'stats') loadStats(statsMode);
    else if (t === 'hands') loadHistory('history-list2', phistMode);
}
function renderProfileInfo() {
    document.getElementById('pi-head').innerHTML =
        `<div class="pi-name">${escapeHtml(myUsername || '')}</div>`
        + `<div class="pi-gold">🪙 ${(myGold || 0).toLocaleString()}</div>`;
    renderProfileAvatars();
    renderEmailSection();
}
// ── 邮箱：显示 + 绑定/更换 ──
async function authPostToken(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch {}
    return { ok: res.ok, data };
}
async function renderEmailSection() {
    const box = document.getElementById('pi-email'); if (!box) return;
    box.innerHTML = '<div style="opacity:.6;font-size:13px">邮箱加载中…</div>';
    let email = null;
    try { const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }); if (r.ok) email = (await r.json()).email; } catch {}
    box.innerHTML =
        `<div class="pi-email-row"><span>📧 ${email ? escapeHtml(email) : '<span style="color:#f87171">未绑定</span>'}</span>
            <button class="mini-btn" onclick="toggleEmailForm()">${email ? '更换' : '绑定'}</button></div>
         <div id="pi-email-form" style="display:none"></div>`;
}
function toggleEmailForm() {
    const f = document.getElementById('pi-email-form');
    if (f.style.display !== 'none') { f.style.display = 'none'; return; }
    f.style.display = '';
    f.innerHTML =
        `<input id="be-email" class="be-input" type="email" placeholder="新邮箱">
         <button class="mini-btn" onclick="emailSendCode()">发送验证码</button>
         <div id="be-step2" style="display:none;margin-top:6px">
            <input id="be-code" class="be-input" placeholder="6 位验证码" inputmode="numeric" maxlength="6">
            <button class="mini-btn" onclick="emailVerify()">确认</button>
         </div>
         <div id="be-msg" class="be-msg"></div>`;
}
function setBeMsg(m) { const el = document.getElementById('be-msg'); if (el) el.textContent = m; }
async function emailSendCode() {
    const email = document.getElementById('be-email').value.trim();
    if (!email) return setBeMsg('请输入邮箱');
    setBeMsg('发送中…');
    const { ok, data } = await authPostToken('/api/bind-email/send-code', { email });
    if (!ok) return setBeMsg(data.error || '发送失败');
    document.getElementById('be-step2').style.display = '';
    setBeMsg('验证码已发送到 ' + email + '（含垃圾箱）');
}
async function emailVerify() {
    const code = document.getElementById('be-code').value.trim();
    if (!code) return setBeMsg('请输入验证码');
    const { ok, data } = await authPostToken('/api/bind-email/verify', { code });
    if (!ok) return setBeMsg(data.error || '验证失败');
    setBeMsg('✅ 邮箱已更新');
    setTimeout(renderEmailSection, 900);
}
function renderProfileAvatars() {
    const g = document.getElementById('profile-avatar-grid');
    if (!g) return;
    g.innerHTML = `<div class="avatar-opt none ${!myAvatar ? 'sel' : ''}" onclick="setAvatar(null)">无</div>`
        + AVATARS.map(u => `<div class="avatar-opt ${myAvatar === u ? 'sel' : ''}" onclick="setAvatar('${u}')"><img src="${u}" onerror="this.style.display='none'"></div>`).join('');
}

// 生涯战绩
let statsMode = '';
function statsFilter(btn, mode) {
    btn.parentElement.querySelectorAll('.hf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); statsMode = mode; loadStats(mode);
}
async function loadStats(mode) {
    const box = document.getElementById('stats-body2');
    box.innerHTML = '<div class="hist-empty">加载中…</div>';
    try {
        const token = localStorage.getItem('token');
        const q = mode ? `?mode=${mode}` : '';
        const res = await fetch('/api/my-stats' + q, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw 0;
        renderStatsPage(await res.json());
    } catch { box.innerHTML = '<div class="hist-empty">读取战绩失败</div>'; }
}
function renderStatsPage(s) {
    const box = document.getElementById('stats-body2');
    if (!s.totalHands) { box.innerHTML = '<div class="hist-empty">还没有牌谱数据，打几手就有了</div>'; return; }
    const netCol = s.net >= 0 ? '#4ade80' : '#f87171';
    const afTxt = s.af >= 99 ? '∞' : s.af;
    const cards = [
        ['总手数', s.totalHands, ''],
        ['总盈亏', (s.net >= 0 ? '+' : '') + s.net.toLocaleString(), netCol],
        ['最大赢取', s.biggestWin.toLocaleString(), ''],
        ['VPIP 入池率', s.vpip + '%', '', '自愿入池：翻前主动跟/加的比例'],
        ['PFR 翻前加注', s.pfr + '%', '', '翻前主动加注的比例'],
        ['3-Bet 率', s.threeBet + '%', '', '面对加注再加注的比例'],
        ['弃 3-Bet', s.foldTo3bet + '%', '', '开池后被 3bet 选择弃牌的比例'],
        ['C-Bet 持续下注', s.cbet + '%', '', '作为翻前加注者翻牌续攻的比例'],
        ['AF 激进度', afTxt, '', '翻后(下注+加注)/跟注'],
        ['WTSD 摊牌率', s.wtsd + '%', '', '见翻牌后走到摊牌的比例'],
        ['W$SD 摊牌胜率', s.wsd + '%', '', '摊牌中获胜的比例'],
        ['平均思考', s.avgThinkMs ? (s.avgThinkMs / 1000).toFixed(1) + 's' : '—', ''],
    ];
    box.innerHTML = `<div class="stat-grid">` + cards.map(([k, v, col, tip]) =>
        `<div class="stat-card"${tip ? ` title="${tip}"` : ''}><div class="sc-val" style="${col ? 'color:' + col : ''}">${v}</div><div class="sc-key">${k}</div></div>`
    ).join('') + `</div>`
        + `<div class="sec-title" style="margin-top:14px">盈亏曲线（按手数）</div>`
        + profitCurveSVG(s.curve);
}
// 盈亏曲线 SVG（自适应宽度）
function profitCurveSVG(curve) {
    if (!curve || curve.length < 2) return '<div class="hist-empty" style="padding:14px">数据太少，暂无曲线</div>';
    const W = 300, H = 110, pad = 6;
    const min = Math.min(...curve, 0), max = Math.max(...curve, 0);
    const range = (max - min) || 1;
    const x = i => pad + (i / (curve.length - 1)) * (W - 2 * pad);
    const y = v => H - pad - ((v - min) / range) * (H - 2 * pad);
    const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const zeroY = y(0).toFixed(1);
    const last = curve[curve.length - 1];
    const stroke = last >= 0 ? '#4ade80' : '#f87171';
    return `<svg class="curve-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${pad}" y1="${zeroY}" x2="${W - pad}" y2="${zeroY}" stroke="rgba(255,255,255,0.18)" stroke-dasharray="3 3"/>
        <polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts}"/>
    </svg>`;
}
function histFilter(btn, mode) {
    btn.parentElement.querySelectorAll('.hf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); histMode = mode; loadHistory('history-list', mode, currentRoom);
}
// 个人主页的牌谱 tab（独立 mode 与目标容器）
let phistMode = '';
function phistFilter(btn, mode) {
    btn.parentElement.querySelectorAll('.hf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); phistMode = mode; loadHistory('history-list2', mode);
}
const HIST_PAGE = 40;
let histState = {};         // listId -> { mode, offset, loading, done }
async function loadHistory(listId, mode, room) {
    listId = listId || 'history-list'; mode = mode || '';
    histState[listId] = { mode, room: room || null, offset: 0, loading: false, done: false };
    histHandsByList[listId] = [];
    document.getElementById(listId).innerHTML = '<div class="hist-empty">加载中…</div>';
    await fetchHistPage(listId, true);
}
async function fetchHistPage(listId, first) {
    const st = histState[listId];
    if (!st || st.loading || st.done) return;
    st.loading = true;
    const btn = document.getElementById('histmore-' + listId);
    if (btn) btn.textContent = '加载中…';
    try {
        const token = localStorage.getItem('token');
        const q = `?limit=${HIST_PAGE}&offset=${st.offset}` + (st.mode ? `&mode=${st.mode}` : '') + (st.room ? `&room=${st.room}` : '');
        const res = await fetch('/api/my-hands' + q, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw 0;
        const page = await res.json();
        histHandsByList[listId] = (histHandsByList[listId] || []).concat(page);
        st.offset += page.length;
        if (page.length < HIST_PAGE) st.done = true;
        renderHistory(histHandsByList[listId], listId);
    } catch {
        if (first) document.getElementById(listId).innerHTML = '<div class="hist-empty">读取牌谱失败</div>';
    } finally { st.loading = false; }
}
let histHandsByList = {};   // listId -> hands[]（供点击回放取用）
function renderHistory(hands, listId) {
    listId = listId || 'history-list';
    histHandsByList[listId] = hands;
    const list = document.getElementById(listId);
    if (!hands.length) { list.innerHTML = '<div class="hist-empty">暂无牌谱记录</div>'; return; }
    const fmtC = s => s.replace(/T/g, '10');
    const items = hands.map((h, idx) => {
        const me = (h.seats || []).find(s => s.userId === myUserId);
        const res = (h.results || []).find(r => r.userId === myUserId);
        const won = res ? res.won : 0;
        const net = res ? ((res.endChips ?? (me ? me.startChips : 0)) - (me ? me.startChips || 0 : 0)) : 0;
        const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const tag = h.mode === 'cash' ? '现金' : 'SNG';
        const winCls = net > 0 ? 'win' : (net < 0 ? 'lose' : '');
        const holeCards = me ? me.hole.map(cs => formatCard(rpParseCard(cs))).join('') : '';
        const commCards = (h.community || []).map(cs => formatCard(rpParseCard(cs))).join('') || '<span class="hi-nocomm">未到公共牌</span>';
        return `<div class="hist-item ${winCls}" onclick="openReplayFrom('${listId}',${idx})">
            <div class="hi-head">
                <span class="hi-time">${time}·${tag}</span>
                <span class="hi-net">${net > 0 ? '+' : ''}${net.toLocaleString()} ›</span>
            </div>
            <div class="hi-cards"><span class="hi-mine">${holeCards}</span><span class="hi-comm">${commCards}</span></div></div>`;
    }).join('');
    const st = histState[listId];
    const footer = (st && !st.done)
        ? `<button class="hist-more" id="histmore-${listId}" onclick="fetchHistPage('${listId}')">加载更多（已 ${hands.length} 手）</button>`
        : `<div class="hist-empty" style="font-size:11px">— 已全部 ${hands.length} 手 —</div>`;
    list.innerHTML = items + footer;
}
function openReplayFrom(listId, idx) {
    const h = (histHandsByList[listId] || [])[idx];
    if (h) openHandDetail(h);
}

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

// ===== 比赛设置 (C10) =====
function openMatchSettings() { renderMatchInfo(lastState); document.getElementById('match-modal').style.display = 'flex'; }
function closeMatchSettings() { document.getElementById('match-modal').style.display = 'none'; }
function renderMatchInfo(st) {
    if (!st) return;
    const isCash = st.roomType === 'cash';
    const rows = [
        ['类型', isCash ? '现金桌' : 'SNG 升盲'],
        ['入场状态', iCanPlay ? '🔐 已获下场资格' : '👀 观战中'],
        ['盲注', `${st.smallBlind}/${st.bigBlind}` + (st.ante ? ` · ante ${st.ante}` : '')],
        ['最大人数', st.maxPlayers],
    ];
    if (isCash) {
        rows.push(['带入区间', `${(st.minBuyIn || 0).toLocaleString()} ~ ${st.maxBuyIn > 0 ? st.maxBuyIn.toLocaleString() : '无限制'}`]);
        rows.push(['UTG Straddle', st.allowUtgStraddle ? '🔥 已开启 · 2BB' : '未开启']);
        if (st.tableEndAt) {
            const rem = Math.max(0, Math.floor((st.tableEndAt - Date.now()) / 60000));
            rows.push(['剩余时长', `约 ${rem} 分钟`]);
        }
    } else rows.push(['当前级别', (st.currentLevel || 0) + 1]);
    const isOwner = st.ownerUserId === myUserId;
    let html = rows.map(([k, v]) => `<div class="mi-row"><span>${k}</span><b>${v}</b></div>`).join('');
    // 现金桌房主：比赛加时
    if (isCash && isOwner) {
        html += `<div class="cfg-field" style="margin-top:10px"><span class="cfg-label">UTG Straddle（下一手起生效）</span>
            <div class="tier-row"><button type="button" class="ext-btn" onclick="setUtgStraddle(${!st.allowUtgStraddle})">
            ${st.allowUtgStraddle ? '关闭 Straddle' : '开启 Straddle 2BB'}</button></div></div>`;
        html += `<div class="cfg-field" style="margin-top:10px"><span class="cfg-label">比赛加时（分钟）</span>
            <div class="tier-row">` +
            [15, 30, 60, 90, 120].map(m => `<button type="button" class="ext-btn" onclick="extendMatch(${m})">+${m}</button>`).join('') +
            `</div></div>`;
    }
    if (!isOwner) html += '<div class="mi-note">仅房主可加时 / 结束比赛</div>';
    document.getElementById('match-info').innerHTML = html;
    document.querySelectorAll('#match-modal .owner-only').forEach(e => e.style.display = isOwner ? '' : 'none');
}
function setUtgStraddle(enabled) {
    if (!socket) return;
    socket.emit('set_utg_straddle', { enabled: enabled === true });
}
function extendMatch(minutes) {
    if (!socket) return;
    if (!confirm(`确定为本场比赛加时 +${minutes} 分钟？`)) return;
    socket.emit('extend_match', { minutes });
    alert(`已加时 +${minutes} 分钟`);
}

