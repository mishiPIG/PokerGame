// ===== 牌谱回顾 (C9) =====
let histMode = '';
function openHistory() { document.getElementById('history-panel').style.display = ''; loadHistory('history-list', histMode, currentRoom); }
function closeHistory() { document.getElementById('history-panel').style.display = 'none'; }

function histFilter(btn, mode) {
    btn.parentElement.querySelectorAll('.hf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); histMode = mode; loadHistory('history-list', mode, currentRoom);
}
// 个人主页的牌谱 tab（独立 mode 与目标容器）
let phistMode = '';
function phistFilter(btn, mode) {
    btn.parentElement.querySelectorAll('.hf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); phistMode = mode; loadHistory('history-list2', mode);
}
const HIST_PAGE = 40;
let histState = {};         // listId -> { mode, offset, loading, done }
async function loadHistory(listId, mode, room) {
    listId = listId || 'history-list'; mode = mode || '';
    histState[listId] = { mode, room: room || null, offset: 0, loading: false, done: false };
    histHandsByList[listId] = [];
    document.getElementById(listId).innerHTML = `<div class="hist-empty">${L('加载中…', 'Loading…')}</div>`;
    await fetchHistPage(listId, true);
}
async function fetchHistPage(listId, first) {
    const st = histState[listId];
    if (!st || st.loading || st.done) return;
    st.loading = true;
    const btn = document.getElementById('histmore-' + listId);
    if (btn) btn.textContent = L('加载中…', 'Loading…');
    try {
        const token = localStorage.getItem('token');
        const q = `?limit=${HIST_PAGE}&offset=${st.offset}` + (st.mode ? `&mode=${st.mode}` : '') + (st.room ? `&room=${st.room}` : '');
        const res = await fetch('/api/my-hands' + q, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw 0;
        const page = await res.json();
        histHandsByList[listId] = (histHandsByList[listId] || []).concat(page);
        st.offset += page.length;
        if (page.length < HIST_PAGE) st.done = true;
        renderHistory(histHandsByList[listId], listId);
    } catch {
        if (first) document.getElementById(listId).innerHTML = `<div class="hist-empty">${L('读取牌谱失败', 'Failed to load hands')}</div>`;
    } finally { st.loading = false; }
}
let histHandsByList = {};   // listId -> hands[]（供点击回放取用）
function renderHistory(hands, listId) {
    listId = listId || 'history-list';
    histHandsByList[listId] = hands;
    const list = document.getElementById(listId);
    if (!hands.length) { list.innerHTML = `<div class="hist-empty">${L('暂无牌谱记录', 'No hands yet')}</div>`; return; }
    const fmtC = s => s.replace(/T/g, '10');
    const items = hands.map((h, idx) => {
        const me = (h.seats || []).find(s => s.userId === myUserId);
        const res = (h.results || []).find(r => r.userId === myUserId);
        const won = res ? res.won : 0;
        const net = res ? ((res.endChips ?? (me ? me.startChips : 0)) - (me ? me.startChips || 0 : 0)) : 0;
        const time = new Date(h.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const tag = h.mode === 'cash' ? L('现金', 'Cash') : 'SNG';
        const winCls = net > 0 ? 'win' : (net < 0 ? 'lose' : '');
        const holeCards = me ? me.hole.map(cs => formatCard(rpParseCard(cs))).join('') : '';
        const commCards = (h.community || []).map(cs => formatCard(rpParseCard(cs))).join('') || `<span class="hi-nocomm">${L('未到公共牌', 'No board')}</span>`;
        return `<div class="hist-item ${winCls}" onclick="openReplayFrom('${listId}',${idx})">
            <div class="hi-head">
                <span class="hi-time">${time}·${tag}</span>
                <span class="hi-net">${net > 0 ? '+' : ''}${net.toLocaleString()} ›</span>
            </div>
            <div class="hi-cards"><span class="hi-mine">${holeCards}</span><span class="hi-comm">${commCards}</span></div></div>`;
    }).join('');
    const st = histState[listId];
    // 滚动到底自动加载：底部放一个哨兵，进入视口就拉下一页（不再需要点「加载更多」）。
    // 仍保留一个可点的按钮作为降级——IntersectionObserver 不可用、或自动加载没触发时还能手动点。
    const footer = (st && !st.done)
        ? `<button class="hist-more" id="histmore-${listId}" onclick="fetchHistPage('${listId}')">${L(`加载更多（已 ${hands.length} 手）`, `Load more (${hands.length} so far)`)}</button>`
        : `<div class="hist-empty" style="font-size:11px">${L(`— 已全部 ${hands.length} 手 —`, `— all ${hands.length} hands —`)}</div>`;
    list.innerHTML = items + footer;
    if (st && !st.done) observeHistSentinel(listId);
}

// 让「加载更多」按钮本身充当哨兵：它一进入视口就自动拉下一页
const _histObservers = {};
function observeHistSentinel(listId) {
    const btn = document.getElementById('histmore-' + listId);
    if (!btn) return;
    if (typeof IntersectionObserver !== 'function') return;   // 老浏览器：保持手动点击
    if (_histObservers[listId]) _histObservers[listId].disconnect();
    const list = document.getElementById(listId);
    const io2 = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) fetchHistPage(listId);
    }, { root: list && list.scrollHeight > list.clientHeight ? list : null, rootMargin: '120px' });
    io2.observe(btn);
    _histObservers[listId] = io2;
}
function openReplayFrom(listId, idx) {
    const h = (histHandsByList[listId] || [])[idx];
    if (h) openHandDetail(h);
}

