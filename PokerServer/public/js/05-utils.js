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
