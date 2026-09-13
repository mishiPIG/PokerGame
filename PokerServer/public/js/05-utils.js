// ===== Shared frontend utilities =====
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
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
