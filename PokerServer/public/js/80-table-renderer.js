// ===== UI helpers =====
function updateUserBar() {
    document.getElementById('display-username').textContent = myDisplayName || myUsername || '';
    document.getElementById('display-gold').textContent = myGold?.toLocaleString() || '0';
}

function formatCard(c, animate = false, delayMs = 0, opts = {}) {
    const sym = { Spades:'♠', Hearts:'♥', Diamonds:'♦', Clubs:'♣' }[c.suit] || '?';
    const red  = c.suit === 'Hearts' || c.suit === 'Diamonds';
    const rank = c.rank === 'T' ? '10' : c.rank;
    const cls = ['card', red ? 'red' : 'black', 'suit-' + c.suit.toLowerCase()];
    if (animate)       cls.push('deal-in');
    if (opts.flip)     cls.push('flip-in');
    if (opts.commDeal) cls.push('comm-deal');
    if (opts.fold)     cls.push('fold-out');
    if (opts.showable) cls.push('showable');
    if (opts.shown)    cls.push('shown');
    if (opts.hl)       cls.push('hl');
    if (opts.dim)      cls.push('dim');
    if (opts.mine)     cls.push('mine');
    if (opts.anim)     cls.push('reveal-anim');
    const style = ((animate || opts.flip || opts.commDeal) && delayMs) ? ` style="animation-delay:${delayMs}ms"` : '';
    const click = opts.onclick ? ` onclick="${opts.onclick}"` : '';
    return `<span class="${cls.join(' ')}"${style}${click} data-cid="${c.suit}${c.rank}">
                <span class="rank">${rank}</span>
                <span class="suit">${sym}</span>
            </span>`;
}
// 所有赢家「用到的公共牌」并集（分池时两位赢家的关键公共牌都高亮）
function winnerCommunitySet() {
    if (!showdownInfo) return new Set();
    const bw = showdownInfo.bestByWinner || {};
    const s = new Set();
    (showdownInfo.winners || []).forEach(id => (bw[id] ? bw[id].community : []).forEach(i => s.add(i)));
    if (!s.size) (showdownInfo.bestCommunity || []).forEach(i => s.add(i));   // 兼容旧结构
    return s;
}
// showdown 时某玩家某张底牌的高亮/变灰选项（每个赢家高亮各自最强5张；分池两位赢家都高亮）
function holeOpts(userId, i) {
    if (!showdownInfo) return {};
    const isWinner = showdownInfo.winners.includes(userId);
    const best = (showdownInfo.bestByWinner || {})[userId];
    if (isWinner && best && best.hole.includes(i)) return { hl: true, anim: revealJustHappened };
    if (isWinner) return { anim: revealJustHappened };            // 赢家其余牌保持正常（不变灰）
    return { dim: true, anim: revealJustHappened };               // 非赢家变灰
}
function cardBack(opts = {}) {
    const cls = ['card', 'back'];
    if (opts.fold)   cls.push('fold-out');
    if (opts.animate) cls.push('deal-in');
    const style = opts.animate && opts.delayMs ? ` style="animation-delay:${opts.delayMs}ms"` : '';
    return `<span class="${cls.join(' ')}"${style}></span>`;
}
function emptySlot() {
    return `<span class="empty-slot"></span>`;
}

// 环形 M 个座位坐标：ringIndex 0 = 底部中央，ringIndex 递增 = 顺时针（与座位号递增=行动顺序一致）
// 屏幕 y 向下：底部(6点)→左下(7点)→…→右下(5点)，即行动顺序顺时针、下一位在我左手边
// 座位块的实际像素尺寸（必须与 20-table.css 对得上，半径夹取全靠它）：
//   高 = padding2 + 名字(11×1.25) + 名字下边距7 + gap1 + 头像40 + gap1 + 筹码上边距9 + 筹码(12×1.2) + padding2 ≈ 90
//   （名字下边距/筹码上边距是给「下注 chip 徽章」和「倒计时数字」留的位，本来就算在块内）
//   宽 = 名字 max-width 64 + padding 2×2 = 68
// overhangTop = 真正超出【座位块】顶端的部分：胜率徽章 top:-34px 是相对【头像块】的，
//   而头像块本身已在座位块内 23.8px 处 → 实际只探出约 10px。
// ⚠️ 之前这里写 h:81 / overhangTop:34 —— 高度少算了 15px，于是下面的筹码数字没被算进夹取范围，
//    公共牌那一排就压到了两侧玩家的后手数字上（玩家实拍反馈）。改 CSS 尺寸务必回来同步。
const SEAT_BOX = { w: 68, h: 90, overhangTop: 11 };
// #board 的垂直位置（00-shell.css 里的 top%）。两边要一致——seatfit 会交叉核对。
const BOARD_TOP_PCT = 43;
// 座位环可用尺寸：优先量真实 DOM；测试环境(jsdom 无布局)可用 __ringW/__ringH 注入。
// ⚠️ 必须挡掉「残缺尺寸」：牌桌刚显示、布局还没稳定的那一帧量到的可能是个很小的非零值，
// 半径夹取会因此退化成最小值 → 所有座位挤成一条线（点「坐下」瞬间出现过）。
// 小于 MIN_SANE 的测量一律当作不可信，改用上一次的有效值 / 兜底值。
const MIN_SANE = 240;
let _lastRingSize = null;
function ringLayerSize() {
    const el = document.getElementById('ring-layer');
    let w = (el && el.clientWidth) || window.__ringW || 0;
    let h = (el && el.clientHeight) || window.__ringH || 0;
    if (w >= MIN_SANE && h >= MIN_SANE) { _lastRingSize = { w, h }; return _lastRingSize; }
    if (_lastRingSize) return _lastRingSize;                  // 用上一次量到的有效尺寸
    return { w: Math.max(w, 360), h: Math.max(h, 480) };      // 首次就量不到 → 保守兜底
}
function ringPos(ringIndex, M) {
    // 半径是相对 #ring-layer 的百分比；#ring-layer 已留安全内边距（见 00-shell.css）。
    // 横屏解除了 body 的 720px 限制、牌桌铺满页面，故横向再外扩一些（更接近真实牌桌 2:1）。
    const landscape = document.body.classList.contains('layout-landscape');
    // cy 取在「上下夹取值大致相等」的位置：上边界受名字/下注徽章/胜率徽章的探出(overhangTop)限制，
    // 下边界只受半个座位限制，所以圆心要略低于几何中心，才能把 ry 顶到最大、座位铺满整个牌桌。
    const cx = 50, cy = 48;
    // ⚠️ 半径必须按【实际可用尺寸】夹取，不能写死百分比：
    // 座位块有固定像素宽高(约 78×81)，屏幕越小它占的百分比越大，写死半径必然把边上的座位挤出去。
    // 这里保证「圆心偏移 + 半个座位」永远落在层内 —— 与屏幕尺寸、人数、横竖屏都无关。
    const sz = ringLayerSize();
    const halfW = (SEAT_BOX.w / 2 / Math.max(1, sz.w)) * 100;
    const halfTop = ((SEAT_BOX.h / 2 + SEAT_BOX.overhangTop) / Math.max(1, sz.h)) * 100;
    const halfBottom = (SEAT_BOX.h / 2 / Math.max(1, sz.h)) * 100;
    // 半径按【这一桌真正用到的方向】精确求解，而不是按「最坏情况」写死：
    // 位置是 x = cx + rx*cos + dx、y = cy + ry*sin + dy，边界约束对 rx/ry 都是线性的，
    // 所以逐座位反解出各自允许的最大半径、取最小即可 —— 结果是刚好贴边、一点空间都不浪费。
    // 这对奇数人数收益很大：9 人时没有任何座位落在正上方(|sin| 最大只有 0.94)，
    // 旧写法却按 sin=-1 留够余量 → 顶上白白空出一条（玩家反馈「最上面两个人还能再往上」）。
    // dx/dy 是下面 M>=6 的微调量，必须一起算进来 —— 那是【夹取之后】的偏移，漏算就会顶破边界。
    let rx = landscape ? 44 : 43, ry = landscape ? 40 : 44;
    for (let i = 0; i < M; i++) {
        const a = Math.PI / 2 + (2 * Math.PI * i / M), c0 = Math.cos(a), s0 = Math.sin(a);
        const nudged = M >= 6 && (i === 1 || i === M - 1);
        const dx = nudged ? (c0 < 0 ? -4 : 4) : 0, dy = nudged ? -6 : 0;
        if (c0 < -1e-6) rx = Math.min(rx, (cx + dx - halfW) / -c0);
        if (c0 > 1e-6) rx = Math.min(rx, (100 - cx - dx - halfW) / c0);
        if (s0 < -1e-6) ry = Math.min(ry, (cy + dy - halfTop) / -s0);
        if (s0 > 1e-6) ry = Math.min(ry, (100 - cy - dy - halfBottom) / s0);
    }
    // 下限不能太低：万一某一帧量到的尺寸不对，半径被夹到很小就会让所有座位挤成一条线（比溢出难看得多）。
    // 正常屏幕尺寸下这个下限永远不会生效（seatfit 测试覆盖了 2~9 人 × 5 种屏幕）。
    rx = Math.max(26, rx); ry = Math.max(24, ry);
    const ang = Math.PI / 2 + (2 * Math.PI * ringIndex / M);   // 0→底部；+ 使递增为顺时针
    const c = Math.cos(ang), s = Math.sin(ang);
    let x = cx + rx * c, y = cy + ry * s;
    // 多人(6+)微调：
    // （顶部座位原来还要 y-=5 去躲「房间号/盲注」水印——水印已移回牌桌内圈，不再需要，
    //   而且那是夹取之后的偏移，会顶破上边界。删掉。）
    if (M >= 6) {
        if (ringIndex === 1 || ringIndex === M - 1) {   // 「我」的左右两个：上移+外扩，别和自己挤在一起
            y -= 6; x += (c < 0 ? -4 : 4);
        }
    }
    return { x, y };
}

// 公共牌那一排能放多大：按【这一桌真实的座位几何】算，而不是拿屏幕宽度一刀切。
// 只有【垂直方向真的和这一排重叠】的座位才会限制它；其余情况就放到最大(1.2 倍 = 原尺寸)。
// 玩家先反馈「公共牌压住后手数字」，改成按屏幕宽度封顶后又反馈「牌怎么变这么小」——
// 所以按几何算：能放大就放大，实在放不下才收。
// 纯函数，便于 seatfit 直接验证（DOM 读取放在下面的包装里）。
function communityCardW(M, ringW, ringH, padTop, areaH, boardTopPct, cardW) {
    // 横屏(电脑/大屏)牌桌铺满整页，中间空得多：公共牌按 1.2 倍就显得很小，
    // 甚至比自己那两张(1.4 倍)还小 —— 公共牌本该是全桌的焦点。横屏放到 1.7 倍，
    // 竖屏保持 1.2 倍（玩家说手机上这个大小正好）。放不下时下面的几何夹取照样会收。
    const landscape = typeof document !== 'undefined' && document.body.classList.contains('layout-landscape');
    const maxW = cardW * (landscape ? 1.7 : 1.2);
    const rowH = maxW * 1.39;
    // ⚠️ #board 是【底池行 + 公共牌行】整体垂直居中于 boardTopPct，
    //    所以公共牌那一排的中心比 boardTopPct 低了「半个底池行」。
    //    漏掉这个偏移，就会算不到刚好在牌下方的座位（seatfit 当场抓到过）。
    const POT_ROW_H = 38;
    const mid = areaH * boardTopPct / 100 + POT_ROW_H / 2;
    const rowTop = mid - rowH / 2, rowBottom = mid + rowH / 2;
    let halfLimit = Infinity;
    for (let i = 0; i < M; i++) {
        const pt = ringPos(i, M);
        const cy = padTop + pt.y / 100 * ringH;
        // 这个座位竖直方向压根不在这一排的高度范围内 → 不构成限制
        if (cy + SEAT_BOX.h / 2 < rowTop || cy - SEAT_BOX.h / 2 - SEAT_BOX.overhangTop > rowBottom) continue;
        const cx = pt.x / 100 * ringW;
        const gap = Math.abs(cx - ringW / 2) - SEAT_BOX.w / 2 - 4;   // 留 4px 呼吸
        if (gap < halfLimit) halfLimit = gap;
    }
    if (halfLimit === Infinity) return maxW;
    return Math.min(maxW, Math.max(18, (halfLimit * 2 - 4 * 5) / 5));   // 5 张牌 + 4 个 5px 间距
}
function syncCommunityWidth(M) {
    const comm = document.getElementById('community');
    const ring = document.getElementById('ring-layer');
    const area = document.getElementById('table-area');
    if (!comm || !ring || !area) return;
    const sz = ringLayerSize();
    const areaH = area.clientHeight || sz.h;
    const padTop = ring.offsetTop || 0;
    const cardW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 32;
    const w = communityCardW(M, sz.w, sz.h, padTop, areaH, BOARD_TOP_PCT, cardW);
    comm.style.setProperty('--comm-w', w.toFixed(1) + 'px');
    const rib = document.getElementById('runit-boards');
    if (rib) rib.style.setProperty('--comm-w', w.toFixed(1) + 'px');
}

function renderSeats(state) {
    if (!state) return;
    const M = Math.max(state.maxPlayers || 2, 2);
    const meP = state.players.find(p => p.userId === myUserId);
    const mySeat = meP ? meP.seat : 0;        // 旋转基准：我的座位→底部
    const amSpectator = !meP;
    const isCash = state.roomType === 'cash';
    const bySeat = {}; state.players.forEach(p => bySeat[p.seat] = p);

    syncCommunityWidth(M);   // 座位几何定了，公共牌那排随之取最大可放尺寸
    const ring = document.getElementById('ring-layer');
    let html = '';
    for (let s = 0; s < M; s++) {
        const ringIndex = ((s - mySeat) % M + M) % M;          // 我的座位旋到底部(0)
        const pt = ringPos(ringIndex, M);
        const p = bySeat[s];
        const inner = p ? buildSeat(p, state)
                        : emptySeatHtml(isCash && amSpectator, s);
        const cls = 'ring-seat' + (ringIndex === 0 ? ' bottom' : '');
        html += `<div class="${cls}" style="left:${pt.x}%;top:${pt.y}%">${inner}</div>`;
    }
    ring.innerHTML = html;
    // renderSeats 会整体替换座位 DOM；把尚在 10 秒展示期内的临时语音挂回原位。
    restoreVoiceBubbles();

    // 观战横幅
    const banner = document.getElementById('spectator-banner');
    if (amSpectator) {
        banner.style.display = '';
        banner.textContent = isCash ? L('👀 观战中 · 点空座「坐下」带入入座', '👀 Spectating · tap an empty seat to buy in') : L('👀 观战中', '👀 Spectating');
    } else banner.style.display = 'none';
}

// 筹码数字滚动：变化时从旧值缓动到新值（easeOutCubic）
let prevChipsShown = {};
function animateChipCounts(state) {
    (state.players || []).forEach(p => {
        const prev = prevChipsShown[p.userId];
        prevChipsShown[p.userId] = p.chips;
        if (prev == null || prev === p.chips) return;
        const el = document.querySelector(`.seat[data-uid="${p.userId}"] .chips`);
        if (!el) return;
        const from = prev, to = p.chips, dur = 500, t0 = performance.now();
        (function step(t) {
            const k = Math.min(1, (t - t0) / dur);
            const e = 1 - Math.pow(1 - k, 3);
            el.textContent = fmtChips(Math.round(from + (to - from) * e));
            if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = fmtChips(to);
        })(t0);
    });
}
// 坐下入座：整圈座位旋转入位动画（重放需先移除类、强制重排）
function triggerSeatRotate() {
    const r = document.getElementById('ring-layer');
    if (!r) return;
    // 先等布局稳定再起动画：否则动画会从一个「座位还没排好」的画面开始（曾出现座位挤成一条线）
    requestAnimationFrame(() => {
        if (typeof lastState !== 'undefined' && lastState) render(lastState);
        r.classList.remove('rotating');
        void r.offsetWidth;
        r.classList.add('rotating');
        setTimeout(() => r.classList.remove('rotating'), 650);
    });
}
// 空座位：现金桌观众可点击「坐下」入座（携带座位号）；其余淡色占位
function emptySeatHtml(canSit, seat) {
    if (canSit) return `<div class="empty-seat sit" onclick="openSitDown(${seat})">${L('坐下', 'Sit')}</div>`;
    return `<div class="empty-seat">${L('空位', 'Empty')}</div>`;
}

function buildSeat(p, state) {
    const isMe     = p.userId === myUserId;
    const isBtn    = p.userId === state.buttonUserId;
    const isActing = p.userId === state.actionOnUserId;
    const isWinner = showdownInfo && showdownInfo.winners.includes(p.userId);
    const cls      = ['seat', isActing ? 'acting' : '', p.folded ? 'folded' : '', isWinner ? 'winner' : '',
                      p.allIn ? 'allin' : '', p.away ? 'away-seat' : ''].filter(Boolean).join(' ');

    // 状态气泡：按需显示（弃牌/坐出/离桌…灰；All in 红），平时不占地方
    let stText = '', stCls = 'wait';
    if (p.standing) stText = L('围观', 'Rail');
    else if (p.reserved) stText = L('留座', 'Held');
    else if (p.away) stText = L('离桌', 'Away');
    else if (p.sittingOut) stText = L('坐出', 'Sitting out');
    else if (p.pendingRebuy > 0) stText = L('补码', 'Rebuy');
    else if (p.allIn) { stText = 'All in'; stCls = 'allin'; }
    else if (p.folded) { stText = L('弃牌', 'Fold'); stCls = 'fold'; }
    const statusBubble = stText ? `<div class="status-bubble ${stCls}">${stText}</div>` : '';

    // 手牌展示
    const dealing = holeJustDealt;            // 发牌动画窗口
    const myDelay  = i => i * 2 * 130;        // 我的牌依次：0, 260ms
    const oppDelay = i => (i * 2 + 1) * 130;  // 对手牌依次：130, 390ms（交替发牌）
    let cardsHtml = '';
    if (isMe && myHoleCards.length === 2 && (!p.folded || state.phase === 'showdown')) {
        // 我的牌：局中显示；摊牌窗口（含我已弃牌）且未摊牌结算时可点击亮牌
        const showable = state.phase === 'showdown' && !revealedCards[myUserId];
        cardsHtml = myHoleCards.map((c, i) => {
            if (showable) return formatCard(c, dealing, myDelay(i), { showable: true, shown: myShown.has(i), onclick: `showMyCard(${i})` });
            if (showdownInfo && revealedCards[myUserId]) return formatCard(c, false, 0, holeOpts(myUserId, i));  // 真摊牌：高亮/变灰
            const mineOpt = (myHand && myHand.hole.includes(i)) ? { mine: true } : {};  // 行牌中高亮我牌型用到的手牌
            return formatCard(c, dealing, myDelay(i), mineOpt);
        }).join('');
    } else if (!isMe && revealedCards[p.userId]) {
        cardsHtml = revealedCards[p.userId].map((c, i) => formatCard(c, false, 0,
            showdownInfo ? holeOpts(p.userId, i) : { flip: revealJustHappened })).join('');
    } else if (!isMe && shownCards[p.userId]) {
        // 对手主动亮的牌：只显示亮出的那张（未亮的不显示）
        const byIdx = {}; shownCards[p.userId].forEach(s => byIdx[s.index] = s);
        cardsHtml = [0, 1].map(i => byIdx[i] ? formatCard(byIdx[i], false, 0, { flip: showJustHappened }) : '').join('');
    } else if (isMe && p.folded) {
        // 我弃牌：弃牌瞬间播放飞出动画，之后仍然「保留显示自己的手牌」（变暗），本手结束可亮出
        cardsHtml = (myHoleCards.length === 2)
            ? myHoleCards.map(c => formatCard(c, false, 0, foldingNow.has(p.userId) ? { fold: true } : { dim: true })).join('')
            : emptySlot() + emptySlot();
    } else if (isMe && state.phase !== 'waiting' && state.phase !== 'showdown') {
        cardsHtml = cardBack({ animate: dealing, delayMs: myDelay(0) }) + cardBack({ animate: dealing, delayMs: myDelay(1) });
    } else if (isMe) {
        cardsHtml = emptySlot() + emptySlot();
    } else {
        // 对手：不显示盖着的牌（只在亮牌/摊牌时显示，上面的分支已处理）
        cardsHtml = '';
    }

    // 本手下注：贴在头像顶部的小 chip 徽章
    // STR 标记：链上每一档都标（不只是最后一位），但【只在他的下注还是那笔 straddle 时】显示。
    // 他后面再下注/加注后就是普通下注了，一直挂着 STR 只会让人看不懂（玩家反馈）。
    const myStraddle = (state.straddles || []).find(st => st.userId === p.userId)
        || (state.straddle && state.straddle.userId === p.userId ? state.straddle : null);
    const isStraddler = !!myStraddle && state.phase === 'preflop' && p.currentBet === myStraddle.amount;
    const betBadge = p.currentBet > 0
        ? `<div class="bet-badge"><span class="chip-dot"></span>${isStraddler ? 'STR ' : ''}${fmtChips(p.currentBet)}</div>` : '';
    // 全押跑马实时胜率徽章（仅跑马中，摊牌前）
    const eqPct = equityMap[p.userId];
    const equityBadge = (eqPct != null && !p.folded && state.phase !== 'showdown' && state.phase !== 'waiting')
        ? `<div class="equity-badge">${eqPct}%</div>` : '';

    // 头像（小方块）+ 行动倒计时数字
    const displayName = p.displayName || p.username || L('玩家', 'Player');
    const initial = displayName.charAt(0).toUpperCase();
    const hue = hashHue(p.userId);
    const showRing = isActing && state.actionDeadline;
    const secs0 = showRing ? Math.max(0, Math.ceil((state.actionDeadline - Date.now()) / 1000)) : 0;
    const avatarImg = p.avatar ? `<img class="avatar-img" src="${p.avatar}" onerror="this.style.display='none'">` : '';

    // 准备徽标（仅开赛前）
    const canReady  = state.status === 'waiting' && (state.phase === 'waiting' || state.phase === 'showdown');
    const readyHtml = canReady
        ? `<div class="ready-badge ${p.ready ? 'yes' : 'no'}">${p.ready ? L('✓ 已准备', '✓ Ready') : L('未准备', 'Not ready')}</div>` : '';

    // 牌型徽章（独立深色小牌，绝不盖筹码）：赢家 or 我行牌中的当前牌型
    let handTypeBadge = '';
    if (showdownInfo && showdownInfo.winners.includes(p.userId) && showdownInfo.category)
        handTypeBadge = `<div class="hand-type-badge win">🏆 ${handCat(showdownInfo.category)}</div>`;
    else if (isMe && myHand && state.phase !== 'waiting') {
        // 已弃牌也显示（玩家反馈想知道「我弃掉的牌最后会是什么」）——加「弃」前缀+灰样式，
        // 明确这是假设性的牌型，不会误以为自己还在牌局里。摊牌阶段同样保留（那时才最想看）。
        if (p.folded) handTypeBadge = `<div class="hand-type-badge folded-hint">${L('弃', 'Fold')} · ${handCat(myHand.category)}</div>`;
        else if (!showdownInfo) handTypeBadge = `<div class="hand-type-badge">${handCat(myHand.category)}</div>`;
    }

    // 亮牌提示（摊牌局间，含弃牌者可亮牌）
    const showHint = (isMe && state.phase === 'showdown'
        && !revealedCards[myUserId] && myHoleCards.length === 2 && myShown.size < 2)
        ? `<div class="show-hint">${L('👁️ 点亮牌给对手', '👁️ Tap to show a card')}</div>` : '';

    // 对手亮牌：覆盖在头像上（不占额外高度、不顶出屏幕），牌型徽章压在牌下沿
    const oppCardsOverlay = (!isMe && cardsHtml)
        ? `<div class="opp-cards">${cardsHtml}${handTypeBadge}</div>` : '';
    const avatarBlock = `<div class="avatar-block" onclick="openAvatarPopup('${p.userId}')" style="cursor:pointer">
        ${betBadge}${equityBadge}
        <div class="avatar" style="background:hsl(${hue},45%,42%)">${escapeHtml(initial)}${avatarImg}</div>
        ${isBtn ? '<div class="dealer-btn">D</div>' : ''}
        ${showRing ? `<div class="avatar-ring" id="seat-ring"></div><div class="avatar-secs" id="seat-timer-num">${secs0}</div>` : ''}
        ${oppCardsOverlay}
    </div>`;

    const nameHtml  = `<div class="name">${escapeHtml(displayName)}</div>`;
    const chipsHtml = `<div class="chips${isMe ? ' clickable' : ''}"${isMe ? ` onclick="toggleDisplayBB()" title="${L('点击切换 筹码/BB 显示', 'Tap to toggle chips/BB')}"` : ''}>${fmtChips(p.chips)}</div>`;

    if (isMe) {
        // 自己：横向——左=名字/头像/筹码，右=两张牌（+牌型）
        const rightCards = cardsHtml ? `<div class="self-cards">${cardsHtml}${handTypeBadge}${showHint}</div>`
            : (handTypeBadge || showHint ? `<div class="self-cards">${handTypeBadge}${showHint}</div>` : '');
        return `<div class="${cls}" data-uid="${p.userId}">${statusBubble}${readyHtml}`
            + `<div class="self-body"><div class="self-info">${nameHtml}${avatarBlock}${chipsHtml}</div>${rightCards}</div></div>`;
    }
    // 对手：竖向 名上·头像(牌覆盖其上)·筹码下
    return `<div class="${cls}" data-uid="${p.userId}">${statusBubble}${readyHtml}${nameHtml}${avatarBlock}${chipsHtml}</div>`;
}

// roomId 仅作内部标识，不再展示为可输入的邀请凭证。
function roomNoHtml() {
    return iCanPlay ? `<span class="room-no">${L('🔐 已加入', '🔐 Joined')}</span>` : `<span class="room-no">${L('👀 观战中', '👀 Spectating')}</span>`;
}
function render(state) {
    // 底池竖排（商业级）：中间=总底池；有边池时 上=主池、下=各边池；下注中 上=上一轮总底池
    const bets = state.players.reduce((s, p) => s + p.currentBet, 0);
    const collected = state.pot;               // 已收拢（=上一轮总底池）
    const totalPot = collected + bets;
    const pots = state.sidePots || [];
    // 真正的边池需要 ≥3 名未弃牌玩家（有人 all-in 低于他人）；2 人时"边池"只是未跟注退还，不显示
    const activeCount = state.players.filter(p => !p.folded).length;
    const hasRealSide = activeCount >= 3 && pots.length > 1 && pots.slice(1).some(p => p.eligibleCount >= 2);
    let above = '', below = '';
    if (hasRealSide) {
        above = `<div class="pot-row main"><span class="pot-chip gold"></span>${L('主池', 'Main')} ${fmtChips(pots[0].amount)}</div>`;
        for (let i = 1; i < pots.length; i++)
            below += `<div class="pot-row side"><span class="pot-chip green"></span>${L('边池', 'Side')}${i} ${fmtChips(pots[i].amount)}</div>`;
    } else if (collected > 0 && bets > 0) {
        above = `<div class="pot-row prev"><span class="pot-chip"></span>${fmtChips(collected)}</div>`;
    }
    document.getElementById('pot').innerHTML =
        above + `<div class="pot-total">${L('底池', 'Pot')}: ${fmtChips(totalPot)}</div>` + below;

    // SNG 比赛信息：作为桌面中央淡色水印（不再占顶栏空间）
    const sng = document.getElementById('table-info');
    if (state.roomType === 'sng') {
        const lvl = (state.currentLevel || 0) + 1;
        nextLevelAt = state.nextLevelAt || 0;
        sng.innerHTML = `${escapeHtml(state.roomName)} · ${roomNoHtml()}<br>`
            + `${L('级别', 'Level')} ${lvl} · ${L('盲注', 'Blinds')} ${state.smallBlind}/${state.bigBlind}`
            + (state.pendingLevelUp ? ` · <span style="color:#ff9f1c">${L('⏫本局后升盲', '⏫ Blinds up next hand')}</span>` : ` · <span id="next-level"></span>`);
    } else {
        nextLevelAt = 0; tableEndAt = state.tableEndAt || 0;
        sng.innerHTML = `${escapeHtml(state.roomName)} · ${roomNoHtml()}<br>`
            + `${L('现金桌', 'Cash')} · ${L('盲注', 'Blinds')} ${state.smallBlind}/${state.bigBlind}${state.ante ? ' · ante ' + state.ante : ''}`
            + (state.allowUtgStraddle ? ' · STR 2BB' : '')
            + (tableEndAt ? ` · <span id="table-remain"></span>` : '');
    }
    if (state.timeExpired) {
        // 带上兜底倒计时：让全桌都知道「不处理的话什么时候会自动结算」，而不是干等着
        const left = state.timeUpGraceAt ? Math.max(0, Math.ceil((state.timeUpGraceAt - Date.now()) / 60000)) : null;
        sng.innerHTML += `<br><span style="color:#ffcf5c">${L('⏸️ 训练时间已到，等待房主决定', '⏸️ Session time up — waiting for host')}`
            + (left != null ? L(`（约 ${left} 分钟后自动结算）`, ` (auto-settles in ~${left} min)`) : '') + `</span>`;
    }
    else if (state.paused) sng.innerHTML += `<br><span style="color:#ffcf5c">${L('⏸️ 房主已暂停发牌', '⏸️ Host paused dealing')}</span>`;

    // 公共牌：固定 5 个位置（已发的是牌，未发的占位空槽），避免发牌时布局跳动
    const comm = state.communityCards;
    if (comm.length < prevCommunityCount) prevCommunityCount = 0;  // 新一局，公共牌清空
    const animateFrom = prevCommunityCount;
    const commEl = document.getElementById('community');
    const commOpts = (i) => {
        if (showdownInfo) return winnerCommunitySet().has(i) ? { hl: true } : { dim: true };
        return (myHand && myHand.community.includes(i)) ? { mine: true } : {};
    };
    // ⚠️ 只有公共牌【真的变了】才重建 innerHTML。否则（翻牌后紧跟的 my_hand/高亮更新会再触发一次 render）
    //    重建会把正在进行的发牌动画整排清掉 → 看起来"三张一起出现"。牌没变时只在原地切高亮 class。
    const domCards = commEl.querySelectorAll('.card');
    const sameCards = domCards.length === comm.length
        && Array.from(domCards).every((el, i) => el.dataset.cid === (comm[i].suit + comm[i].rank));
    if (sameCards && !revealJustHappened) {
        domCards.forEach((el, i) => {
            const o = commOpts(i);
            el.classList.toggle('mine', !!o.mine);
            el.classList.toggle('hl', !!o.hl);
            el.classList.toggle('dim', !!o.dim);
        });
    } else {
        let commHtml = '';
        for (let i = 0; i < 5; i++) {
            if (i >= comm.length) { commHtml += emptySlot(); continue; }
            const isNew = i >= animateFrom;
            const opts = commOpts(i);
            if (showdownInfo) {   // showdown：组成各赢家牌型的公共牌拉出高亮（分池取并集），其余变灰
                opts.anim = revealJustHappened;
                commHtml += formatCard(comm[i], isNew, (i - animateFrom) * 140, opts);
            } else {
                if (isNew) opts.commDeal = true;    // 新发的公共牌：落下+翻牌，逐张 stagger（flop 依次 1→2→3，转/河同理）
                commHtml += formatCard(comm[i], false, isNew ? (i - animateFrom) * 200 : 0, opts);
            }
        }
        commEl.innerHTML = commHtml;
        if (comm.length > prevCommunityCount) {
            for (let i = 0; i < comm.length - animateFrom; i++) sndFlip(i);   // 翻几张响几声
            lockInput(650);                                                   // 翻牌瞬间防误触
        }
    }
    if (holeJustDealt) lockInput(750);                                    // 发牌瞬间防误触
    prevCommunityCount = comm.length;

    // 弃牌检测：本次新弃牌的玩家播放弃牌动画 + 音效（短暂后变空位）
    state.players.forEach(p => {
        if (p.folded && !prevFoldedSet.has(p.userId)) {
            foldingNow.add(p.userId);
            sndFold();
            setTimeout(() => { foldingNow.delete(p.userId); if (lastState) renderSeats(lastState); }, 480);
        }
    });
    prevFoldedSet = new Set(state.players.filter(p => p.folded).map(p => p.userId));

    renderSeats(state);
    animateChipCounts(state);

    // 入场动画标志只生效一次，渲染完即消费，避免后续重绘重复闪动
    holeJustDealt = false;
    revealJustHappened = false;
    showJustHappened = false;

    const me       = state.players.find(p => p.userId === myUserId);
    const myTurn    = state.actionOnUserId === myUserId;
    const toCall    = me ? state.currentBet - me.currentBet : 0;
    // 开赛前（status=waiting）：SNG 用准备系统；现金桌房主点「开始」
    const isCash    = state.roomType === 'cash';
    const isOwner   = state.ownerUserId === myUserId;
    const waitingPre = state.status === 'waiting' && (state.phase === 'waiting' || state.phase === 'showdown');
    const canReady  = !isCash && waitingPre;   // 准备系统仅 SNG

    // 轮到我时「叮」一声 + 重置 5s 警告标志
    if (myTurn && state.actionOnUserId !== lastActionOnUserId) { sndTurn(); vibrate(45); warnedThisTurn = false; }
    lastActionOnUserId = state.actionOnUserId;

    // ── 准备按钮（SNG 开赛前）──
    const btnReady = document.getElementById('btnReady');
    btnReady.style.display = canReady ? '' : 'none';
    btnReady.disabled = !me || !canReady;
    if (me && me.ready) { btnReady.textContent = L('⏳ 已准备（点击取消）', '⏳ Ready (tap to cancel)'); btnReady.classList.add('readied'); }
    else                { btnReady.textContent = L('✅ 准备', '✅ Ready');              btnReady.classList.remove('readied'); }

    // ── 现金桌开赛：房主「开始」/ 其他人「等待房主」──
    const seatedCount = state.players.length;
    const canStart = isCash && isOwner && waitingPre && seatedCount >= 2;
    const waitForHost = isCash && !isOwner && me && waitingPre;
    document.getElementById('btnStart').style.display = canStart ? '' : 'none';
    document.getElementById('waitHost').style.display = waitForHost ? '' : 'none';

    // ── 现金桌坐出补码 / 留座·围观回桌 提示 ──
    // 仅当真正坐出（本手结束被清理标记 sittingOut）才提示补码；all-in 当下 chips=0 但仍在牌局中，不弹
    const amReserved = isCash && me && me.reserved;                    // 留座离桌：保留座位
    const amVacated  = isCash && !me && (state.vacatedUserIds || []).includes(myUserId);   // 站起围观：已离座，可带筹码回座
    const amSittingOut = isCash && me && !amReserved && me.sittingOut && (me.pendingRebuy || 0) === 0;
    document.getElementById('reserveBackPanel').style.display = (amReserved || amVacated) ? '' : 'none';
    if (amReserved || amVacated) document.getElementById('reserveBackLabel').textContent =
        amVacated ? L('🧍 站起围观中（点「回到座位」带原筹码回来）', '🧍 On the rail (tap "Sit back" to return with your chips)') : L('💺 留座离桌中', '💺 Seat held (away)');
    document.getElementById('sitOutPanel').style.display = amSittingOut ? '' : 'none';

    // ── 解散房间按钮（仅房主，开赛后可用；在设置面板内）──
    const hostDissolve = (me && state.ownerUserId === myUserId && state.status === 'running');
    document.getElementById('setDissolve').style.display = hostDissolve ? '' : 'none';

    // ── 主行动按钮（整组仅轮到我时显示）──
    document.getElementById('buttons-row').style.display = myTurn ? 'flex' : 'none';
    if (!myTurn) {   // 轮到别人：收起精调面板并解除动画暂停（否则下家呼吸光被冻住）
        document.getElementById('sizing-row').style.display = 'none';
        document.body.classList.remove('sizing-open');
    }
    // 实际可跟注额 = min(待跟, 我的筹码)：对手 all-in 超过我筹码时只能跟到自己上限
    const callAmt = me ? Math.min(toCall, me.chips) : 0;
    const isCallAllin = me && callAmt >= me.chips && callAmt > 0;
    document.getElementById('btnFold').disabled  = !myTurn;
    // 过牌/跟注 合并为一个按钮：有未跟注→跟注，否则→过牌
    const cc = document.getElementById('btnCheckCall');
    cc.disabled = !myTurn;
    const isCall = myTurn && toCall > 0;
    cc.textContent = isCall ? `${t('act.call')}\n${fmtChips(callAmt)}${isCallAllin ? t('act.allinParen') : ''}` : t('act.check');
    cc.classList.toggle('call', isCall);
    cc.classList.toggle('check', !isCall);
    // 下注 / 加注 互斥：本街无人下注显示「下注」，否则显示「加注」，只露一个减少冗余
    const showBet = myTurn && state.currentBet === 0;
    const showRaise = myTurn && state.currentBet > 0;
    document.getElementById('btnBet').style.display   = showBet ? '' : 'none';
    document.getElementById('btnRaise').style.display = showRaise ? '' : 'none';
    document.getElementById('btnBet').disabled   = !showBet || (me && me.chips <= 0);
    // 加注前提：我的筹码要多于待跟额（否则只能跟到全下，没法加注）
    // 无效加注(state.raiseClosed)时不用 disabled——保持可点，点了才能弹出「为什么不能加」的提示
    const btnRaise = document.getElementById('btnRaise');
    btnRaise.disabled = !showRaise || (!state.raiseClosed && me && me.chips <= toCall);
    btnRaise.classList.toggle('locked', !!(showRaise && state.raiseClosed));

    // ── 加时按钮（底部控制栏）──
    document.getElementById('tcAddTime').disabled = !(myTurn && state.canAddTime);
    // 加时按钮旁显示我的剩余时间卡数量（现金桌）
    const tcInfo = document.getElementById('tcAddInfo');
    if (tcInfo) tcInfo.textContent = (state.roomType === 'cash' && me) ? ('×' + (me.timeCards || 0)) : '';

    // ── 看后续牌按钮（弃牌结束的局间，公共牌不足 5 张时）──
    const btnRabbit = document.getElementById('btnRabbit');
    const commLen = state.communityCards.length;
    const rabbitVisible = state.phase === 'showdown' && commLen < 5;
    if (rabbitVisible) {
        btnRabbit.style.display = '';
        btnRabbit.textContent = commLen === 0 ? L('🐰 看翻牌', '🐰 See flop') : (commLen === 3 ? L('🐰 看转牌', '🐰 See turn') : L('🐰 看河牌', '🐰 See river'));
    } else {
        btnRabbit.style.display = 'none';
    }

    // ── 下注尺寸面板 ──
    setupSizing(state, me, myTurn);

    // ── 预操作条：我在牌里、但还没轮到我时显示；轮到我则执行已勾选的预操作 ──
    const inHand = me && !me.folded && !me.allIn && myHoleCards.length === 2
        && ['preflop', 'flop', 'turn', 'river'].includes(state.phase) && state.status === 'running';
    const showPre = inHand && !myTurn;
    const preBar = document.getElementById('preaction-bar');
    preBar.style.display = showPre ? 'flex' : 'none';
    if (showPre) requestAnimationFrame(positionPreBar);
    if (myTurn && preAction) runPreAction(toCall);
    else updatePreBar();

    // ── 行动悬浮球整体显隐：座位绝对定位、悬浮球定位在「自己座位」正上方，不遮手牌 ──
    const showAB = (myTurn || (canReady && me) || canStart || waitForHost || amSittingOut || amReserved || rabbitVisible);
    const ab = document.getElementById('action-bar');
    ab.style.display = showAB ? 'flex' : 'none';
    if (showAB) requestAnimationFrame(positionActionBar);
}

// 把行动悬浮球放到「自己座位+手牌」的正上方（图二式），不遮挡手牌
function positionActionBar() {
    const ab = document.getElementById('action-bar');
    if (!ab || ab.style.display === 'none') return;
    const view = document.getElementById('table-view');
    const hero = document.querySelector('#ring-layer .ring-seat.bottom');
    if (!view) return;
    const vr = view.getBoundingClientRect();
    if (hero) {
        const hr = hero.getBoundingClientRect();
        let bottom = (vr.bottom - hr.top) + 12;          // 悬浮球整体下移，预设球落在拇指易点区
        const maxBottom = vr.height * 0.6;               // 别顶得太高
        ab.style.bottom = Math.min(bottom, maxBottom) + 'px';
    } else {
        ab.style.bottom = '70px';                        // 观众/无座位：默认靠下
    }
}
// 预操作两个按钮：垂直对齐到「自己人物」中部（两侧分列，靠手好点）
function positionPreBar() {
    const bar = document.getElementById('preaction-bar');
    if (!bar || bar.style.display === 'none') return;
    const hero = document.querySelector('#ring-layer .ring-seat.bottom');
    const view = document.getElementById('table-view');
    if (!hero || !view) { bar.style.bottom = '120px'; return; }
    const hr = hero.getBoundingClientRect(), vr = view.getBoundingClientRect();
    bar.style.bottom = (vr.bottom - (hr.top + hr.height / 2) - 16) + 'px';   // 人物中线
}
window.addEventListener('resize', () => { if (lastState) { positionActionBar(); positionPreBar(); positionStraddleOffer(); } });

// 牌桌区域尺寸一旦真正确定/变化，就整体重排一次。
// 为什么需要：从大厅切进牌桌的那一帧，#table-area 还没拿到最终高度，
// 此时算出的座位坐标是错的（座位挤成一条线），而「开始/行动」悬浮球又是贴着我的座位定位的，
// 于是按钮也跟着飘到屏幕中间——之前只能靠手动切一下横竖屏（触发 resize）才恢复。
// ResizeObserver 覆盖了所有触发时机：进桌、坐下、切横竖屏、窗口缩放、手机地址栏收起。
(function observeTableResize() {
    if (typeof ResizeObserver !== 'function') return;   // 老浏览器降级：仍有 resize 兜底
    const start = () => {
        const area = document.getElementById('table-area') || document.getElementById('table-view');
        if (!area) { setTimeout(start, 200); return; }
        let lastW = 0, lastH = 0;
        new ResizeObserver(entries => {
            const r = entries[0] && entries[0].contentRect;
            if (!r || (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 2)) return;
            lastW = r.width; lastH = r.height;
            if (typeof lastState !== 'undefined' && lastState) render(lastState);
        }).observe(area);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();

// 配置下注：轮到我且能下注/加注时，显示快捷比例（含金额）；精调面板默认收起
function setupSizing(state, me, myTurn) {
    const quick = document.getElementById('quick-bet-group');
    const row   = document.getElementById('sizing-row');
    const canBet   = me && myTurn && state.currentBet === 0 && me.chips > 0;
    const canRaise = me && myTurn && state.currentBet > 0  && me.chips > (state.currentBet - me.currentBet);
    if (!canBet && !canRaise) { quick.style.display = 'none'; row.style.display = 'none'; sizeCtx = null; return; }

    const totalPot = state.pot + state.players.reduce((s, p) => s + p.currentBet, 0);
    const maxTo    = me.currentBet + me.chips;                       // 全下目标额
    const rawMin   = canBet ? state.minBet : state.minRaiseTo;       // 服务器给的最小额
    const minTo    = Math.min(rawMin, maxTo);                        // 筹码不够最小额时只能全下
    sizeCtx = { minTo, maxTo, currentBet: state.currentBet, myBet: me.currentBet, totalPot };

    quick.style.display = 'flex';
    renderQuickBets();                                              // 重新渲染（带最新金额）
    // 配置滑条范围（面板保持收起，点「下注/加注」才展开）
    const slider = document.getElementById('betSlider');
    slider.min = minTo; slider.max = maxTo;
    document.getElementById('raiseAmount').min = minTo;
    document.getElementById('raiseAmount').max = maxTo;
    document.getElementById('raiseAmount').disabled = false;
    if (row.style.display === 'none') updateConfirmLabel(minTo);
}
