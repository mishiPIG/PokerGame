// ===== Init =====
;['btnFold','btnCheckCall','btnBet','btnRaise','raiseAmount'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
});
setIconLabel(document.getElementById('btnSound'), soundOn ? 'sound' : 'mute');
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
            setGuest(payload.isGuest);
            if (typeof renderMeHead === 'function') renderMeHead();
            document.getElementById('admin-toggle').style.display = isAdmin ? '' : 'none';
            document.getElementById('auth-overlay').style.display = 'none';
            document.getElementById('game-section').style.display = '';
            connectSocket(savedToken);
            refreshInboxBadge();
            refreshCheckinDot();
            // 上次打完直接关了页面的游客：这次打开停在大厅时提醒一次保存账号。
            // 要回牌桌 / 是点邀请链接进来的就不打扰（那两种情况马上要进桌）。
            if (!localStorage.getItem('currentRoom') && !pendingInviteToken) setTimeout(maybeNudgeGuest, 4000);
        } else {
            localStorage.removeItem('token');
        }
    } catch {
        localStorage.removeItem('token');
    }
}

initGuestEntry();   // 登录页的游客入口：预填随机昵称；是点邀请链接来的就说明一句
if (pendingSharedHand) openSharedHand(pendingSharedHand);   // 点分享链接进来：直接放那一手的回放

// 在【已经开着游戏】的标签页里再粘贴一条分享 / 邀请链接：只有 # 后面那段变了，页面不会重新加载，
// 上面那两处「加载时读一次地址栏」就都错过了 —— 表现是粘贴回车之后什么都不发生（验收时玩家实报）。
// 这里自己接住 hashchange。
window.addEventListener('hashchange', () => {
    const h = location.hash.match(/^#\/hand\/([A-Za-z0-9_-]{8,64})$/);
    if (h) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch {}
        openSharedHand(h[1]);
        return;
    }
    if (!location.hash.startsWith('#/join/')) return;
    capturePendingInvite();                       // 记下 token 并清掉地址栏（和加载时同一套）
    if (!pendingInviteToken) return;
    if (socket && socket.connected) {
        showLobby();                              // 同连上服务器时那条路径：邀请优先，先回大厅再进新桌
        socket.emit('join_by_invite', { token: pendingInviteToken });
    } else {
        initGuestEntry();                         // 还没登录：登录页上那句「朋友邀请你…」要亮出来，登录后自动进桌
    }
});

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
    showUpdateBar(stale);
}
// 「有新版本，点这里刷新」：顶部一条，点了才刷新（牌局中途不替玩家做主；刷新后会自动回到这张桌）。
// 为什么需要它：发版时服务器重启，页面只是【断线重连】，不会重新加载 —— 手里还是旧脚本、旧样式，
// 一直打到关掉页面为止。原来只在「我的」页最底下那行小字里提醒，没人会去看（2026-11-17 验收时实拍：
// 测了半天的数字键盘其实是旧版）。APK 薄壳同理：切到后台再回来，页面也不重新加载。
function showUpdateBar(show) {
    let bar = document.getElementById('update-bar');
    if (!show) { if (bar) bar.remove(); return; }
    if (bar) return;
    bar = document.createElement('button');
    bar.id = 'update-bar';
    bar.type = 'button';
    setIconLabel(bar, 'refresh', L('有新版本 · 点这里刷新', 'New version ready · tap to reload'));
    bar.onclick = () => location.reload();
    document.body.appendChild(bar);
}
// 断线重连（多半是发版重启）和从后台切回来时，各再比一次版本
let _verCheckedAt = 0;
function recheckVersion() {
    if (Date.now() - _verCheckedAt < 30000) return;   // 别每次切回来都打一遍接口
    _verCheckedAt = Date.now();
    loadVersion();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckVersion(); });
// 🔴 这两个元素的文本【由 JS 拥有】，绝不能在 HTML 上挂 data-i18n ——
//    applyLang() 会 el.textContent = 字典值，把刚填好的版本号覆盖回占位符「前端 …」。
//    实拍过一次：服务端那半截是填好的、前端那半截永远是「…」，因为它先被填、后被覆盖。
//    （check-i18n.js 现在会拦这一类：JS 写的元素不许挂 data-i18n。）
onLangChange(() => renderVersion());
function copyVersion() {
    copyText(_verText, L('已复制版本信息', 'Version info copied'));
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
    // passThrough：点在这些区域里【不算】点外面 —— 聊天开着也能直接按行动按钮（2026-11-17，美术第二轮 ④）。
    // 原来这一下会被当成「关掉聊天」吞掉，按钮根本没按下去，得再点一次：轮到自己时没法边聊边打。
    { id: 'chat-panel',       close: 'toggleChat', passThrough: '#action-bar, #preaction-bar, #straddle-flag' },
    { id: 'table-menu',       close: 'toggleTableMenu' },
    { id: 'confirm-modal',    close: 'closeConfirm' },     // 点外面 = 取消（closeConfirm() 不传参就是 false）
    { id: 'note-modal',       close: 'closeNoteModal' },
    { id: 'save-account-modal', close: 'closeSaveAccount' },
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
    { id: 'hand-guide',       close: 'closeHandGuide' },
];
// 聊天抽屉也在里面：原来那套独立实现本来就会在点牌桌时收起它，
// 删掉旧机制后必须接上，否则等于悄悄改了既有行为。

function panelIsOpen(el) { return !!el && !isDockedRail(el) && el.style.display !== 'none' && el.getClientRects().length > 0; }

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
        if (p.passThrough && e.target.closest && e.target.closest(p.passThrough)) continue;   // 点的是允许穿透的区域：不关它
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

// ===== 手机上的底部抽屉：按住顶上往下拉就关（2026-11-17，美术第二轮 ④）=====
// 样式见 43-modals.css（只在竖屏生效）。关闭走登记表里同一个函数，和点外面关闭是同一条路径。
// 只从抽屉【顶部 56px】开始的拖动才算：抽屉中间有滑条、输入框、可滚动的列表，从那里起手的拖动不该被抢走。
const SHEET_BOX = '.modal-box, .settings-box, .profile-box, .c-box, .ap-box, .side-panel';
let _sheetDrag = null;
function sheetOwner(box) {
    return DISMISSIBLE.find(p => { const el = document.getElementById(p.id); return el && (el === box || el.contains(box)) && panelIsOpen(el); });
}
document.addEventListener('touchstart', (e) => {
    if (document.body.classList.contains('layout-landscape') || e.touches.length !== 1) return;
    const box = e.target.closest && e.target.closest(SHEET_BOX);
    if (!box) return;
    const y = e.touches[0].clientY;
    if (y - box.getBoundingClientRect().top > 56 || box.scrollTop > 0) return;
    const owner = sheetOwner(box);
    if (!owner) return;
    _sheetDrag = { box, owner, y0: y, t0: Date.now(), dy: 0 };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
    if (!_sheetDrag) return;
    const dy = Math.max(0, e.touches[0].clientY - _sheetDrag.y0);   // 只许往下
    _sheetDrag.dy = dy;
    _sheetDrag.box.classList.add('sheet-dragging');
    _sheetDrag.box.style.transform = `translateY(${dy}px)`;
}, { passive: true });
function endSheetDrag() {
    const d = _sheetDrag; _sheetDrag = null;
    if (!d) return;
    const fast = d.dy > 40 && d.dy / Math.max(1, Date.now() - d.t0) > 0.5;   // 快速一甩也算
    d.box.classList.remove('sheet-dragging');
    if (d.dy > 90 || fast) {
        d.box.style.transform = '';
        try { window[d.owner.close]?.(); } catch (err) { console.warn('[ui] 关闭面板失败', d.owner.id, err); }
        return;
    }
    d.box.classList.add('sheet-settle');                 // 没拉够：弹回去
    d.box.style.transform = '';
    setTimeout(() => d.box.classList.remove('sheet-settle'), 240);
}
document.addEventListener('touchend', endSheetDrag);
document.addEventListener('touchcancel', endSheetDrag);

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

// ===== 客户端报错上报（2026-09-16）=====
// 🔴 在这之前，前端 JS 报错【只在玩家自己的 console 里】，服务端一无所知。
//    这个项目吃过好几次亏：sizeFor 拼错、#room-count 被删、http 下 navigator.clipboard
//    是 undefined —— 全是【静默失效】，最后都靠玩家截图才发现。
// ⚠️ 自己也要限流：一个渲染循环里的错误一秒能抛几百次，不挡就是自己 DDoS 自己。
//    服务端那边还有一层（按 IP + 去重），这里是第一道。
(function reportClientErrors() {
    const MAX_PER_SESSION = 15;      // 一次会话最多报这些，够定位问题了
    const MIN_GAP_MS = 2000;         // 两条之间至少隔 2 秒
    let sent = 0, lastAt = 0;
    const seen = new Set();          // 同一条只报一次

    function post(kind, message, source, line, col, stack) {
        if (sent >= MAX_PER_SESSION) return;
        const now = Date.now();
        if (now - lastAt < MIN_GAP_MS) return;
        const fp = kind + '|' + message + '|' + source + ':' + line;
        if (seen.has(fp)) return;
        seen.add(fp); sent++; lastAt = now;
        try {
            // keepalive：页面正在跳转/关闭时也要能发出去（报错常常紧跟着白屏）
            fetch('/api/client-error', {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind, message, source, line, col, stack,
                    build: (typeof CLIENT_BUILD === 'string' ? CLIENT_BUILD : ''),
                    page: location.hash || location.pathname,
                    ua: navigator.userAgent,
                    username: (typeof myUsername === 'string' ? myUsername : null),
                }),
            }).catch(() => {});      // 上报失败就算了，绝不能因此再抛一个错
        } catch { /* 同上 */ }
    }

    window.addEventListener('error', (e) => {
        post('error', String(e.message || e.error?.message || 'unknown'),
            String(e.filename || ''), e.lineno | 0, e.colno | 0, String(e.error?.stack || ''));
    });
    window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        post('rejection', String(r?.message || r || 'unhandled rejection'),
            '', 0, 0, String(r?.stack || ''));
    });
})();
