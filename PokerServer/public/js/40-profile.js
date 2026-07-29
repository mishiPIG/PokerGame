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
        `<div class="pi-name">${escapeHtml(myDisplayName || myUsername || '')}</div>`
        + `<div class="pi-handle">账号：${escapeHtml(myUsername || '')}</div>`
        + `<div class="pi-gold">🪙 ${(myGold || 0).toLocaleString()}</div>`;
    renderDisplayNameSection();
    renderProfileAvatars();
    renderEmailSection();
}
function renderDisplayNameSection() {
    const box = document.getElementById('pi-display-name'); if (!box) return;
    const left = Math.max(0, (myDisplayNameChangedAtMs || 0) + 86400000 - Date.now());
    const hint = left ? `下次可修改：${new Date(Date.now() + left).toLocaleString()}` : '可每 24 小时修改一次';
    box.innerHTML = `<div class="pi-section-title">显示名称</div>
        <div class="pi-name-form"><input id="display-name-input" class="be-input" maxlength="16" value="${escapeHtml(myDisplayName || myUsername || '')}" aria-label="显示名称">
        <button class="mini-btn" onclick="saveDisplayName()"${left ? ' disabled' : ''}>保存</button></div>
        <div class="be-msg" id="display-name-msg">${hint}</div>`;
}
function saveDisplayName() {
    const input = document.getElementById('display-name-input');
    const msg = document.getElementById('display-name-msg');
    if (!input || !socket) return;
    msg.textContent = '保存中…';
    socket.emit('set_display_name', { displayName: input.value }, result => {
        if (!result?.ok) {
            msg.textContent = result?.error || '保存失败，请重试';
            return;
        }
        myDisplayName = result.displayName;
        myDisplayNameChangedAtMs = result.displayNameChangedAtMs || myDisplayNameChangedAtMs;
        updateUserBar();
        if (lastState) render(lastState);
        renderProfileInfo();
    });
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
