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
        nl.textContent = L(` · 距升盲 ${mm}:${ss}`, ` · next level ${mm}:${ss}`);   // 分隔符在这里带，模板不再写
    }
    // 现金桌训练剩余时长
    const tr = document.getElementById('table-remain');
    if (tr && tableEndAt) {
        const rem = Math.max(0, Math.floor((tableEndAt - Date.now()) / 1000));
        const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60), ss = rem % 60;
        const clock = `${hh > 0 ? hh + 'h' : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        tr.textContent = L(` · 剩 ${clock}`, ` · ${clock} left`);   // 分隔符在这里带，模板不再写
    }
}, 250);

// ===== Game actions =====
function act(action) {
    if (inputLocked()) return;
    // 弃牌保护（2026-11-17，美术第二轮 ③）：能免费过牌时点了弃牌，几乎都是按错了 —— 先问一句。
    // 「取消 / 点外面」= 什么都不做；就算一直不点，超时也是自动过牌、不会弃牌：默认结果是安全的那个。
    // 预操作「过/弃」走的是 act('check')，不会经过这里；快捷键 F 会（它模拟点按钮）。
    if (action === 'fold' && canCheckNow()) {
        uiConfirm(L('现在可以免费过牌，确定要弃牌吗？', 'You can check for free. Fold anyway?'),
            { ok: L('弃牌', 'Fold'), cancel: L('取消', 'Cancel'), danger: true }).then(yes => {
                if (!yes || !lastState || lastState.actionOnUserId !== myUserId) return;   // 等待期间已经轮不到我了
                preAction = null; updatePreBar();
                haptic();
                if (currentRoom && socket) socket.emit('player_action', { roomId: currentRoom, action: 'fold' });
            });
        return;
    }
    preAction = null; updatePreBar();   // 手动行动即取消预操作
    haptic();
    if (currentRoom && socket) socket.emit('player_action', { roomId: currentRoom, action });
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
// 现在轮到我、且不用跟注（可以过牌）
function canCheckNow() {
    if (!lastState || lastState.actionOnUserId !== myUserId) return false;
    const me = lastState.players.find(p => p.userId === myUserId);
    return !!me && lastState.currentBet - me.currentBet <= 0;
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
// 下注信息条里的「占底池 %」—— 必须是上面 sizeForQuick 的【反函数】：
// 点了「¾池」，下面就该正好显示 75%。
// ⚠️ 原来算的是 下注额 ÷ (底池 + 本次投入)：把自己这注也算进了分母，结果永远到不了 100%，
//    翻前 1.5BB 的池子全下 50BB 显示「占底池 98%」（玩家实拍，2026-09-29）。
function potPctOf(val, ctx) {
    if (!ctx) return 0;
    const potAfterCall = (ctx.totalPot || 0) + Math.max(0, (ctx.currentBet || 0) - (ctx.myBet || 0));
    return potAfterCall > 0 ? Math.round((val - (ctx.currentBet || 0)) / potAfterCall * 100) : 0;
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
    haptic();
    socket.emit('player_action', { roomId: currentRoom, action, amount });
    document.getElementById('sizing-row').style.display = 'none';  // 收起精调面板
    document.body.classList.remove('sizing-open');
    hideKeypad();
}
// 点「下注/加注」展开精调面板（滑条 + 输入框 + 确认）
function openSizing() {
    // 无效加注：前方短码全押不足一个完整加注 → 行动未重开，我只能跟/弃。
    // 给出可见提示（server_msg 只进 console，玩家看不到，会以为按钮坏了）
    if (lastState && lastState.raiseClosed) {
        toast(L('⚠️ 前方是无效加注（全押不足一个完整加注），本轮不能再加注，只能跟注或弃牌', '⚠️ That was an invalid raise (all-in under a full raise) — this round you can only call or fold'), 3200);
        return;
    }
    if (!sizeCtx) return;
    const row = document.getElementById('sizing-row');
    const show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    document.body.classList.toggle('sizing-open', show);   // 拖动时暂停座位呼吸光/环形重绘，手机不卡
    if (show) { setupAmountInput(); syncSizeInputs(sizeCtx.minTo); }
    hideKeypad();
}
// ===== 手机上的数字键盘（玩家视角复盘 P5）=====
// 手机上拖滑条很难停在想要的数上；系统软键盘又会把整个牌桌顶起来（视口变矮 → 座位全部重排），
// 还挡住大半个牌桌。所以触屏设备上金额框改成只读，点它弹出面板里自带的键盘。
// 电脑（有鼠标/键盘）照旧直接在框里打字，不弹这个键盘。
// 按下行动按钮时轻振一下（2026-11-17，美术第二轮 ⑤）：手指要立刻知道「按到了」。
// 只在触屏上振；开关沿用 vibrate() 里的那个（跟着音效开关走）。数字键盘每个键更轻一点。
function haptic(ms = 12) {
    if (touchInput() && typeof vibrate === 'function') vibrate(ms);
}
// 手机下注滑条（2026-11-17，美术第二轮 ⑤）：原生滑条在手机上要手指正好按中圆钮才拖得动、还会跳。
// 改成按住滑条上【任何位置】都能拖：按下就跳到手指那里，之后跟手走。电脑鼠标照旧用原生行为。
// 值仍写回 #betSlider、走 onSliderInput → syncSizeInputs，金额框 / 确认按钮 / 下注信息条全部不用改。
function sliderValueAt(sl, clientX) {
    const r = sl.getBoundingClientRect();
    const thumb = 32;                                  // 和 20-table.css 里圆钮的宽度一致：两端各留半个圆钮
    const ratio = Math.max(0, Math.min(1, (clientX - r.left - thumb / 2) / Math.max(1, r.width - thumb)));
    const mn = +sl.min, mx = +sl.max, step = +sl.step || 1;
    const raw = mn + ratio * (mx - mn);
    return ratio >= 1 ? mx : Math.min(mx, mn + Math.round((raw - mn) / step) * step);   // 拖到头一定是全下
}
function setupSliderDrag() {
    const sl = document.getElementById('betSlider');
    if (!sl || !sl.addEventListener || !sl.dataset || sl.dataset.drag) return;
    sl.dataset.drag = '1';
    const move = (e) => { sl.value = sliderValueAt(sl, e.clientX); onSliderInput(); };
    sl.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;          // 电脑：原生滑条本来就好用
        e.preventDefault();
        try { sl.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器：照样能拖，只是手指滑出滑条就停 */ }
        move(e);
        haptic(6);
        const up = () => { sl.removeEventListener('pointermove', move); sl.removeEventListener('pointerup', up); sl.removeEventListener('pointercancel', up); };
        sl.addEventListener('pointermove', move);
        sl.addEventListener('pointerup', up);
        sl.addEventListener('pointercancel', up);
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupSliderDrag); else setupSliderDrag();
function touchInput() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
function setupAmountInput() {
    const inp = document.getElementById('raiseAmount');
    if (!inp) return;
    const touch = touchInput();
    inp.readOnly = touch;                                    // 只读 = 不弹系统键盘
    inp.setAttribute('inputmode', touch ? 'none' : 'numeric');
}
let kpFresh = true;   // 键盘刚弹出时，按第一个数字是【替换】预填的金额，而不是接在它后面
function toggleKeypad() {
    if (!touchInput()) return;
    const kp = document.getElementById('bet-keypad');
    if (!kp) return;
    const show = kp.style.display === 'none';
    kp.style.display = show ? '' : 'none';
    document.getElementById('raiseAmount').classList.toggle('kp-on', show);
    // 键盘开着时面板底色变半透明：哪怕压到一点公共牌 / 座位，底下的牌也透得出来（验收时玩家反馈「挡住牌面」）
    const row = document.getElementById('sizing-row');
    if (row) row.classList.toggle('kp-open', show);
    kpFresh = true;
}
function hideKeypad() {
    const kp = document.getElementById('bet-keypad');
    if (kp) kp.style.display = 'none';
    const inp = document.getElementById('raiseAmount');
    if (inp) inp.classList.remove('kp-on');
    const row = document.getElementById('sizing-row');
    if (row) row.classList.remove('kp-open');
}
function keypadPress(k) {
    haptic(6);
    const inp = document.getElementById('raiseAmount');
    let s = kpFresh ? '' : String(inp.value || '');
    kpFresh = false;
    if (k === 'del') s = s.slice(0, -1);
    else {
        s = (s + k).replace(/^0+(?=\d)/, '');   // 不留前导 0
        if (s.length > 9) return;                // 再长就没有意义了（确认时反正会夹到全下额）
    }
    inp.value = s;
    onAmountInput();
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
    if (isNaN(raw)) return;
    // 滑条跟着走（含绿色进度条），确认按钮显示【实际会下的】数：超过全下额按全下、不到最小加注按最小加注
    const sl = document.getElementById('betSlider');
    const v = clampSize(raw);
    sl.value = v;
    const mn = +sl.min, mx = +sl.max;
    sl.style.setProperty('--fill', (mx > mn ? Math.round((v - mn) / (mx - mn) * 100) : 0) + '%');
    updateConfirmLabel(raw);
}
function updateConfirmLabel(v) {
    const val = clampSize(v);
    const isBet = sizeCtx && sizeCtx.currentBet === 0;
    document.getElementById('btnConfirmBet').textContent = (isBet ? t('act.confirmBet') : t('act.confirmRaise')) + fmtChips(val);
    updateBetInfo(val);
}
// 下注辅助信息：这一手压下去之后我还剩多少、相当于多大底池、对手要跟多少。
// 目的是把「代价」摆在眼前，不用自己心算（尤其手机上）。
function updateBetInfo(val) {
    const el = document.getElementById('bet-info');
    if (!el) return;
    if (!sizeCtx) { el.textContent = ''; return; }
    const me = lastState && (lastState.players || []).find(p => p.userId === myUserId);
    if (!me) { el.textContent = ''; return; }
    const addNow = Math.max(0, val - (sizeCtx.myBet || 0));      // 本次还要再投入多少
    const left = Math.max(0, me.chips - addNow);                  // 压完之后我还剩
    const pct = potPctOf(val, sizeCtx);
    const toCallOpp = Math.max(0, val - (sizeCtx.currentBet || 0));  // 对手需要跟的增量
    const allIn = left === 0;
    el.innerHTML = allIn
        ? L(`<span class="bi-allin">全下</span> · 占底池 ${pct}% · 对手需跟 ${fmtChips(toCallOpp)}`,
            `<span class="bi-allin">All-in</span> · ${pct}% of pot · they call ${fmtChips(toCallOpp)}`)
        : L(`剩余 <b>${fmtChips(left)}</b> · 占底池 ${pct}% · 对手需跟 ${fmtChips(toCallOpp)}`,
            `<b>${fmtChips(left)}</b> behind · ${pct}% of pot · they call ${fmtChips(toCallOpp)}`);
}

// ===== 房间内游戏控制 =====
function toggleReady() {
    if (currentRoom && socket) socket.emit('toggle_ready', currentRoom);
}
let _lastStart = 0;
function startGame() {
    if (!socket) return;
    // 防连点：房主狂点「开始」会反复触发高牌定庄（定庄动画那 2.8s 内 status 仍是 waiting）。
    // 服务端已有 game.beginning 守卫兜底，这里再挡一层并立即置灰按钮，给出即时反馈。
    if (Date.now() - _lastStart < 3000) return;
    _lastStart = Date.now();
    const btn = document.getElementById('btnStart');
    if (btn) { btn.disabled = true; setTimeout(() => { btn.disabled = false; }, 3000); }
    socket.emit('start_game');
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
