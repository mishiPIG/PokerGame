// ===== Init =====
;['btnFold','btnCheckCall','btnBet','btnRaise','raiseAmount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
});
document.getElementById('btnSound').textContent = soundOn ? '🔊' : '🔇';
applySettings();   // 应用桌面风格 / 四色 / 自定义快捷下注
setupVoiceRecording();
window.addEventListener('pagehide', () => { cancelVoiceRecording(); stopVoicePlayback(); });
// 首次手势解锁 Web Audio；iOS Safari 从后台返回后可能会挂起它。
['pointerdown', 'touchend', 'keydown', 'click'].forEach(type => {
    window.addEventListener(type, unlockAudio, { once: true, passive: true });
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeAudio();
});
// 所有按钮点击的反馈音（卡牌等非 button 元素有各自专属音）
document.addEventListener('click', (e) => {
    if (e.target.closest('button')) sndClick();
}, true);
// 点牌桌空白处自动收起临时小窗（战绩/牌谱/聊天/菜单），不必点 ✕
document.addEventListener('click', (e) => {
    if (e.target.closest('.side-panel, #chat-panel, #avatar-popup, #table-menu, #hand-detail, #replay-overlay, .modal-mask, #profile-overlay, #inbox-panel, .edge-arrow, .tc-btn')) return;
    ['history-panel', 'stats-panel', 'chat-panel', 'table-menu'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') el.style.display = 'none';
    });
});

// 检查本地 token，自动登录
const savedToken = localStorage.getItem('token');
if (savedToken) {
    try {
        const payload = JSON.parse(atob(savedToken.split('.')[1]));
        if (payload.exp * 1000 > Date.now()) {
            myUserId   = payload.id;
            myUsername = payload.username;
            myDisplayName = payload.displayName || payload.username;
            isAdmin    = !!payload.isAdmin;
            document.getElementById('display-username').textContent = myDisplayName;
            document.getElementById('admin-toggle').style.display = isAdmin ? '' : 'none';
            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('game-section').style.display = '';
            connectSocket(savedToken);
            refreshInboxBadge();
            refreshCheckinDot();
        } else {
            localStorage.removeItem('token');
        }
    } catch {
        localStorage.removeItem('token');
    }
}

// ===== 版本信息（设置面板底部）=====
// 前端构建号来自打包进 JS 的常量；服务端版本实时拉。两者不一致 = 本机缓存了旧前端。
let _verText = '';
async function loadVersion() {
    const cEl = document.getElementById('ver-client'), sEl = document.getElementById('ver-server');
    if (!cEl || !sEl) return;
    const client = CLIENT_BUILD === '__' + 'BUILD__' ? 'dev' : CLIENT_BUILD;
    cEl.textContent = `前端 ${client}`;
    try {
        const r = await fetch('/api/version');
        const v = await r.json();
        sEl.textContent = `服务端 ${v.label}${v.env && v.env !== 'unknown' ? ' · ' + v.env : ''}`;
        // 服务端知道自己是用哪个 commit 构建的；前端常量若对不上，说明这份 JS 是旧的
        const stale = client !== 'dev' && v.commit !== 'dev' && client !== v.commit;
        document.getElementById('version-box').classList.toggle('stale', stale);
        if (stale) sEl.textContent += '  ⚠️ 前端是旧的，请下拉刷新';
        _verText = `${cEl.textContent} / ${sEl.textContent}`;
    } catch (e) { sEl.textContent = '服务端 ?'; }
}
function copyVersion() {
    if (!_verText) return;
    navigator.clipboard?.writeText(_verText).then(() => toast('已复制版本信息'), () => {});
}
loadVersion();
