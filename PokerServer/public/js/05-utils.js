// ===== Shared frontend utilities =====
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function hashHue(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// 预设头像（打包在服务器本地 /avatars，无外网依赖；加载失败回退首字母色块）
// 新版头像 b1–b16（扑克 + 道场主题）排在前面；旧版 a1–a12 保留在后
// —— 老用户的 avatar 字段存的就是 /avatars/aN.svg，删掉会让他们头像变裂图。
const AVATARS = [
    ...Array.from({ length: 16 }, (_, i) => `/avatars/b${i + 1}.svg`),
    ...Array.from({ length: 12 }, (_, i) => `/avatars/a${i + 1}.svg`)
];

