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
// （原来这里还有一套「点牌桌空白收起战绩/牌谱/聊天/菜单」的独立实现，
//   已并入下方的 DISMISSIBLE 统一机制 —— 两套并存迟早漂移成不一致。）

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
            if (typeof renderMeHead === 'function') renderMeHead();
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
let _verInfo = null;                 // 服务端那份只拉一次，之后切语言直接重渲染
async function loadVersion() {
    try { _verInfo = await (await fetch('/api/version')).json(); }
    catch (e) { _verInfo = null; }
    renderVersion();
}
function renderVersion() {
    const cEl = document.getElementById('ver-client'), sEl = document.getElementById('ver-server');
    if (!cEl || !sEl) return;
    const client = CLIENT_BUILD === '__' + 'BUILD__' ? 'dev' : CLIENT_BUILD;
    cEl.textContent = `${L('前端', 'Client')} ${client}`;
    if (!_verInfo) { sEl.textContent = L('服务端 ?', 'Server ?'); return; }
    const v = _verInfo;
    sEl.textContent = `${L('服务端', 'Server')} ${v.label}${v.env && v.env !== 'unknown' ? ' · ' + v.env : ''}`;
    // 服务端知道自己是用哪个 commit 构建的；前端常量若对不上，说明这份 JS 是旧的
    const stale = client !== 'dev' && v.commit !== 'dev' && client !== v.commit;
    document.getElementById('version-box').classList.toggle('stale', stale);
    if (stale) sEl.textContent += L('  ⚠️ 前端是旧的，请下拉刷新', '  ⚠️ Client is stale — pull to refresh');
    _verText = `${cEl.textContent} / ${sEl.textContent}`;
}
// 🔴 这两个元素的文本【由 JS 拥有】，绝不能在 HTML 上挂 data-i18n ——
//    applyLang() 会 el.textContent = 字典值，把刚填好的版本号覆盖回占位符「前端 …」。
//    实拍过一次：服务端那半截是填好的、前端那半截永远是「…」，因为它先被填、后被覆盖。
//    （check-i18n.js 现在会拦这一类：JS 写的元素不许挂 data-i18n。）
onLangChange(() => renderVersion());
function copyVersion() {
    if (!_verText) return;
    navigator.clipboard?.writeText(_verText).then(() => toast(L('已复制版本信息', 'Version info copied')), () => {});
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
// 时长怎么定：入场动画本身约 1.0s（logo .78s / 副标题 .44s 延迟 + .55s），
// 要让它【走完再停一拍】才不显仓促 —— 原来 450ms 就开始淡出，动画还没做完就走了。
// 但也别贪长：薄壳每次启动都会看到它，超过 ~1.5s 就从「有仪式感」变成「等它」。
// 淡出 .42s 不计入最短展示，所以实际观感约 1.2s + 淡出。
const BOOT_MIN_MS = 1150, BOOT_MAX_MS = 1600;
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

// ===== 浮层统一的关闭方式（2026-09-13，玩家反馈）=====
// 原来是各写各的：邀请/签到/反馈/头像弹层写了内联 onclick 判 event.target===this，
// 而战绩、牌谱、收件箱、个人主页、设置、回放、买入…都只能点 ✕。
// 玩家的预期是一致的——**点旁边空白处就该关掉**。
// 一处登记 + 一个文档级监听，加新面板时不用再记得补那句内联 onclick。
//
// 两种浮层都要覆盖：
//   · 满屏遮罩型（.modal-mask / .c-overlay / #profile-overlay …）——点遮罩关
//   · 侧边抽屉型（.side-panel，左侧滑出、【没有】遮罩）——点页面其它任何地方关
// 统一判据：点击落点不在这个面板的内容盒子里 → 关。
const DISMISSIBLE = [
    { id: 'chat-panel',       close: 'toggleChat' },
    { id: 'table-menu',       close: 'toggleTableMenu' },
    { id: 'confirm-modal',    close: 'closeConfirm' },     // 点外面 = 取消（closeConfirm() 不传参就是 false）
    { id: 'note-modal',       close: 'closeNoteModal' },
    { id: 'buyin-modal',      close: 'closeBuyin' },
    { id: 'match-modal',      close: 'closeMatchSettings' },
    { id: 'invite-modal',     close: 'closeInvite' },
    { id: 'stats-panel',      close: 'closeStats' },
    { id: 'history-panel',    close: 'closeHistory' },
    { id: 'friends-panel',    close: 'closeFriends' },
    { id: 'inbox-panel',      close: 'closeInbox' },
    { id: 'checkin-overlay',  close: 'closeCheckin' },
    { id: 'feedback-overlay', close: 'closeFeedback' },
    { id: 'profile-overlay',  close: 'closeProfile' },
    { id: 'settings-overlay', close: 'closeSettings' },
    { id: 'avatar-popup',     close: 'closeAvatarPopup' },
    { id: 'hand-detail',      close: 'closeHandDetail' },
    { id: 'replay-overlay',   close: 'closeReplay' },
];
// 聊天抽屉也在里面：原来那套独立实现本来就会在点牌桌时收起它，
// 删掉旧机制后必须接上，否则等于悄悄改了既有行为。

function panelIsOpen(el) { return !!el && el.style.display !== 'none' && el.getClientRects().length > 0; }

// ⚠️ 必须记住「这次点击【按下时】哪些面板是开着的」：
//    否则打开面板的那一下点击自己会冒泡到 document，刚开就被关掉。
//    pointerdown 早于 click，那时新面板还没打开，天然不会被算进来。
let _openAtPress = new Set();
document.addEventListener('pointerdown', () => {
    _openAtPress = new Set(DISMISSIBLE
        .filter(p => panelIsOpen(document.getElementById(p.id)))
        .map(p => p.id));
}, true);

document.addEventListener('click', (e) => {
    // 这一下点在【任何】一个开着的浮层内容里 → 什么都不关。
    // 否则「聊天开着、再开买入弹窗、在弹窗里点一下」会把后面的聊天一起收掉。
    // （满屏遮罩型点到遮罩本身不算「在内容里」，所以仍会关。）
    const inside = DISMISSIBLE.some(p => {
        const el = document.getElementById(p.id);
        return panelIsOpen(el) && el.contains(e.target) && e.target !== el;
    });
    if (inside) return;

    let closed = false;
    for (const p of DISMISSIBLE) {
        if (!_openAtPress.has(p.id)) continue;          // 这一下点击之前它就没开着
        const el = document.getElementById(p.id);
        if (!panelIsOpen(el)) continue;                  // 期间已经被别的方式关了
        try { window[p.close]?.(); closed = true; } catch (err) { console.warn('[ui] 关闭面板失败', p.id, err); }
    }
    // 🔴 这一下点击的用途就是「把浮层关掉」，不能再穿透下去。
    //    侧边抽屉只占屏幕左边一条，右边露出来的正是「我的」页那排条目 ——
    //    不拦的话点一下会【关掉当前面板 + 顺手打开另一个】（玩家实拍）。
    //    所以必须在【捕获阶段】处理：要赶在下面那个按钮自己的 onclick 之前。
    if (closed) { e.stopPropagation(); e.preventDefault(); }
}, true);

// Esc 关掉最上面那个（浮层是按登记顺序由低到高的，所以倒着找）
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (let i = DISMISSIBLE.length - 1; i >= 0; i--) {
        const p = DISMISSIBLE[i];
        const el = document.getElementById(p.id);
        if (!panelIsOpen(el)) continue;
        e.preventDefault();
        try { window[p.close]?.(); } catch (err) { console.warn('[ui] 关闭面板失败', p.id, err); }
        return;                                          // 一次只关一层
    }
});
