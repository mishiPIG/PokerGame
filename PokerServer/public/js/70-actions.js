function lockInput(ms) {
    inputLockUntil = Date.now() + ms;
    const ab = document.getElementById('action-bar');
    if (!ab) return;
    ab.classList.add('locked');
    clearTimeout(window._unlockT);
    window._unlockT = setTimeout(() => ab.classList.remove('locked'), ms);
}
// 主动亮牌：摊牌阶段点自己的牌亮给对手看（点哪张亮哪张）
function showMyCard(index) {
    if (!currentRoom || !socket) return;
    if (!lastState || lastState.phase !== 'showdown') return;
    if (myShown.has(index)) return;
    myShown.add(index);
    sndShow();
    socket.emit('show_card', { roomId: currentRoom, index });
    if (lastState) render(lastState);
}

// 行动倒计时：每 250ms 刷新当前行动座位的秒数（state 之间平滑递减）
setInterval(() => {
    // 行动思考倒计时（环形进度 + 秒数）
    if (lastState && lastState.actionDeadline) {
        const remain = Math.max(0, lastState.actionDeadline - Date.now());
        const secs = Math.ceil(remain / 1000);
        const low = secs <= 5;
        const el = document.getElementById('seat-timer-num');
        if (el) { el.textContent = secs; el.classList.toggle('low', low); }
        const ring = document.getElementById('seat-ring');
        if (ring) {
            const frac = lastState.actionTotalMs ? Math.max(0, remain / lastState.actionTotalMs) : 0;
            ring.style.setProperty('--p', frac);
            ring.classList.toggle('low', low);
            const seat = ring.closest('.seat');
            if (seat) seat.classList.toggle('lowtime', low);
        }
        // 我的回合剩 5s 时警告音（每回合一次）
        if (lastState.actionOnUserId === myUserId && secs <= 5 && secs > 0 && !warnedThisTurn) {
            warnedThisTurn = true; sndWarn();
        }
    }
    // SNG 距下一级别升盲倒计时
    const nl = document.getElementById('next-level');
    if (nl && nextLevelAt) {
        const rem = Math.max(0, Math.floor((nextLevelAt - Date.now()) / 1000));
        const mm = String(Math.floor(rem / 60)).padStart(2, '0');
        const ss = String(rem % 60).padStart(2, '0');
        nl.textContent = `· 距升盲 ${mm}:${ss}`;
    }
    // 现金桌训练剩余时长
    const tr = document.getElementById('table-remain');
    if (tr && tableEndAt) {
        const rem = Math.max(0, Math.floor((tableEndAt - Date.now()) / 1000));
        const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60), ss = rem % 60;
        tr.textContent = `· 剩 ${hh > 0 ? hh + 'h' : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }
}, 250);

// ===== Game actions =====
function act(action) {
    if (inputLocked()) return;
    preAction = null; updatePreBar();   // 手动行动即取消预操作
    if (currentRoom && socket) socket.emit('player_action', { roomId: currentRoom, action });
}
// 可免费过牌时，弃牌需要二次确认，避免误触；面对下注时仍可一键弃牌。
function actFold() {
    if (inputLocked() || !lastState || lastState.actionOnUserId !== myUserId) return;
    const me = lastState.players.find(p => p.userId === myUserId);
    if (!me) return;
    const canCheck = lastState.currentBet - me.currentBet <= 0;
    if (canCheck && !confirm('当前可以过牌，确定仍要弃牌吗？')) return;
    act('fold');
}
// ===== 预操作（不轮到我时提前勾选，到点自动执行）=====
let preAction = null, preCallBet = 0;
function togglePre(a) {
    preAction = (preAction === a) ? null : a;
    preCallBet = (lastState ? lastState.currentBet : 0);   // 记录选择时的注额（call 用于判断是否变化）
    updatePreBar();
}
function updatePreBar() {
    document.querySelectorAll('#preaction-bar .pa-btn').forEach(b => b.classList.toggle('sel', b.dataset.pa === preAction));
}
// 轮到我时执行预操作；「跟注」若注额被加大(raise)则自动取消，需重新点亮
function runPreAction(toCall) {
    const a = preAction;
    if (a === 'call' && lastState && lastState.currentBet !== preCallBet) { preAction = null; updatePreBar(); return; }
    preAction = null; updatePreBar();
    setTimeout(() => {
        if (!lastState || lastState.actionOnUserId !== myUserId) return;
        if (a === 'checkfold') act(toCall > 0 ? 'fold' : 'check');
        else if (a === 'call') act(toCall > 0 ? 'call' : 'check');
    }, 350);
}
// 过牌/跟注合并按钮：有未跟注则跟注，否则过牌
function actCheckCall() {
    if (inputLocked() || !lastState) return;
    const me = lastState.players.find(p => p.userId === myUserId);
    const toCall = me ? lastState.currentBet - me.currentBet : 0;
    act(toCall > 0 ? 'call' : 'check');
}
// ===== 下注尺寸：快捷一键 + 精调面板 =====
let sizeCtx = null;  // { minTo, maxTo, currentBet, myBet, totalPot } 当前可下注上下文

function clampSize(v) {
    if (!sizeCtx || isNaN(v)) return v;
    return Math.max(sizeCtx.minTo, Math.min(sizeCtx.maxTo, v));
}
// kind: 'min' | 'allin' | 'pot'(底池倍数 v) | 'bb'(大盲倍数 v) → 目标下注额
function sizeForQuick(kind, v) {
    if (!sizeCtx) return 0;
    if (kind === 'min')   return sizeCtx.minTo;
    if (kind === 'allin') return sizeCtx.maxTo;
    if (kind === 'bb')    return clampSize(Math.round(v * curBB()));   // 翻前：N 倍大盲
    const toCall = sizeCtx.currentBet - sizeCtx.myBet;                 // 翻后：底池比例
    const potAfterCall = sizeCtx.totalPot + toCall;
    return clampSize(sizeCtx.currentBet + Math.round(v * potAfterCall));
}
// 快捷比例：一键直接下注/加注
function quickBet(kind, v) {
    if (inputLocked() || !sizeCtx) return;
    sendSize(sizeForQuick(kind, v));
}
function sendSize(amount) {
    amount = clampSize(amount);
    if (inputLocked() || !sizeCtx || !amount) return;
    const action = sizeCtx.currentBet === 0 ? 'bet' : 'raise';
    socket.emit('player_action', { roomId: currentRoom, action, amount });
    document.getElementById('sizing-row').style.display = 'none';  // 收起精调面板
    document.body.classList.remove('sizing-open');
}
// 点「下注/加注」展开精调面板（滑条 + 输入框 + 确认）
function openSizing() {
    if (!sizeCtx) return;
    const row = document.getElementById('sizing-row');
    const show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    document.body.classList.toggle('sizing-open', show);   // 拖动时暂停座位呼吸光/环形重绘，手机不卡
    if (show) syncSizeInputs(sizeCtx.minTo);
}
function confirmBet() {
    sendSize(clampSize(parseInt(document.getElementById('raiseAmount').value)));
}
function syncSizeInputs(v) {
    const sl = document.getElementById('betSlider');
    sl.value = v;
    document.getElementById('raiseAmount').value = v;
    const mn = +sl.min, mx = +sl.max;
    sl.style.setProperty('--fill', (mx > mn ? Math.round((v - mn) / (mx - mn) * 100) : 0) + '%');
    updateConfirmLabel(v);
}
let _sliderRaf = 0;
function onSliderInput() {
    // rAF 合并：拖动时每帧最多更新一次 DOM，避免 input 高频触发导致手机卡顿
    if (_sliderRaf) return;
    _sliderRaf = requestAnimationFrame(() => { _sliderRaf = 0; syncSizeInputs(parseInt(document.getElementById('betSlider').value)); });
}
function onAmountInput() {
    const raw = parseInt(document.getElementById('raiseAmount').value);
    if (!isNaN(raw)) { document.getElementById('betSlider').value = clampSize(raw); updateConfirmLabel(raw); }
}
function updateConfirmLabel(v) {
    const val = clampSize(v);
    const isBet = sizeCtx && sizeCtx.currentBet === 0;
    document.getElementById('btnConfirmBet').textContent = (isBet ? '确认下注 ' : '确认加注到 ') + fmtChips(val);
}

// ===== 房间内游戏控制 =====
function toggleReady() {
    if (currentRoom && socket) socket.emit('toggle_ready', currentRoom);
}
function startGame() {
    if (socket) socket.emit('start_game');
}
let _lastAddTime = 0;
function addTime() {
    if (!currentRoom || !socket) return;
    if (Date.now() - _lastAddTime < 400) return;   // 防抖：快速连点只生效一次，避免误触/异常
    _lastAddTime = Date.now();
    socket.emit('add_time', currentRoom);
}
function rabbitDeal() {
    if (currentRoom && socket) socket.emit('rabbit_deal', currentRoom);
}
