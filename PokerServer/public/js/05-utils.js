// ===== Shared frontend utilities =====
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
// 「我是不是游客」变了：记下状态，并切换 body.is-guest ——
// 它控制两类元素：.guest-only（只给游客看）/ .member-only（游客看不到）。
function setGuest(v) { isGuest = !!v; document.body.classList.toggle('is-guest', isGuest); }
// 线条图标（图标集在 index.html 开头的 #ic-sprite）。name 只许是代码里写死的常量，不接用户输入。
function ic(name, cls) {
    // 图标名只允许小写字母和连字符：就算哪天有人误把外部数据传进来，也拼不出别的标签（不合规就什么都不输出）
    if (!/^[a-z-]+$/.test(name)) return '';
    const c = /^[a-z -]*$/.test(cls || '') ? (cls || '') : '';
    return `<svg class="ic${c ? ' ' + c : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;   // escape-ok: name / c 已按白名单字符校验
}
// 给一个按钮 / 标签换成「图标 + 文字」。文字走 textContent（玩家名之类也安全）；不给文字就只放图标。
// cls：图标颜色（c-gold / c-orange…，见 00-shell.css）—— 静态页面上加过颜色的按钮，脚本重画时要把颜色一起带上，否则会被洗掉。
function setIconLabel(el, name, text, cls) {
    if (!el) return;
    // 牌桌每来一个 game_state 都会调到这里：内容没变就别重建 DOM（省得按钮在手指底下被换掉）
    const sig = name + '|' + (cls || '') + '|' + (text == null ? '' : text);
    if (el.dataset.il === sig) return;
    el.dataset.il = sig;
    el.innerHTML = ic(name, cls) + (text == null ? '' : '<span></span>');
    if (text != null) el.lastChild.textContent = text;
}
// 分享来源（2026-11-17）：没登录的人打开过一条牌谱分享链接，7 天内在这个浏览器里建号 / 注册，就算分享带来的。
// 只是运营统计（服务端会核对这条分享是否真实存在），读写失败一律当没有。
const SHARE_REF_TTL = 7 * 24 * 3600 * 1000;
function rememberShareRef(token) {
    try { if (!localStorage.getItem('token')) localStorage.setItem('shareRef', JSON.stringify({ token, at: Date.now() })); } catch {}
}
function peekShareRef() {
    try {
        const r = JSON.parse(localStorage.getItem('shareRef') || 'null');
        return r && typeof r.token === 'string' && Date.now() - r.at < SHARE_REF_TTL ? r.token : undefined;
    } catch { return undefined; }
}
function clearShareRef() { try { localStorage.removeItem('shareRef'); } catch {} }
function hashHue(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// 当前战绩按「筹码总资产 - 累计带入」计算；下注和待生效补码仍属于玩家资产，不能提前算成亏损。
function displayNet(p) {
    return (p?.chips || 0) + (p?.currentBet || 0) + (p?.committed || 0)
        + (p?.pendingRebuy || 0) - (p?.buyIn || 0);
}
// 预设头像（打包在服务器本地 /avatars，无外网依赖；加载失败回退首字母色块）
// 头像库 b1–b27（扑克 + 道场主题）。旧的 a1–a12 已移除（玩家反映太丑），
// 引用它们的用户 avatar 已在服务端清空 → 回退成首字母色块显示。
const AVATARS = Array.from({ length: 27 }, (_, i) => `/avatars/b${i + 1}.svg`);

// ===== 应用内确认框（2026-09-13，玩家反馈「浏览器弹窗太丑」）=====
// 原来退出房间/解散/站起/加时都用浏览器的 confirm()：顶着一行「XXX 显示」，
// 手机 WebView 里样式完全不受控，观感像钓鱼弹窗；而且它是【阻塞】的，
// 弹着的时候整个页面连重绘都停了。
//
// 返回 Promise<boolean>，所以调用处从
//     if (!confirm(x)) return; 干活();
// 变成
//     uiConfirm(x).then(ok => { if (!ok) return; 干活(); });
// ⚠️ 一定要走 .then/await —— 忘了的话会变成「不管点什么都执行」，比弹窗丑严重得多。
let _confirmResolve = null;
function uiConfirm(text, { ok, cancel, danger = false } = {}) {
    const box = document.getElementById('confirm-modal');
    if (!box) return Promise.resolve(window.confirm(text));   // 兜底：元素不在就退回原生
    // 上一个还开着就又来一个（比如正问「确定离开吗」时收到牌友邀请）：
    // 先把上一个按「取消」了结。否则它的 Promise 永远不落地 ——
    // 被顶掉的若是邀请，房主那边要干等 3 分钟过期。
    if (_confirmResolve) { const prev = _confirmResolve; _confirmResolve = null; prev(false); }
    document.getElementById('confirm-text').textContent = text;
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = ok || t('btn.ok', '确定');
    okBtn.classList.toggle('danger', !!danger);
    document.getElementById('confirm-cancel').textContent = cancel || t('btn.cancel', '取消');
    box.style.display = 'flex';
    return new Promise(res => { _confirmResolve = res; });
}
function closeConfirm(result) {
    document.getElementById('confirm-modal').style.display = 'none';
    const r = _confirmResolve; _confirmResolve = null;
    if (r) r(!!result);
}

// 复制到剪贴板。【所有复制都走这一个】，别再自己写。
// 🔴 navigator.clipboard 只在【安全上下文】（https / localhost）里存在。
//    测试服是 http://10.76.x.x:3000 —— 在那里它直接是 undefined，
//    所以 `navigator.clipboard?.writeText(...)` 会静默地什么都不做：
//    没复制上、不报错、连一句提示都没有，玩家只能当成功能坏了
//    （牌友号和版本号两个按钮都中过这一枪）。
//    → 有安全上下文就用它，没有就退回 execCommand，而且【成败都给一句反馈】。
async function copyText(text, successMessage) {
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const area = document.createElement('textarea');
            area.value = text;
            // 不能 display:none，那样选不中，execCommand 会失败
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
