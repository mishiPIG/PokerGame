// ===== 大厅 / 房间 =====
function hideStraddleOffer() {
    straddleOffer = null;
    clearInterval(straddleOfferTimer); straddleOfferTimer = null;
    const el = document.getElementById('straddle-flag');
    if (el) el.style.display = 'none';
}
// 小标志：只显示「STR ×第几档」，不占地方、不打断行动，随时可点。
function renderStraddleOffer() {
    if (!straddleOffer) return;
    const el = document.getElementById('straddle-flag');
    if (!el) return;
    document.getElementById('straddle-flag-n').textContent = '×' + ((straddleOffer.chainIndex || 0) + 1);
    el.style.display = '';
}
function positionStraddleOffer() { /* 贴在牌桌右边缘，纯 CSS 定位，无需跟随座位 */ }
function answerStraddle(accept) {
    if (!straddleOffer || !socket) return;
    const targetHandSeq = straddleOffer.targetHandSeq, amount = straddleOffer.amount;
    hideStraddleOffer();                       // 点完立刻消失
    socket.emit('straddle_decision', { targetHandSeq, accept: accept === true });
    if (accept === true) toast(L(`🔥 下一手 straddle ${fmtChips(amount)}`, `🔥 Next hand straddle ${fmtChips(amount)}`));
}

function showReconnecting() {
    let el = document.getElementById('reconnecting-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'reconnecting-toast';
        el.textContent = '🔌 连接中断，重连中…';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;text-align:center;padding:8px;'
            + 'background:rgba(214,64,64,0.96);color:#fff;font-size:13px;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
        document.body.appendChild(el);
    }
    el.style.display = 'block';
}
function hideReconnecting() {
    const el = document.getElementById('reconnecting-toast');
    if (el) el.style.display = 'none';
}
// 账号在别处打开被踢下线：全屏遮罩提示 + 「在此页继续」按钮（刷新即抢回本页会话）
function showKickedNotice(reason) {
    hideReconnecting();
    let el = document.getElementById('kicked-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'kicked-overlay';
        el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;'
            + 'background:rgba(6,10,18,0.88);padding:24px';
        el.innerHTML = '<div style="max-width:340px;background:linear-gradient(160deg,#1b2740,#0e1626);color:#e7eefb;'
            + 'border-radius:16px;padding:22px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.1)">'
            + '<div style="font-size:34px;margin-bottom:8px">🔒</div>'
            + '<div style="font-size:16px;font-weight:bold;margin-bottom:8px">此页面已断开</div>'
            + '<div id="kicked-reason" style="font-size:13px;color:#9fb4d6;line-height:1.6;margin-bottom:16px"></div>'
            + '<button onclick="location.reload()" style="width:100%;padding:11px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:bold;'
            + 'background:rgba(120,160,220,0.25);border:1px solid rgba(120,160,220,0.6);color:#eaf1fb">在此页面继续（刷新）</button></div>';
        document.body.appendChild(el);
    }
    document.getElementById('kicked-reason').textContent =
        (reason || '你的账号在其他页面打开了。') + ' 为保证手牌不外泄，同一账号只能在一个页面使用。';
    el.style.display = 'flex';
}
// 公共牌下方一行提示（如"某某想看转牌"），几秒后自动消失
let _noticeTimer = 0;
function showTableNotice(text) {
    const el = document.getElementById('table-notice');
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
    clearTimeout(_noticeTimer);
    _noticeTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ===== 多次发牌（run it N times）UI =====
function nameOf(userId) {
    const st = lastState || {};
    const p = (st.players || []).find(x => x.userId === userId) || (st.spectators || []).find(x => x.userId === userId);
    return p ? (p.displayName || p.username) : '玩家';
}
function runitPanel() {
    let el = document.getElementById('runit-panel');
    if (!el) {
        el = document.createElement('div');
        el.id = 'runit-panel';
        document.body.appendChild(el);
    }
    return el;
}
let runitCountdownTimer = null;
function hideRunitPanel() { const el = document.getElementById('runit-panel'); if (el) el.style.display = 'none'; clearInterval(runitCountdownTimer); runitCountdownTimer = null; }
// 决策倒计时：把剩余秒数刷进面板 #runit-countdown，到点自动停（服务端到点默认发1次）
function startRunitCountdown(deadlineAt) {
    clearInterval(runitCountdownTimer); runitCountdownTimer = null;
    if (!deadlineAt) return;
    const tick = () => {
        const c = document.getElementById('runit-countdown');
        if (!c) { clearInterval(runitCountdownTimer); runitCountdownTimer = null; return; }
        const remain = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
        c.textContent = remain + 's';
        if (remain <= 0) { clearInterval(runitCountdownTimer); runitCountdownTimer = null; }
    };
    tick();
    runitCountdownTimer = setInterval(tick, 500);
}
// 轮到我做多次发牌决策时，振动 + 提示音提醒（否则容易错过窗口，被误退化成发1次）
function runitAlert() { try { vibrate([80, 60, 80]); } catch {} try { if (typeof sndWarn === 'function') sndWarn(); } catch {} }
function showRunitOffer(o) {
    const el = runitPanel();
    const eqTxt = (id) => (o.equities && o.equities[id] != null) ? ` <span class="ri-eq">${o.equities[id]}%</span>` : '';
    if (o.deciderId === myUserId) {
        const maxN = Math.max(2, Math.min(5, o.max || 5));   // 牌堆不足时服务端会给更小的 max
        const btns = Array.from({ length: maxN }, (_, i) => i + 1);
        el.innerHTML = `<div class="ri-title">${L('🎲 发几次牌？', '🎲 Run it how many times?')}<span class="ri-hint">${L('（你落后，可要求多发几次分摊运气）', ' (you\'re behind — run it more to spread the variance)')}</span></div>`
            + `<div class="ri-btns">` + btns.map(n => `<button onclick="proposeRuns(${n})">${n}</button>`).join('') + `</div>`
            + `<div class="ri-count">⏳ <span id="runit-countdown">--</span> ${L('后自动只发 1 次', 'left — defaults to 1 run')}</div>`;
        startRunitCountdown(o.deadlineAt);
        runitAlert();
    } else if (o.leaderId === myUserId) {
        el.innerHTML = `<div class="ri-title">${L('🎲 等待对方选择发牌次数…', '🎲 Waiting for them to choose how many runs…')}</div>`
            + `<div class="ri-sub">${L('你领先', 'You lead')}${eqTxt(myUserId)}${L('，对方可提议发多次', ' — they may propose multiple runs')}</div>`;
    } else {
        el.innerHTML = `<div class="ri-title">${L('🎲 双方协商发牌中…', '🎲 Players negotiating runs…')}</div>`;
    }
    el.style.display = 'block';
}
function showRunitProposal(pr) {
    const el = runitPanel();
    if (pr.leaderId === myUserId) {
        el.innerHTML = `<div class="ri-title">${L('🎲 对方想发', '🎲 They want to run it')} <b>${pr.n}</b> ${L('次', 'times')}</div>`
            + `<div class="ri-sub">${L(`同意则底池均分 ${pr.n} 份、各发一次不同公共牌`, `If you agree, the pot splits into ${pr.n} and each runs a different board`)}</div>`
            + `<div class="ri-btns"><button class="ri-yes" onclick="respondRuns(true)">${L(`同意发 ${pr.n} 次`, `Agree: ${pr.n} runs`)}</button>`
            + `<button class="ri-no" onclick="respondRuns(false)">${L('只发 1 次', 'Just 1')}</button></div>`
            + `<div class="ri-count">⏳ <span id="runit-countdown">--</span> ${L('未回应则默认只发 1 次', 'left — no reply defaults to 1 run')}</div>`;
        startRunitCountdown(pr.deadlineAt);
        runitAlert();
    } else {
        el.innerHTML = `<div class="ri-title">${L(`🎲 已提议发 ${pr.n} 次，等待领先方同意…`, `🎲 Proposed ${pr.n} runs — waiting for the leader to agree…`)}</div>`;
    }
    el.style.display = 'block';
}
function proposeRuns(n) { if (socket) socket.emit('propose_runs', { n }); const el = runitPanel(); el.innerHTML = `<div class="ri-title">${L(`🎲 已选发 ${n} 次，等待对方同意…`, `🎲 Chose ${n} runs — waiting for them to agree…`)}</div>`; }
function respondRuns(agree) { if (socket) socket.emit('respond_runs', { agree }); hideRunitPanel(); }

// 多次发牌桌面：共享底牌只显示一次，剩余街 N 组「并列」分行显示（都留在桌上、不覆盖）
function clearRunit() {
    runitState = null;
    const bd = document.getElementById('board'); if (bd) bd.classList.remove('runit-on');
    const el = document.getElementById('runit-boards'); if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}
function buildRunitBoards(m) {
    const el = document.getElementById('runit-boards'); if (!el || !m) return;
    const baseLen = m.baseLen || 0, n = m.n || 1, base = m.base || [];
    runitState = { n, baseLen, filled: Array(n).fill(0) };
    let html = '';
    if (baseLen > 0) {   // 共享公共牌行（已发的 3/4 张，只显示一次）
        let s = '';
        for (let i = 0; i < 5; i++) s += i < baseLen ? formatCard(base[i]) : '<span class="rib-slot"></span>';
        html += `<div class="rib-shared"><span class="rib-label">公共</span><div class="rib-slots">${s}</div></div>`;
    }
    for (let r = 0; r < n; r++) {   // 每组一行：前 baseLen 个位置留空对齐，剩余街是本组的牌
        let s = '';
        for (let i = 0; i < 5; i++) s += `<span class="rib-slot${i < baseLen ? ' ghost' : ''}"></span>`;
        html += `<div class="rib-row" data-run="${r}"><span class="rib-label">第${r + 1}次</span><div class="rib-slots">${s}</div></div>`;
    }
    el.innerHTML = html;
    el.style.display = 'flex';
    document.getElementById('board').classList.add('runit-on');   // 隐藏原单行公共牌，避免重复
}
function runitDealStreet(m) {
    if (!runitState) return;
    const slots = document.querySelector(`#runit-boards .rib-row[data-run="${m.run}"] .rib-slots`);
    if (!slots) return;
    const start = runitState.baseLen + runitState.filled[m.run];
    (m.cards || []).forEach((c, k) => {
        const slot = slots.children[start + k];
        if (slot) slot.outerHTML = formatCard(c, true, k * 130);   // 替换占位为发牌动画
    });
    runitState.filled[m.run] += (m.cards || []).length;
    sndFlip(0);
    document.querySelectorAll('#runit-boards .rib-row').forEach(rw => rw.classList.toggle('active', +rw.dataset.run === m.run));
}
function runitAward(m) {
    // 该组比完：本行金色高亮（不再显示文字），筹码飞向本组赢家的座位（谁赢一目了然）
    const rowEl = document.querySelector(`#runit-boards .rib-row[data-run="${m.run}"]`);
    if (rowEl) { rowEl.classList.add('win'); rowEl.classList.remove('active'); }
    (m.winners || []).forEach(w => { flyCoinsToWinner(w.userId); winPopup(w.userId, w.amount); if (w.userId === myUserId) vibrate([30, 40, 30]); });
}
// 轻量非阻塞提示（自动消失，不像 alert 会卡住交互）
let _toastTimer = 0;
// —— 结算颁奖台（纯娱乐调侃）：🥇老板=亏最多(该请客了) 🥈MVP=赢最多 🥉力工=手数最多 ——
// 排名行里的小称号标签
function awardTags(awards, userId) {
    if (!awards) return '';
    const t = [];
    if (awards.boss && awards.boss.userId === userId) t.push(L('🥇老板', '🥇Boss'));
    if (awards.mvp && awards.mvp.userId === userId) t.push('🥈MVP');
    if (awards.worker && awards.worker.userId === userId) t.push(L('🥉力工', '🥉Grinder'));
    return t.map(x => `<span class="rk-tag">${x}</span>`).join('');
}
function renderPodium(awards) {
    const box = document.getElementById('result-podium');
    if (!box) return;
    if (!awards || (!awards.boss && !awards.mvp && !awards.worker)) { box.innerHTML = ''; return; }
    const cell = (a, cls, medal, title, valText) => {
        if (!a) return '';
        const name = escapeHtml(a.displayName || a.username || '');
        const initial = (a.displayName || a.username || '?').charAt(0).toUpperCase();
        const face = a.avatar
            ? `<img class="pd-avatar" src="${escapeHtml(a.avatar)}" alt="" onerror="this.outerHTML='<div class=\\'pd-avatar\\'>${initial}</div>'">`
            : `<div class="pd-avatar">${initial}</div>`;
        return `<div class="pd-item ${cls}">
            <div class="pd-medal">${medal}</div>${face}
            <div class="pd-title">${title}</div>
            <div class="pd-name">${name}</div>
            <div class="pd-val">${valText}</div>
            <div class="pd-step"></div>
        </div>`;
    };
    // 视觉顺序：银(左) 金(中) 铜(右)，符合领奖台直觉
    box.innerHTML =
        cell(awards.mvp, 'silver', '🥈', 'MVP', `+${(awards.mvp?.net || 0).toLocaleString()} ${awards.mvp?.unit || ''}`)
        + cell(awards.boss, 'gold', '🥇', L('老板', 'Boss'), `${(awards.boss?.net || 0).toLocaleString()} ${awards.boss?.unit || ''}`)
        + cell(awards.worker, 'bronze', '🥉', L('力工', 'Grinder'), `${awards.worker?.handsPlayed || 0} ${L('手', 'hands')}`);
}

function toast(msg, ms = 2600) {
    let el = document.getElementById('mini-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'mini-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:9998;max-width:82%;'
            + 'background:rgba(18,27,43,0.96);color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;line-height:1.4;'
            + 'text-align:center;box-shadow:0 6px 22px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.15);pointer-events:none;';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}
function showLobby() {
    cancelVoiceRecording();
    stopVoicePlayback();
    clearVoiceBubbles();
    hideStraddleOffer();
    currentRoom = '';
    localStorage.removeItem('currentRoom');
    document.body.classList.remove('in-room');
    document.getElementById('lobby-view').style.display = '';
    document.getElementById('table-view').style.display = 'none';
    // 清空牌桌渲染状态，避免回大厅再进残留上一局
    myHoleCards = []; revealedCards = {}; lastState = null;
    hideRunitPanel(); clearRunit();
    prevCommunityCount = 0; holeJustDealt = false; revealJustHappened = false;
    prevFoldedSet = new Set(); foldingNow = new Set();
    shownCards = {}; myShown = new Set(); showJustHappened = false;
    showdownInfo = null; myHand = null; mySeated = false; prevChipsShown = {}; roomInviteInfo = null;
    // 关闭所有桌内面板/弹窗
    ['table-menu','buyin-modal','stats-panel','history-panel','match-modal','invite-modal','inbox-panel','profile-overlay','chat-panel','replay-overlay'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    if (socket) socket.emit('enter_lobby');
    refreshInboxBadge();
    refreshCheckinDot();
}
function showTable() {
    document.getElementById('lobby-view').style.display = 'none';
    document.getElementById('table-view').style.display = '';
    document.body.classList.add('in-room');
    // 刚从大厅切过来时牌桌尺寸还没定下来，此时算出的座位坐标不准（座位会挤在一起）。
    // 等浏览器完成一次布局后再重排一遍，坐标才是按真实尺寸算的。
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (typeof lastState !== 'undefined' && lastState && typeof render === 'function') render(lastState);
    }));
}
let createTab = 'sng';
const CASH_BLINDS = [[10,20],[20,40],[30,60],[50,100],[100,200],[200,400],[300,600],[500,1000]];
// SNG 报名费档位（2 人冠军奖励参考；多人时奖池随人数变大）
const SNG_TIERS = [[110, 200], [220, 400], [550, 1000], [1100, 2000]];
let sngBuyin = 110;
function renderSngTiers() {
    const row = document.getElementById('sngBuyinRow');
    row.innerHTML = SNG_TIERS.map(([fee, prize]) =>
        `<button type="button" class="tier-btn${fee === sngBuyin ? ' sel' : ''}" onclick="selectSngTier(${fee})">
            🪙${fee}<small>冠军≈${prize}</small></button>`).join('');
}
function selectSngTier(fee) { sngBuyin = fee; renderSngTiers(); }
// 现金桌训练时长档位（小时）
const CASH_DUR_TIERS = [0.5, 1, 2, 3, 4, 5, 6];
let ccDur = 2;
function renderCcDur() {
    const row = document.getElementById('ccDurRow');
    row.innerHTML = CASH_DUR_TIERS.map(h =>
        `<button type="button" class="tier-btn${h === ccDur ? ' sel' : ''}" onclick="selectCcDur(${h})">${h}h</button>`).join('');
}
function selectCcDur(h) { ccDur = h; renderCcDur(); }
function showCreateForm() { document.getElementById('create-form').style.display = ''; switchCreateTab(createTab); updateCashLabels(); renderSngTiers(); renderCcDur(); }
function hideCreateForm() { document.getElementById('create-form').style.display = 'none'; }
function switchCreateTab(t) {
    createTab = t;
    document.getElementById('create-sng').style.display  = t === 'sng' ? '' : 'none';
    document.getElementById('create-cash').style.display = t === 'cash' ? '' : 'none';
    document.getElementById('ctTabSng').classList.toggle('active', t === 'sng');
    document.getElementById('ctTabCash').classList.toggle('active', t === 'cash');
}
function updateCashLabels() {
    const [sb, bb] = CASH_BLINDS[parseInt(document.getElementById('ccBlind').value)];
    document.getElementById('ccBlindVal').textContent = `${sb} / ${bb}`;
    document.getElementById('ccAnteVal').textContent = document.getElementById('ccAnte').value;
    document.getElementById('ccMaxVal').textContent = document.getElementById('ccMax').value;
    document.getElementById('ccMinVal').textContent = (+document.getElementById('ccMin').value).toLocaleString();
    const cap = +document.getElementById('ccCap').value;
    document.getElementById('ccCapVal').textContent = cap === 0 ? L('无限制', 'Unlimited') : cap.toLocaleString();
}
function submitCreate() {
    if (!socket) return;
    if (createTab === 'cash') {
        const [sb, bb] = CASH_BLINDS[parseInt(document.getElementById('ccBlind').value)];
        socket.emit('create_cash_room', {
            name: document.getElementById('ccName').value,
            sb, bb,
            ante: parseInt(document.getElementById('ccAnte').value),
            allowUtgStraddle: document.getElementById('ccStraddle').checked,
            maxPlayers: parseInt(document.getElementById('ccMax').value),
            minBuyIn: parseInt(document.getElementById('ccMin').value),
            maxBuyIn: parseInt(document.getElementById('ccCap').value),
            durationH: ccDur
        });
    } else {
        socket.emit('create_room', {
            name:          document.getElementById('cfgName').value,
            startingStack: parseInt(document.getElementById('cfgStack').value),
            levelMinutes:  parseInt(document.getElementById('cfgLevel').value),
            maxPlayers:    parseInt(document.getElementById('cfgMax').value),
            buyIn:         sngBuyin
        });
    }
    hideCreateForm();
}
// —— 四格房间码：只收数字、逐格自动跳、输满 4 位自动加入（无需按钮）——
function codeBoxes() { return Array.from(document.querySelectorAll('#joinCodeBoxes .code-box')); }
function getJoinCode() { return codeBoxes().map(b => b.value).join(''); }
function onCodeInput(el, idx) {
    el.value = el.value.replace(/\D/g, '').slice(0, 1);   // 只留一位数字
    const boxes = codeBoxes();
    if (el.value && idx < boxes.length - 1) boxes[idx + 1].focus();
    if (getJoinCode().length === boxes.length) joinByCode();   // 输满自动加入
}
function onCodeKey(e, el, idx) {
    const boxes = codeBoxes();
    if (e.key === 'Backspace' && !el.value && idx > 0) { boxes[idx - 1].focus(); boxes[idx - 1].value = ''; e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && idx > 0) boxes[idx - 1].focus();
    else if (e.key === 'ArrowRight' && idx < boxes.length - 1) boxes[idx + 1].focus();
    else if (e.key === 'Enter') joinByCode();
}
function onCodePaste(e) {
    const t = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '').slice(0, 4);
    if (!t) return;
    e.preventDefault();
    const boxes = codeBoxes();
    boxes.forEach((b, i) => { b.value = t[i] || ''; });
    boxes[Math.min(t.length, boxes.length - 1)].focus();
    if (t.length === boxes.length) joinByCode();
}
// 房间码校验：服务端成功→授予下场资格；房间不存在→invite_error 里 toast 提示并清空重输。
function joinByCode() {
    const code = getJoinCode();
    if (!/^\d{4}$/.test(code)) { toast(L('请输入四位数字房间码', 'Enter the 4-digit room code')); return; }
    if (!socket || !socket.connected) { toast(L('正在连接服务器，请稍后', 'Connecting to server, please wait')); return; }
    if (window._joinSubmitting) return;   // 防抖：一次输满只发一次
    window._joinSubmitting = true;
    socket.emit('join_by_code', { code });
    clearTimeout(window._joinCodeUnlock);
    window._joinCodeUnlock = setTimeout(() => { window._joinSubmitting = false; }, 4000);
}
// 加入成功/失败后复位（失败时清空四格并聚焦第一格，方便重输）
function resetJoinCode(clearBoxes) {
    window._joinSubmitting = false;
    clearTimeout(window._joinCodeUnlock);
    if (clearBoxes) { const b = codeBoxes(); b.forEach(x => { x.value = ''; }); if (b[0]) b[0].focus(); }
}
// 从大厅列表点进 = 只观战；服务端已授权成员则重新加入。
function joinRoomId(roomId) {
    if (!roomId || !socket) return;
    socket.emit('join_room', { roomId });
}

function openInvite(requestInfo = true) {
    const modal = document.getElementById('invite-modal');
    modal.style.display = 'flex';
    if (!roomInviteInfo) {
        document.getElementById('invite-loading').style.display = '';
        document.getElementById('invite-content').style.display = 'none';
    }
    if (requestInfo && socket) socket.emit('get_room_invite');
}
function closeInvite() { document.getElementById('invite-modal').style.display = 'none'; }
function renderInviteInfo() {
    if (!roomInviteInfo) return;
    document.getElementById('invite-loading').style.display = 'none';
    document.getElementById('invite-content').style.display = '';
    document.getElementById('invite-message').textContent = formatRoomInvite(roomInviteInfo);
    const lock = document.getElementById('invite-lock-btn');
    lock.textContent = roomInviteInfo.entryLocked ? '🔒 已锁定入场' : '🔓 开放入场';
    lock.classList.toggle('locked', !!roomInviteInfo.entryLocked);
}
async function copyText(text, successMessage) {
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            if (!ok) throw new Error('copy failed');
        }
        toast(successMessage);
    } catch {
        toast(L('复制失败，请长按内容手动复制', 'Copy failed — long-press to copy manually'));
    }
}
function formatRoomInvite(invite) {
    if (!invite?.inviteUrl || !invite?.joinCode) return '';
    const roomName = invite.roomName ? `房间名：${invite.roomName}\n` : '';
    return `${roomName}邀请链接：${invite.inviteUrl}\n房间码：${invite.joinCode}`;
}
function copyRoomInvite() {
    copyText(formatRoomInvite(roomInviteInfo), '邀请信息已复制');
}
function toggleEntryLock() {
    if (!socket || !roomInviteInfo) return;
    socket.emit('set_entry_locked', { locked: !roomInviteInfo.entryLocked });
}
function resetRoomInvite() {
    if (!socket || !roomInviteInfo) return;
    if (!confirm(L('重置后，已经发出的旧链接和旧房间码会立即失效；已加入的朋友不受影响。确定重置？', 'Resetting immediately invalidates the old link and room code; friends already in are unaffected. Reset?'))) return;
    socket.emit('reset_room_invite');
}
function leaveRoom() {
    if (!socket) return;
    const isCash = lastState && lastState.roomType === 'cash';
    const amSeated = lastState && lastState.players && lastState.players.some(p => p.userId === myUserId);
    if (isCash && amSeated) {
        if (!confirm(L('离开牌桌：座位与筹码【保留】，只在本局结束/解散时才统一结算金币；之后可随时「重新进入」接上原座位与盈亏（战绩不清零）。确定离开？', 'Leave the table: your seat and chips are KEPT and only settled to coins when the game ends/dissolves; you can "Re-enter" anytime to resume your seat and P/L. Leave?'))) return;
    }
    socket.emit('leave_room');
}
function dissolveRoom() {
    if (!socket) return;
    const isCash = lastState && lastState.roomType === 'cash';
    const msg = isCash
        ? '确定解散牌桌？各家将按汇率把剩余筹码兑回金币、全部回到大厅。'
        : '确定解散比赛？比赛将结束，奖池归当前筹码领先者。';
    if (confirm(msg)) socket.emit('dissolve_room');
}
function closeResult() {
    document.getElementById('result-overlay').style.display = 'none';
    leaveRoom();
}

// ===== 桌内菜单 (B7) =====
function toggleTableMenu() {
    const m = document.getElementById('table-menu');
    const show = m.style.display === 'none';
    if (show) {
        const st = lastState || {};
        const isCash  = st.roomType === 'cash';
        const isOwner = st.ownerUserId === myUserId;
        const amSeated = st.players && st.players.some(p => p.userId === myUserId);
        m.querySelectorAll('.cash-only').forEach(e => e.style.display = (isCash && amSeated) ? '' : 'none');
        m.querySelectorAll('.seat-only').forEach(e => e.style.display = (isCash && amSeated) ? '' : 'none');
        m.querySelectorAll('.owner-only').forEach(e => e.style.display = isOwner ? '' : 'none');
        const pb = document.getElementById('tmPause');
        if (pb) pb.textContent = st.paused ? '▶️ 继续发牌' : '⏸️ 暂停发牌';
    }
    m.style.display = show ? '' : 'none';
}
// 站起围观 / 留座离座 / 回到座位
function standUp() {
    if (socket && confirm(L('确定站起围观？将【离开座位】（座位空出、他人可坐），筹码保留至结束/解散时结算；可随时「回到座位」带原筹码回来。', 'Stand up to watch? You LEAVE your seat (it frees up for others); chips are kept until the game ends/dissolves. You can "Sit back" anytime with your chips.'))) socket.emit('stand_up');
}
function reserveLeave() {
    if (socket) { socket.emit('reserve_leave'); alert('已留座离座，2 分钟内回来保留座位（点座位「回到座位」即可）'); }
}
function sitBack() { if (socket) socket.emit('sit_back'); }

// 房主：暂停/继续发牌（暂停后当前这手打完不开新局）
function togglePauseDealing() {
    if (!socket) return;
    if (lastState && lastState.paused) socket.emit('resume_dealing');
    else { socket.emit('pause_dealing'); alert('已暂停发牌：当前这手打完后暂停，随时可点「继续发牌」恢复。'); }
}
// 房主：强制某玩家站起到观战席（腾出座位）
function forceStand(targetUserId) {
    if (!socket) return;
    const st = lastState; if (!st) return;
    const tp = (st.players || []).find(p => p.userId === targetUserId);
    const nm = tp ? (tp.displayName || tp.username) : '该玩家';
    if (confirm(L(`把「${nm}」移到观战席？其座位将空出（筹码保留至结束结算，TA 可自行「回到座位」）。`, `Move "${nm}" to the rail? Their seat frees up (chips kept until settlement; they can "Sit back").`))) {
        socket.emit('force_stand', { targetUserId });
        closeAvatarPopup();
    }
}

// ===== 坐下/补码 买入弹窗 (A2/A3) =====
let buyinMode = 'sit';
let pendingSeat = -1;
function openSitDown(seat) {
    const st = lastState; if (!st || st.roomType !== 'cash') return;
    if (st.players.some(p => p.userId === myUserId)) { return; }   // 已入座
    // 站起围观者回座：带原筹码直接回座，不弹买入框、不再扣金币
    if ((st.vacatedUserIds || []).includes(myUserId)) {
        if (socket) socket.emit('sit_down', { seat: (seat == null ? -1 : seat) });
        return;
    }
    // 观战者无下场资格：提示，不弹买入框
    if (!iCanPlay) { toast(L('👀 观战中，无法入座——请使用房主分享的邀请链接或四位房间码加入', "👀 Spectating — to sit down, join via the host's invite link or 4-digit code")); return; }
    buyinMode = 'sit';
    pendingSeat = (seat == null ? -1 : seat);
    const min = st.minBuyIn || 2000;
    const max = st.maxBuyIn > 0 ? st.maxBuyIn : Math.max(min * 4, 8000);
    setupBuyin(`坐下带入 · ${pendingSeat >= 0 ? (pendingSeat + 1) + ' 号位' : ''}`, [min, max, min], false, false, st.bigBlind || 20);
}
const REBUY_TIERS_BB = [50, 100, 150, 200, 250, 300, 400, 500];   // 补码梯度（BB）
let buyinValue = 0;   // 当前选定的带入/补码记分牌数
function openRebuy() {
    const st = lastState; if (!st || st.roomType !== 'cash') return;
    const me = st.players.find(p => p.userId === myUserId);
    if (!me) { alert('请先坐下入座'); return; }
    buyinMode = 'rebuy';
    const bb = st.bigBlind || 20;
    const cap = st.maxBuyIn > 0 ? (st.maxBuyIn - me.chips - (me.pendingRebuy || 0)) : Infinity;   // 受带入上限约束
    // 生成 ≤cap 的 BB 梯度
    const tiers = REBUY_TIERS_BB.map(x => x * bb).filter(c => c <= cap);
    setupBuyin('补充记分牌', tiers.length ? tiers : [Math.min(50 * bb, cap)], true, !!me.autoRebuy, bb);
}
// tiers: 记分牌数组（梯度按钮）；showAuto: 显示自动补码；bb: 大盲（用于标签）
function setupBuyin(title, tiers, showAuto, autoOn, bb) {
    document.getElementById('bm-title').textContent = title;
    const tierBox = document.getElementById('bm-tiers');
    const slider = document.getElementById('bm-slider');
    if (buyinMode === 'rebuy') {
        slider.style.display = 'none';
        tierBox.style.display = 'flex';
        tierBox.innerHTML = tiers.map(c =>
            `<button type="button" class="bm-tier" data-c="${c}" onclick="selectBuyinTier(${c})">${Math.round(c / bb)}BB<small>${c.toLocaleString()}</small></button>`).join('');
        selectBuyinTier(tiers[0]);
    } else {
        tierBox.style.display = 'none';
        slider.style.display = '';
        const [min, max, def] = tiers;   // 坐下模式：tiers=[min,max,def]
        const step = Math.max(100, Math.round(min / 4 / 100) * 100) || 500;
        slider.min = min; slider.max = max; slider.step = step;
        slider.value = Math.min(Math.max(def, min), max);
        onBuyinSlide();
    }
    document.getElementById('bm-auto-wrap').style.display = showAuto ? '' : 'none';
    document.getElementById('bm-auto').checked = autoOn;
    document.getElementById('bm-gold').textContent = (myGold || 0).toLocaleString();
    document.getElementById('buyin-modal').style.display = 'flex';
}
function selectBuyinTier(chips) {
    buyinValue = chips;
    document.querySelectorAll('#bm-tiers .bm-tier').forEach(b => b.classList.toggle('sel', +b.dataset.c === chips));
    updateBuyinDisplay(chips);
}
function onBuyinSlide() {
    buyinValue = +document.getElementById('bm-slider').value;
    updateBuyinDisplay(buyinValue);
}
function updateBuyinDisplay(v) {
    document.getElementById('bm-val').textContent = v.toLocaleString();
    document.getElementById('bm-cost').textContent = Math.ceil(v * 0.11);
}
function closeBuyin() { document.getElementById('buyin-modal').style.display = 'none'; }
function confirmBuyin() {
    if (!socket || !buyinValue) return;
    if (buyinMode === 'sit') {
        socket.emit('sit_down', { buyInChips: buyinValue, seat: pendingSeat });
    } else {
        const auto = document.getElementById('bm-auto').checked;
        socket.emit('rebuy', { amount: buyinValue, auto });
    }
    closeBuyin();
}

// ===== 当前战绩面板 (C8) =====
function openStats() { renderStats(lastState); document.getElementById('stats-panel').style.display = ''; }
function closeStats() { document.getElementById('stats-panel').style.display = 'none'; }
function renderStats(st) {
    if (!st) return;
    const body = document.getElementById('stats-body');
    const row = (name, buyIn, hands, net, dim, tag) => {
        const sign = net >= 0 ? '+' : '';
        const col = net >= 0 ? '#4ade80' : '#f87171';
        return `<tr style="${dim ? 'opacity:0.42' : ''}"><td>${escapeHtml(name)}${tag}</td>
            <td>${(buyIn || 0).toLocaleString()}</td><td>${hands || 0}</td>
            <td style="color:${col}">${sign}${(net || 0).toLocaleString()}</td></tr>`;
    };
    const curIds = new Set((st.players || []).map(p => p.userId));
    // 汇总在座 + 已离开，统一按盈利从多到少排序
    const rows = (st.players || []).map(p => {
        const inactive = p.standing || p.reserved || p.away || p.sittingOut;
        const tag = (p.userId === myUserId ? ' (你)' : '') + (p.standing ? ' 🧍' : p.reserved ? ' 💺' : p.away ? ' 📴' : p.sittingOut ? ' 💤' : '');
        return { name: p.displayName || p.username, buyIn: p.buyIn, hands: p.handsPlayed, net: displayNet(p), dim: inactive, tag };
    });
    // 站起围观者（已离座但带入过）：灰显保留战绩，不清空
    (st.vacated || []).filter(v => !curIds.has(v.userId)).forEach(v =>
        rows.push({ name: v.displayName || v.username, buyIn: v.buyIn, hands: v.handsPlayed, net: v.net || 0, dim: true, tag: ' 🧍围观' }));
    const shownIds = new Set([...curIds, ...(st.vacated || []).map(v => v.userId)]);
    (st.statsHistory || []).filter(h => !shownIds.has(h.userId)).forEach(h =>
        rows.push({ name: h.displayName || h.username, buyIn: h.buyIn, hands: h.handsPlayed, net: h.net || 0, dim: true, tag: ' 🚪已离开' }));
    rows.sort((a, b) => b.net - a.net);
    body.innerHTML = rows.map(r => row(r.name, r.buyIn, r.hands, r.net, r.dim, r.tag)).join('')
        || '<tr><td colspan="4" style="text-align:center;opacity:.6">暂无在座玩家</td></tr>';
    const specs = st.spectators || [];
    document.getElementById('spec-count').textContent = `观众 (${specs.length})`;
    document.getElementById('spec-list').innerHTML = specs.map(s =>
        `<span class="spec-chip">${escapeHtml(s.displayName || s.username)}</span>`).join('') || '<span style="opacity:.5">无</span>';
}

// ===== 大厅房间列表 =====
function renderRoomList(rooms) {
    window._lastRooms = rooms;   // 缓存：切语言时可立即用新语言重渲染
    const box = document.getElementById('room-list');
    document.getElementById('room-count').textContent = rooms.length ? `(${rooms.length})` : '';
    if (!rooms.length) {
        box.innerHTML = `<div class="room-empty">${L('暂无房间，点「创建比赛」发起一局', 'No rooms yet — tap "Create game" to start one')}</div>`;
        return;
    }
    box.innerHTML = rooms.map(r => {
        const full    = r.playerCount >= r.maxPlayers;
        const running = r.status === 'running';
        // 我是本房成员 → 始终可「重新进入」（重连回桌）；否则进行中/已满则灰
        let btnLabel, disabled, cls = '';
        if (r.isMember) { btnLabel = L('重新进入', 'Re-enter'); disabled = false; cls = 'rejoin'; }
        else            { btnLabel = L('👀 观战', '👀 Spectate');  disabled = false; }   // 非成员：只能观战（下场需验证邀请）
        const isCash = r.roomType === 'cash';
        const tag  = isCash ? `<span class="rc-tag cash">${L('现金桌', 'Cash')}</span>` : `<span class="rc-tag">${L('SNG·升盲', 'SNG')}</span>`;
        const meta = isCash
            ? `👤 ${r.playerCount}/${r.maxPlayers} · ${L('盲注', 'Blinds')} ${r.sb}/${r.bb}${r.ante ? ' · ante '+r.ante : ''} · ${L('带入≥', 'Buy-in≥')}${(r.minBuyIn||0).toLocaleString()}`
            : `👤 ${r.playerCount}/${r.maxPlayers} · ⏱ ${r.levelMinutes}min · 🪙${L('报名', 'Buy-in')} ${r.buyIn}`;
        return `<div class="room-card">
            <div class="rc-main">
                <div class="rc-name">${escapeHtml(r.name)}</div>
                <div class="rc-meta"><span class="rc-owner">${escapeHtml(r.ownerName)}</span>${tag} ${meta}</div>
            </div>
            <button class="rc-join ${cls}" ${disabled ? 'disabled' : ''} onclick="joinRoomId('${r.roomId}')">${btnLabel}</button>
        </div>`;
    }).join('');
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
            rows.push(['预计结束', formatMatchEndTime(st.tableEndAt)]);
        }
        if (st.timeExpired) {
            const left = st.timeUpGraceAt ? Math.max(0, Math.ceil((st.timeUpGraceAt - Date.now()) / 60000)) : null;
            rows.push(['当前状态', '⏸️ 已到时，等待房主决定'
                + (left != null ? `（约 ${left} 分钟后自动结算）` : '')]);
        }
        else if (st.paused) rows.push(['当前状态', '⏸️ 房主手动暂停']);
    } else rows.push(['当前级别', (st.currentLevel || 0) + 1]);
    const isOwner = st.ownerUserId === myUserId;
    let html = rows.map(([k, v]) => `<div class="mi-row"><span>${k}</span><b>${v}</b></div>`).join('');
    // 现金桌房主：比赛加时
    if (isCash && isOwner) {
        html += `<div class="cfg-field" style="margin-top:10px"><span class="cfg-label">UTG Straddle（下一手起生效）</span>
            <div class="tier-row"><button type="button" class="ext-btn" onclick="setUtgStraddle(${!st.allowUtgStraddle})">
            ${st.allowUtgStraddle ? '关闭 Straddle' : '开启 Straddle 2BB'}</button></div></div>`;
        // 只留加时：提前结束房主本来就有「⏸️ 暂停发牌」和「结束比赛」两个入口，
        // 再放一排「−30/−15」是重复的路径，还容易误点把桌子提前判到时。
        html += `<div class="cfg-field" style="margin-top:10px"><span class="cfg-label">比赛加时（分钟）</span>
            <div class="tier-row">` +
            [15, 30, 60, 120].map(m => `<button type="button" class="ext-btn" onclick="adjustMatchEnd(${m})">+${m}</button>`).join('') +
            `</div></div>`;
        if (st.timeExpired) html += '<div class="mi-note">⏸️ 加时即可继续；若一直无人处理，5 分钟后会自动结算收桌（筹码照常兑回金币，不会被卡住）。</div>';
    }
    if (!isOwner) html += '<div class="mi-note">仅房主可调整时间 / 结束比赛</div>';
    document.getElementById('match-info').innerHTML = html;
    document.querySelectorAll('#match-modal .owner-only').forEach(e => e.style.display = isOwner ? '' : 'none');
}
function setUtgStraddle(enabled) {
    if (!socket) return;
    socket.emit('set_utg_straddle', { enabled: enabled === true });
}
function extendMatch(minutes) {
    if (!socket) return;
    if (!confirm(L(`确定为本场比赛加时 +${minutes} 分钟？`, `Extend this game by +${minutes} minutes?`))) return;
    socket.emit('extend_match', { minutes });
    alert(`已加时 +${minutes} 分钟`);
}
function formatMatchEndTime(value) {
    return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function adjustMatchEnd(minutes) {
    if (!socket || !lastState) return;
    const now = Date.now();
    const oldEndAt = lastState.tableEndAt || now;
    const base = minutes > 0 ? Math.max(now, oldEndAt) : oldEndAt;
    const endAt = Math.max(now, base + minutes * 60000);
    const detail = `预计结束时间将从 ${formatMatchEndTime(oldEndAt)} 调整为 ${formatMatchEndTime(endAt)}。`;
    if (!confirm(`${detail}\n\n确定调整吗？`)) return;
    socket.emit('adjust_match_end', { endAt });
}
