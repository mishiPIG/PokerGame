// ===== Init =====
;['btnFold','btnCheckCall','btnBet','btnRaise','raiseAmount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
});
document.getElementById('btnSound').textContent = soundOn ? '🔊' : '🔇';
applySettings();   // 应用桌面风格 / 四色 / 自定义快捷下注
setupVoiceRecording();
window.addEventListener('pagehide', () => { cancelVoiceRecording(); stopVoicePlayback(); });
// 首次交互解锁 Web Audio（浏览器自动播放策略）
window.addEventListener('click', () => ac(), { once: true });
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
            isAdmin    = !!payload.isAdmin;
            document.getElementById('display-username').textContent = myUsername;
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
