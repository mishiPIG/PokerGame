// ===== 键盘快捷键（可自定义绑定）=====
//
// 🔴 核心设计：快捷键【不自己判断能不能做】，而是模拟点击对应的按钮。
//    按钮不可见 / 被禁用时，快捷键就什么也不做。
//    这样快捷键永远不可能绕过任何规则校验（无效加注、不是你的回合、筹码不足…），
//    也不需要跟着服务端规则同步维护第二套判断逻辑。
//
// 四条安全边界：
//    ① 光标在输入框 / 文本域 / 可编辑区里 → 完全不拦（否则聊天打字会误触发弃牌）
//    ② 按住 Ctrl / Alt / Meta → 完全不拦（不抢浏览器快捷键，如 Ctrl+R 刷新）
//    ③ 不在牌桌里 → 完全不拦
//    ④ 任何浮层开着（聊天/设置/买入/牌谱/点头像…）→ 完全不拦

const HOTKEY_DEFS = [
    { id: 'fold',    def: 'f',     btns: ['btnFold'],                zh: '弃牌',        en: 'Fold' },
    { id: 'check',   def: 'c',     btns: ['btnCheckCall'],           zh: '过牌 / 跟注',  en: 'Check / Call' },
    { id: 'raise',   def: 'r',     btns: ['btnRaise', 'btnBet'],     zh: '下注 / 加注',  en: 'Bet / Raise' },
    { id: 'allin',   def: 'a',     btns: [],                         zh: '全下',        en: 'All-in' },
    { id: 'confirm', def: 'Enter', btns: ['btnConfirmBet'],          zh: '确认下注',     en: 'Confirm bet' },
    { id: 'ready',   def: ' ',     btns: ['btnReady', 'btnStart'],   zh: '准备 / 开始',  en: 'Ready / Start' },
];
const HOTKEY_LS = 'pokerdojo.hotkeys';
const WHEEL_LS  = 'pokerdojo.wheelStep';
const WHEEL_STEPS = [0.5, 1, 2, 5];   // 单位 BB
let wheelStep = 1;
let hotkeyBindings = {};
let hotkeyCapturing = null;   // 正在录制哪个动作的新按键

function loadHotkeys() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(HOTKEY_LS) || '{}') || {}; } catch (e) { saved = {}; }
    hotkeyBindings = {};
    HOTKEY_DEFS.forEach(d => { hotkeyBindings[d.id] = (typeof saved[d.id] === 'string') ? saved[d.id] : d.def; });
}
function saveHotkeys() {
    try { localStorage.setItem(HOTKEY_LS, JSON.stringify(hotkeyBindings)); } catch (e) { /* 隐私模式下写不进，忽略 */ }
}
// 按键的显示名：空格/回车这类不可见键要给个看得懂的名字
function hotkeyLabel(k) {
    if (k === ' ') return L('空格', 'Space');
    if (k === 'Enter') return L('回车', 'Enter');
    if (!k) return L('未绑定', 'None');
    return k.length === 1 ? k.toUpperCase() : k;
}
// 事件里拿到的键统一成绑定用的形式（字母一律小写，方便大小写都能触发）
function hotkeyOf(e) {
    const k = e.key;
    return (k && k.length === 1) ? k.toLowerCase() : k;
}
// 该动作当前可用吗 = 它的按钮是否真的可点
function hotkeyButton(def) {
    for (const id of def.btns) {
        const el = document.getElementById(id);
        if (el && el.offsetParent !== null && !el.disabled) return el;
    }
    return null;
}
function runHotkey(def) {
    if (def.id === 'allin') {
        // 全下没有独立按钮：借用「下注/加注」按钮的可用性判断能不能全下，
        // 然后直接调 quickBet('allin') —— 那正是快捷池比例按钮走的同一条路径
        // （里面已含 inputLocked() 守卫），不自己拼 sendSize + 算额度。
        // ⚠️ 2026-09-09 修：这里原来写的是 sizeFor（不存在），真实函数叫 sizeForQuick，
        //    typeof 判断不过 → 全下静默失效。而测试自己 stub 了一个 sizeFor 所以是绿的。
        const gate = hotkeyButton(HOTKEY_DEFS.find(d => d.id === 'raise'));
        // ⚠️ sizeCtx 是 70-actions.js 里的 let 声明——脚本全局可按名字访问，但【不在 window 上】，
        //    所以只能用 typeof 判断，不能写 window.sizeCtx（那永远是 undefined）。
        if (!gate || typeof sizeCtx === 'undefined' || !sizeCtx) return false;
        if (typeof quickBet !== 'function') return false;
        quickBet('allin');
        return true;
    }
    const btn = hotkeyButton(def);
    if (!btn) return false;
    btn.click();
    return true;
}
// 盖在牌桌上的浮层：只要有一个开着，就说明玩家此刻在跟【那个面板】打交道，不是在行动。
// 玩家实测反馈：点开聊天框但还没点进输入框时，按 f 居然把牌弃了。
// 光判断「焦点在不在输入框」不够——面板开着但焦点还在 body 上是很常见的状态。
//
// ⚠️ 用【类选择器】而不是逐个列 id：新加的弹窗只要沿用 .modal-mask / .c-overlay /
//    .side-panel 这几个现成外壳，就自动被覆盖，不会漏。
// ⚠️ 不能用 offsetParent 判可见 —— 这些浮层都是 position:fixed，offsetParent 恒为 null。
//    getClientRects().length 对 fixed 元素才是对的。
const BLOCKING_PANELS = ['.modal-mask', '.c-overlay', '.side-panel', '#chat-panel', '#table-menu',
    '#settings-overlay', '#profile-overlay', '#avatar-popup', '#replay-overlay', '#hand-detail', '#admin-panel'];
function anyPanelOpen() {
    for (const sel of BLOCKING_PANELS) {
        for (const el of document.querySelectorAll(sel)) {
            if (el.getClientRects().length > 0) return true;
        }
    }
    return false;
}

function onHotkeyDown(e) {
    if (hotkeyCapturing) return;                                  // 录制模式由输入框自己处理
    if (e.ctrlKey || e.altKey || e.metaKey) return;               // ② 不抢浏览器快捷键
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;  // ①
    if (!document.body.classList.contains('in-room')) return;      // ③
    const key = hotkeyOf(e);
    const def = HOTKEY_DEFS.find(d => hotkeyBindings[d.id] === key);
    if (!def) return;
    if (anyPanelOpen()) return;   // ④ 有浮层开着 → 玩家在跟那个面板打交道（查询放在匹配之后，避免每次按键都遍历 DOM）
    if (runHotkey(def)) e.preventDefault();                        // 只有真执行了才吞掉这次按键
}

// ===== 设置面板里的绑定 UI =====
function renderHotkeySettings() {
    renderWheelStep();
    const box = document.getElementById('hotkey-list');
    if (!box) return;
    box.innerHTML = HOTKEY_DEFS.map(d => {
        const dup = HOTKEY_DEFS.some(o => o.id !== d.id && hotkeyBindings[o.id] === hotkeyBindings[d.id]);
        return `<div class="hk-row${dup ? ' conflict' : ''}">
            <span class="hk-name">${L(d.zh, d.en)}</span>
            <button class="hk-key" onclick="captureHotkey('${d.id}')">${escapeHtml(hotkeyLabel(hotkeyBindings[d.id]))}</button>
        </div>`;
    }).join('');
}
function captureHotkey(id) {
    hotkeyCapturing = id;
    renderHotkeyCapturing(id);
    const grab = e => {
        e.preventDefault(); e.stopPropagation();
        window.removeEventListener('keydown', grab, true);
        hotkeyCapturing = null;
        if (e.key === 'Escape') { renderHotkeySettings(); return; }          // Esc = 放弃录制
        const key = hotkeyOf(e);
        // 冲突：把占用它的那个动作解绑，而不是拒绝——用户的意图很明确，别让他猜
        HOTKEY_DEFS.forEach(d => { if (d.id !== id && hotkeyBindings[d.id] === key) hotkeyBindings[d.id] = ''; });
        hotkeyBindings[id] = key;
        saveHotkeys();
        renderHotkeySettings();
    };
    window.addEventListener('keydown', grab, true);
}
function renderHotkeyCapturing(id) {
    const box = document.getElementById('hotkey-list');
    if (!box) return;
    box.innerHTML = HOTKEY_DEFS.map(d => `<div class="hk-row${d.id === id ? ' capturing' : ''}">
        <span class="hk-name">${L(d.zh, d.en)}</span>
        <button class="hk-key">${d.id === id ? L('按下新键… (Esc 取消)', 'Press a key… (Esc to cancel)') : escapeHtml(hotkeyLabel(hotkeyBindings[d.id]))}</button>
    </div>`).join('');
}
function resetHotkeys() {
    HOTKEY_DEFS.forEach(d => { hotkeyBindings[d.id] = d.def; });
    saveHotkeys();
    renderHotkeySettings();
}

function loadWheelStep() {
    let v = NaN;
    try { v = parseFloat(localStorage.getItem(WHEEL_LS)); } catch (e) {}
    wheelStep = WHEEL_STEPS.includes(v) ? v : 1;
}
function setWheelStep(v) {
    wheelStep = v;
    try { localStorage.setItem(WHEEL_LS, String(v)); } catch (e) {}
    renderWheelStep();
}
function renderWheelStep() {
    const box = document.getElementById('wheel-step-opts');
    if (!box) return;
    box.innerHTML = WHEEL_STEPS.map(v =>
        `<button class="hk-step${v === wheelStep ? ' active' : ''}" onclick="setWheelStep(${v})">${v}BB</button>`).join('');
}

loadHotkeys();
loadWheelStep();
window.addEventListener('keydown', onHotkeyDown);

// ===== 下注面板：滚轮调额 =====
// 键盘流程是 R 打开 → 调额 → Enter 确认。中间那步原来只能拖滑条/输入数字，
// 手要离开键盘去精确对准滑条，很别扭。滚轮补上这一环。
//
// 边界：只在下注面板真的展开时生效（body.sizing-open，70-actions.js 里本就有这个 class）；
// 光标在聊天/侧栏/弹窗这类【自己能滚动】的区域内时不抢——否则会滚不动那些面板。
function onSizingWheel(e) {
    if (!document.body.classList.contains('sizing-open')) return;
    if (typeof sizeCtx === 'undefined' || !sizeCtx) return;
    if (anyPanelOpen()) return;   // 和快捷键同一条判断：浮层开着时不抢滚轮（那些面板自己要滚）
    const input = document.getElementById('raiseAmount');
    if (!input) return;
    // 步长按大盲算，玩家的心理单位就是 BB；按住 Shift 一次跳 10BB
    const bb = (typeof curBB === 'function' && curBB()) || 20;
    // 步长可在设置里选 0.5 / 1 / 2 / 5 BB；按住 Shift 一次跳 10 倍。
    // 0.5BB 会算出小数筹码，取整后再交给 clampSize（服务端也会再 clamp 一次）。
    const step = Math.max(1, Math.round(bb * wheelStep * (e.shiftKey ? 10 : 1)));
    const cur = parseInt(input.value) || sizeCtx.minTo;
    const next = clampSize(cur + (e.deltaY < 0 ? step : -step));   // 上滚加注，下滚减
    if (next !== cur) syncSizeInputs(next);
    e.preventDefault();                                            // 别让页面跟着滚
}
window.addEventListener('wheel', onSizingWheel, { passive: false });
