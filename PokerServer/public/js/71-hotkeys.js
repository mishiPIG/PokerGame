// ===== 键盘快捷键（可自定义绑定）=====
//
// 🔴 核心设计：快捷键【不自己判断能不能做】，而是模拟点击对应的按钮。
//    按钮不可见 / 被禁用时，快捷键就什么也不做。
//    这样快捷键永远不可能绕过任何规则校验（无效加注、不是你的回合、筹码不足…），
//    也不需要跟着服务端规则同步维护第二套判断逻辑。
//
// 三条安全边界：
//    ① 光标在输入框 / 文本域 / 可编辑区里 → 完全不拦（否则聊天打字会误触发弃牌）
//    ② 按住 Ctrl / Alt / Meta → 完全不拦（不抢浏览器快捷键，如 Ctrl+R 刷新）
//    ③ 不在牌桌里 → 完全不拦

const HOTKEY_DEFS = [
    { id: 'fold',    def: 'f',     btns: ['btnFold'],                zh: '弃牌',        en: 'Fold' },
    { id: 'check',   def: 'c',     btns: ['btnCheckCall'],           zh: '过牌 / 跟注',  en: 'Check / Call' },
    { id: 'raise',   def: 'r',     btns: ['btnRaise', 'btnBet'],     zh: '下注 / 加注',  en: 'Bet / Raise' },
    { id: 'allin',   def: 'a',     btns: [],                         zh: '全下',        en: 'All-in' },
    { id: 'confirm', def: 'Enter', btns: ['btnConfirmBet'],          zh: '确认下注',     en: 'Confirm bet' },
    { id: 'ready',   def: ' ',     btns: ['btnReady', 'btnStart'],   zh: '准备 / 开始',  en: 'Ready / Start' },
];
const HOTKEY_LS = 'pokerdojo.hotkeys';
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
        // 全下没有独立按钮：借用「下注/加注」按钮的可用性来判断能不能全下，
        // 额度仍走和快捷池比例按钮同一条路径（sizeFor/sendSize），不另算一套。
        const gate = hotkeyButton(HOTKEY_DEFS.find(d => d.id === 'raise'));
        // ⚠️ sizeCtx 是 70-actions.js 里的 let 声明——脚本全局可按名字访问，但【不在 window 上】，
        //    所以只能用 typeof 判断，不能写 window.sizeCtx（那永远是 undefined）。
        if (!gate || typeof sizeCtx === 'undefined' || !sizeCtx) return false;
        if (typeof sendSize !== 'function' || typeof sizeFor !== 'function') return false;
        sendSize(sizeFor('allin'));
        return true;
    }
    const btn = hotkeyButton(def);
    if (!btn) return false;
    btn.click();
    return true;
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
    if (runHotkey(def)) e.preventDefault();                        // 只有真执行了才吞掉这次按键
}

// ===== 设置面板里的绑定 UI =====
function renderHotkeySettings() {
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

loadHotkeys();
window.addEventListener('keydown', onHotkeyDown);
