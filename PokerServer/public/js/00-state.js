// ===== State =====
let socket       = null;
let myUserId     = null;
let myUsername   = null;
let myGold       = 0;
let myAvatar     = null;
let myHoleCards  = [];
let revealedCards = {};  // userId -> [{suit,rank},{suit,rank}]  (showdown)
let runitState = null;   // 多次发牌桌面展示状态 { n, baseLen, filled:[] }
let currentRoom  = '';
let iCanPlay     = false;  // 是否有下场资格（房主/验证邀请/座上玩家）；公开列表进入者为 false
let everConnected = false; // 是否已连接过（区分首次连接 vs 断线重连，重连不闪回大厅）
let mySeated     = false; // 我当前是否已入座（用于坐下入座动画/音效触发）
let equityMap    = {};    // 全押跑马实时胜率 { userId: pct }
let roomInviteInfo = null;
let pendingInviteToken = '';
let straddleOffer = null; // { targetHandSeq, amount, deadlineAt }，仅本次限时邀请
let straddleOfferTimer = null;

function hideStraddleOffer() {
    straddleOffer = null;
    clearInterval(straddleOfferTimer); straddleOfferTimer = null;
    const el = document.getElementById('straddle-offer');
    if (el) el.style.display = 'none';
}
function renderStraddleOffer() {
    if (!straddleOffer) return;
    const remain = Math.max(0, Math.ceil((straddleOffer.deadlineAt - Date.now()) / 1000));
    if (remain <= 0) { hideStraddleOffer(); return; }
    document.getElementById('straddle-offer-amount').textContent = straddleOffer.amount;
    document.getElementById('straddle-offer-time').textContent = `${remain}s`;
    document.getElementById('straddle-offer').style.display = '';
    requestAnimationFrame(positionStraddleOffer);
}
function positionStraddleOffer() {
    const offer = document.getElementById('straddle-offer');
    const hero = document.querySelector('#ring-layer .ring-seat.bottom');
    const view = document.getElementById('table-view');
    if (!offer || offer.style.display === 'none' || !hero || !view) return;
    const hr = hero.getBoundingClientRect(), vr = view.getBoundingClientRect();
    offer.style.bottom = Math.min(vr.height * 0.63, vr.bottom - hr.top + 18) + 'px';
}
function answerStraddle(accept) {
    if (!straddleOffer || !socket) return;
    const targetHandSeq = straddleOffer.targetHandSeq;
    hideStraddleOffer(); // 两个选择都立即隐藏，不作为常驻控件
    socket.emit('straddle_decision', { targetHandSeq, accept: accept === true });
}

// 邀请链接使用 fragment，先暂存到当前标签页，再从地址栏清除；登录/注册完成后继续处理。
function capturePendingInvite() {
    const match = location.hash.match(/^#\/join\/([A-Za-z0-9_-]{20,128})$/);
    if (match) {
        pendingInviteToken = match[1];
        try { sessionStorage.setItem('pendingInviteToken', pendingInviteToken); } catch {}
        try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    } else if (location.hash.startsWith('#/join/')) {
        pendingInviteToken = '';
        try { sessionStorage.removeItem('pendingInviteToken'); } catch {}
        try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    } else {
        try { pendingInviteToken = sessionStorage.getItem('pendingInviteToken') || ''; } catch {}
    }
}
capturePendingInvite();

// ===== 动画门控：只在「真正发新牌」时播放入场动画，避免每次重绘都闪 =====
let lastState          = null;  // 最近一次 game_state，供 hole_cards/showdown 单独重渲时复用
let prevCommunityCount = 0;     // 上次公共牌数量，新增的那几张才动画
let holeJustDealt      = false; // 本局刚发到自己手牌
let revealJustHappened = false; // showdown 刚翻开对手底牌
let nextLevelAt        = 0;     // SNG 下一级别升盲时间戳(ms)，0 表示无
let tableEndAt         = 0;     // 现金桌训练结束时间戳(ms)，0 表示无
let lastActionOnUserId = null;  // 上次行动者，用于「轮到我」提示音去重
let warnedThisTurn     = false; // 本回合是否已播放 5s 警告音
let inputLockUntil     = 0;     // 发牌/翻牌后短暂锁定行动，防误触
function lockInput(ms) {
    inputLockUntil = Date.now() + ms;
    const ab = document.getElementById('action-bar');
    if (!ab) return;
    ab.classList.add('locked');
    clearTimeout(window._unlockT);
    window._unlockT = setTimeout(() => ab.classList.remove('locked'), ms);
}
function inputLocked() { return Date.now() < inputLockUntil; }
let prevFoldedSet      = new Set();  // 上次渲染时已弃牌的玩家
let foldingNow         = new Set();  // 正在播放弃牌动画的玩家（短暂）
let shownCards         = {};         // userId -> [{index,suit,rank}] 主动亮出的牌
let myShown            = new Set();  // 本局我已亮出的牌索引
let showJustHappened   = false;     // 刚收到主动亮牌，触发翻转动画一次
let showdownInfo       = null;      // { winners, winnerId, bestCommunity[], bestHole[], category }
let myHand             = null;      // 我当前最强牌 { community[], hole[], category }（私发，仅自己）

// ===== 显示单位：筹码数字 / 大盲(BB)数 =====
let displayBB = localStorage.getItem('displayBB') === '1';
function curBB() { return (lastState && lastState.bigBlind) || 20; }
// 格式化筹码：BB 模式下换算为大盲数（最多一位小数），否则千分位数字
function fmtChips(amount) {
    if (displayBB) {
        const bb = amount / curBB();
        return (Number.isInteger(bb) ? bb : bb.toFixed(1)) + 'BB';
    }
    return Math.round(amount).toLocaleString();
}
function toggleDisplayBB() {
    displayBB = !displayBB;
    localStorage.setItem('displayBB', displayBB ? '1' : '0');
    const c = document.getElementById('set-bb'); if (c) c.checked = displayBB;
    if (lastState) render(lastState);
}

