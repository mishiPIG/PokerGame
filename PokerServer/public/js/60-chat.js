// ===== 聊天 + 表情 (B) =====
const QUICK_PHRASES = [
    '少一些套路，多一些真诚',
    '搏一搏，单车变摩托',
    '我不偷鸡，但绝对不要偷我鸡！',
    '没有皇同的命，得了27的病！',
    '快点吧！我等得花儿都谢了！',
    '软的怕硬的，硬的怕不要命的！',
    '一次次的弃牌，只是为了下一次的All in！',
    '你的水平与你扔掉AA的次数成正比！',
    '上桌30分钟找不出桌上的鱼，你就是那条鱼！',
    '我不是针对谁，我是说在座的各位都是鱼！',
    '撑死胆大的！饿死胆小的！其实结果都一样！',
    '论成败人生豪迈，大不了从头再来！'
];
// 表情集：把玩家实际最常用的排在前面（送花/干杯/拇指/狗屎），并补上德州梗。
// 🎣 = 叉鱼/捕鱼（"在座各位都是鱼"），🦈 = 鲨鱼（高手），🍀 = 运气，💰 = 收钱，🧊 = 冷静/慢玩
const EMOTES = [
    '🌹', '🍺', '👍', '💩',                     // 最常用四个
    '🎣', '🦈', '🍀', '💰', '🧊',               // 德州梗
    '😂', '😎', '😡', '😭', '🤔', '🎉', '👏', '🤡', '💪'
];
let chatBuilt = false;
function buildChatBars() {
    if (chatBuilt) return; chatBuilt = true;
    // 表情已移到「点头像」发送，聊天面板不再放表情行；只保留常用语（折叠 + 可滚动）
    document.getElementById('chat-phrases').innerHTML = QUICK_PHRASES.map(p => `<button class="phrase-btn" onclick="sendPhrase('${p.replace(/'/g, "\\'")}')">${p}</button>`).join('');
}
function togglePhrases() {
    const el = document.getElementById('chat-phrases');
    const show = el.style.display === 'none';
    el.style.display = show ? 'flex' : 'none';
    // 展开常用语时隐藏消息列表腾出空间（否则面板超高、第一条被顶出屏幕）
    document.getElementById('chat-list').style.display = show ? 'none' : '';
    document.getElementById('phrase-toggle')?.classList.toggle('on', show);
}
function toggleChat() {
    buildChatBars();
    const p = document.getElementById('chat-panel');
    p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    if (p.style.display === 'flex') {
        // 每次打开复位：显示消息列表、收起常用语
        document.getElementById('chat-list').style.display = '';
        document.getElementById('chat-phrases').style.display = 'none';
        document.getElementById('phrase-toggle')?.classList.remove('on');
        const l = document.getElementById('chat-list'); l.scrollTop = l.scrollHeight;
    }
}
function sendChat() {
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text || !socket) return;
    socket.emit('chat_msg', { text }); inp.value = '';
}
function sendPhrase(text) { if (socket) socket.emit('chat_msg', { text }); closeChat(); }
function sendEmote(e) { if (socket) socket.emit('emote', { emote: e }); closeChat(); }   // 聊天面板=广播
function closeChat() { document.getElementById('chat-panel').style.display = 'none'; }

// ===== 点头像弹层：本局数据 + 发表情 =====
let avatarPopupUserId = null;
function openAvatarPopup(userId) {
    if (!lastState) return;
    avatarPopupUserId = userId;
    const p = (lastState.players || []).find(x => x.userId === userId)
        || (lastState.spectators || []).find(x => x.userId === userId) || { username: '玩家', avatar: null };
    const name = p.displayName || p.username || '玩家';
    const isMe = userId === myUserId;
    const av = p.avatar ? `<img src="${p.avatar}" onerror="this.style.display='none'">` : escapeHtml((name || '?')[0].toUpperCase());
    const avEl = document.getElementById('ap-av');
    avEl.style.background = `hsl(${hashHue(p.userId || name)},45%,42%)`; avEl.innerHTML = av;
    document.getElementById('ap-name').textContent = name + (isMe ? '（你）' : '');
    document.getElementById('ap-emo-title').textContent = isMe ? '发表情（所有人可见）' : `给「${name}」扔表情`;
    document.getElementById('ap-stats').innerHTML = '<div class="ap-loading">加载中…</div>';
    document.getElementById('ap-emotes').innerHTML = EMOTES.map(e => `<button class="emote-btn" onclick="sendPopupEmote('${e}')">${e}</button>`).join('');
    // 房主管理：对其他在座玩家显示「移到观战席」（腾座位）
    const apo = document.getElementById('ap-owner');
    const iAmOwner = lastState.ownerUserId === myUserId;
    const targetSeated = (lastState.players || []).some(x => x.userId === userId);
    if (iAmOwner && !isMe && targetSeated && lastState.roomType === 'cash') {
        apo.style.display = '';
        apo.innerHTML = `<button class="ap-owner-btn" onclick="forceStand('${userId}')">🧍 移到观战席（腾出座位）</button>`;
    } else { apo.style.display = 'none'; apo.innerHTML = ''; }
    document.getElementById('avatar-popup').style.display = 'flex';
    if (socket) socket.emit('req_player_stats', { targetUserId: userId });
}
function closeAvatarPopup() { avatarPopupUserId = null; document.getElementById('avatar-popup').style.display = 'none'; }
function sendPopupEmote(e) {
    const target = (avatarPopupUserId && avatarPopupUserId !== myUserId) ? avatarPopupUserId : null;
    if (socket) socket.emit('emote', { emote: e, targetUserId: target });
    closeAvatarPopup();
}
// 从当前牌桌状态取某人的「本房战绩」（与「当前战绩」面板同源：chips-buyIn），保证两处口径一致
function roomStatFor(userId) {
    if (!lastState) return null;
    const p = (lastState.players || []).find(x => x.userId === userId);
    if (p) return { net: (p.chips || 0) - (p.buyIn || 0), hands: p.handsPlayed || 0 };
    const v = (lastState.vacated || []).find(x => x.userId === userId);
    if (v) return { net: v.net || 0, hands: v.handsPlayed || 0 };
    const h = (lastState.statsHistory || []).find(x => x.userId === userId);
    if (h) return { net: h.net || 0, hands: h.handsPlayed || 0 };
    return null;
}
function renderPlayerStats(userId, s) {
    if (userId !== avatarPopupUserId) return;
    s = s || {};
    const cell = (lab, val) => `<div class="ap-stat"><div class="ap-val">${val}</div><div class="ap-lab">${lab}</div></div>`;
    // 手数/战绩取当前牌桌状态（与「当前战绩」面板一致），VPIP/PFR/3Bet/ATS 取牌谱聚合
    const rs = roomStatFor(userId);
    const handsVal = rs ? rs.hands : (s.totalHands || 0);
    const netVal = rs ? rs.net : (s.net || 0);
    document.getElementById('ap-stats').innerHTML =
        cell('VPIP', (s.vpip || 0) + '%') + cell('PFR', (s.pfr || 0) + '%')
        + cell('3Bet', (s.threeBet || 0) + '%') + cell('ATS', (s.ats || 0) + '%')
        + cell('手数', handsVal) + cell('本房战绩', (netVal > 0 ? '+' : '') + netVal);
}
function appendChat(username, text, mine) {
    const l = document.getElementById('chat-list'); if (!l) return;
    const row = document.createElement('div');
    row.className = 'chat-row' + (mine ? ' mine' : '');
    row.innerHTML = `<span class="chat-name">${escapeHtml(username)}</span><span class="chat-text">${escapeHtml(text)}</span>`;
    l.appendChild(row);
    while (l.children.length > 60) l.removeChild(l.firstChild);
    l.scrollTop = l.scrollHeight;
}
// 弹幕：聊天消息从右向左滚过屏幕，带发送者 id
function spawnDanmaku(username, text) {
    const layer = document.getElementById('danmaku-layer'); if (!layer) return;
    const el = document.createElement('div');
    el.className = 'danmaku';
    el.innerHTML = `<span class="dm-name">${escapeHtml(username)}</span>${escapeHtml(text)}`;
    const h = layer.clientHeight || 200;
    el.style.top = Math.floor(Math.random() * Math.max(20, h - 34)) + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 7500);
}
// 座位上方冒泡（聊天/表情）
function seatBubble(userId, html, big) {
    const seat = document.querySelector(`.seat[data-uid="${userId}"]`);
    if (!seat) return;
    const b = document.createElement('div');
    b.className = 'seat-bubble' + (big ? ' big' : '');
    b.innerHTML = html;
    seat.appendChild(b);
    setTimeout(() => b.remove(), big ? 2200 : 3500);
}
