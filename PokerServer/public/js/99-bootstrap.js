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

// ===== 开场画面的收场 =====
// 约束（都是「每次启动都会看到」逼出来的，别删）：
//   ①【与加载并行】：它只是个覆盖层，下面的 app 照常初始化，不是「播完才开始加载」。
//   ②【短】最多 MAX_MS 就撤，网络再慢也不会把人扣在这儿。
//   ③【可跳过】点一下立刻走。
//   ④【只在冷启动】：它写在 HTML 里，socket 重连 / 切后台回来都不会重新加载页面，天然不会重播。
//   ⑤【已登录的人不多等】：登录态确认完（bootstrap 走完）就撤，只保底一个很短的最短展示时间，
//      避免闪一下就没（那比不做还难看）。
const BOOT_MIN_MS = 450, BOOT_MAX_MS = 800;
const _bootAt = Date.now();
let _bootTimer = null, _bootDone = false;
function _bootFinish(el) {
    _bootDone = true;
    el.classList.add('gone');
    setTimeout(() => el.remove(), 400);   // 淡出结束后移除，别留个透明层挡点击
}
function dismissBootSplash(reason) {
    if (_bootDone) return;
    const el = document.getElementById('boot-splash');
    if (!el) { _bootDone = true; return; }
    // 点击 = 立刻走，并且要能【打断已经排好的最短展示】——
    // 否则 ready 一触发就锁定了，之后点它没反应，还得干等 450ms（这就等于不可跳过）。
    if (reason === 'tap') { clearTimeout(_bootTimer); _bootFinish(el); return; }
    if (_bootTimer) return;                                        // 已经排过队了
    // 正常收场至少展示 BOOT_MIN_MS，避免一闪而过（那比不做还难看）
    _bootTimer = setTimeout(() => _bootFinish(el), Math.max(0, BOOT_MIN_MS - (Date.now() - _bootAt)));
}
// 原生启动图（只有 APK 里存在）：网页首屏已经画好、且和它同色，可以立刻交接。
// 不做这一步就得干等 launchShowDuration 到点，中间那段其实网页早就准备好了。
// 浏览器里没有 Capacitor，所以要判空。
function handoffNativeSplash() {
    try { window.Capacitor?.Plugins?.SplashScreen?.hide({ fadeOutDuration: 200 }); } catch (e) {}
}
// 正常路径：应用已经初始化完（上面的 bootstrap 已同步跑完）→ 交接原生启动图 → 收场
requestAnimationFrame(() => { handoffNativeSplash(); dismissBootSplash('ready'); });
// 兜底：无论发生什么（接口卡住、报错），到点必撤
setTimeout(() => dismissBootSplash('timeout'), BOOT_MAX_MS);
