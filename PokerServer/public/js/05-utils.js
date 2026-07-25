// ===== Shared frontend utilities =====
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function hashHue(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// 预设头像（打包在服务器本地 /avatars，无外网依赖；加载失败回退首字母色块）
const AVATARS = Array.from({ length: 12 }, (_, i) => `/avatars/a${i + 1}.svg`);

