// ===== Admin =====
let isAdmin = false;

function toggleAdminPanel() {
    const panel = document.getElementById('admin-panel');
    const visible = panel.style.display !== 'none';
    if (!visible) loadAdminUsers();
    panel.style.display = visible ? 'none' : '';
}

const admToken = () => localStorage.getItem('token');
const admGet = (url) => fetch(url, { headers: { Authorization: `Bearer ${admToken()}` } });
function admMsg(text, ok = true) {
    const el = document.getElementById('admin-msg');
    if (el) el.textContent = (ok ? '✅ ' : '❌ ') + text;
}
function adminTab(name) {
    ['users', 'metrics', 'rooms', 'wallet', 'hands', 'audit', 'errors', 'sources', 'mail'].forEach(t => {
        const pane = document.getElementById('adm-pane-' + t);
        if (pane) pane.style.display = t === name ? '' : 'none';
    });
    document.querySelectorAll('.adm-tab').forEach(b => b.classList.toggle('sel', b.dataset.at === name));
    if (name === 'rooms') loadAdminRooms();
    if (name === 'metrics') loadAdminMetrics();
    if (name === 'errors') loadAdminErrors();
    if (name === 'sources') loadAdminSources();
}

// —— 玩家牌谱：查任意玩家最近的牌局 ——
async function loadAdminHands(username) {
    const name = username || document.getElementById('adm-hands-user').value.trim();
    if (!name) return;
    document.getElementById('adm-hands-user').value = name;
    const mode = document.getElementById('adm-hands-mode').value;
    const box = document.getElementById('adm-hands');
    box.innerHTML = '<div class="adm-empty">加载中…</div>';
    const res = await admGet(`/api/admin/hands/${encodeURIComponent(name)}?limit=30${mode ? '&mode=' + mode : ''}`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); box.innerHTML = `<div class="adm-empty">${escapeHtml(e.error || '加载失败')}</div>`; return; }
    const d = await res.json();
    if (!d.hands || !d.hands.length) { box.innerHTML = '<div class="adm-empty">没有牌谱</div>'; return; }
    box.innerHTML = `<div class="adm-wallet-h">${escapeHtml(d.displayName)} · 最近 ${d.hands.length} 手</div>` + d.hands.map(h => {
        const when = new Date(h.ts).toLocaleString('zh-CN', { hour12: false });
        const net = h.net || 0;
        const hole = (h.hole || []).join(' ');
        const comm = (h.community || []).join(' ');
        return `<div class="adm-tx" style="grid-template-columns:auto auto 1fr auto">
            <span class="adm-dim">${when}</span>
            <span class="adm-dim">#${escapeHtml(String(h.roomId || ''))}</span>
            <span>${escapeHtml(hole)}${comm ? ` <span class="adm-dim">| ${escapeHtml(comm)}</span>` : ''}</span>
            <span style="color:${net >= 0 ? '#4ade80' : '#f87171'};font-weight:bold">${net >= 0 ? '+' : ''}${net.toLocaleString()}</span>
        </div>`;
    }).join('');
}

// —— 筹码守恒审计：网页直接跑，不必 SSH ——
async function runAdminAudit() {
    const box = document.getElementById('adm-audit');
    const room = document.getElementById('adm-audit-room').value.trim();
    const days = document.getElementById('adm-audit-range').value;
    box.innerHTML = '<div class="adm-empty">审计中…（牌谱多时需要几秒）</div>';
    const res = await admGet('/api/admin/audit?' + (room ? `room=${encodeURIComponent(room)}` : `days=${days}`));
    if (!res.ok) { const e = await res.json().catch(() => ({})); box.innerHTML = `<div class="adm-empty">${escapeHtml(e.error || '审计失败')}</div>`; return; }
    const d = await res.json();
    const head = `<div class="adm-wallet-h">扫描 ${d.scanned} 手 · 合法补码 ${d.rebuys || 0} 处 · 异常 <b style="color:${d.alarms.length ? '#f87171' : '#4ade80'}">${d.alarms.length}</b> 处</div>`;
    if (!d.alarms.length) { box.innerHTML = head + '<div class="adm-empty" style="color:#4ade80">🟢 所有牌局筹码守恒，未发现异常</div>'; return; }
    box.innerHTML = head + d.alarms.map(a => `<div class="adm-room">
        <div class="adm-room-h"><b>房间 ${escapeHtml(String(a.roomId))}</b> <span class="adm-dim">seq ${a.handSeq ?? '-'} · ${new Date(a.ts).toLocaleString('zh-CN', { hour12: false })}</span></div>
        <div style="color:#f87171">凭空 ${a.delta >= 0 ? '+' : ''}${a.delta.toLocaleString()} 筹码</div>
        ${(a.suspects || []).map(s => `<div class="adm-dim">归因：${escapeHtml(s.username)} ${s.diff >= 0 ? '+' : ''}${s.diff.toLocaleString()}</div>`).join('')}
        ${(a.illegal || []).map(x => `<div style="color:#f4d35e;font-size:11px">⚠️ ${escapeHtml(x)}</div>`).join('')}
    </div>`).join('');
}

// —— 发站内信：指定玩家或全体 ——
async function sendAdminMail() {
    const username = document.getElementById('adm-mail-user').value.trim();
    const title = document.getElementById('adm-mail-title').value.trim();
    const text = document.getElementById('adm-mail-text').value.trim();
    if (!text) { admMsg('内容不能为空', false); return; }
    if (!confirm(L(`确认发送给 ${username || '【全体玩家】'}？`, `Send to ${username || 'ALL players'}?`))) return;
    const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admToken()}` },
        body: JSON.stringify({ username: username || undefined, title: title || undefined, text })
    });
    const d = await res.json();
    if (!res.ok) { admMsg(d.error || '发送失败', false); return; }
    admMsg(`已发送给 ${d.target}（${d.sent} 人）`);
    document.getElementById('adm-mail-text').value = '';
}

// —— 房间总览：现在有哪些房在打、谁在里面（免得 SSH 上去翻日志）——
async function loadAdminRooms() {
    const box = document.getElementById('adm-rooms');
    if (!box) return;
    box.innerHTML = '<div class="adm-empty">加载中…</div>';
    const res = await admGet('/api/admin/rooms');
    if (!res.ok) { box.innerHTML = '<div class="adm-empty">加载失败</div>'; return; }
    const d = await res.json();
    document.getElementById('adm-rooms-sum').textContent = `共 ${d.totalRooms} 个房间 · ${d.totalSeated} 人在座`;
    if (!d.rooms.length) { box.innerHTML = '<div class="adm-empty">当前没有房间</div>'; return; }
    box.innerHTML = d.rooms.map(r => {
        const tags = [r.type === 'cash' ? '现金桌' : 'SNG', r.status === 'running' ? '进行中' : r.status === 'finished' ? '已结束' : '等待中'];
        if (r.paused) tags.push('⏸️已暂停');
        if (r.pendingDissolve) tags.push('🛑本手后解散');
        const ps = r.players.map(p => {
            const st = p.standing ? '🧍' : p.away ? '📴' : p.sittingOut ? '💤' : '';
            const net = (p.chips || 0) - (p.buyIn || 0);
            return `<div class="adm-p"><span>${escapeHtml(p.displayName || p.username)}${st}</span>
                <span>${(p.chips || 0).toLocaleString()}</span>
                <span style="color:${net >= 0 ? '#4ade80' : '#f87171'}">${net >= 0 ? '+' : ''}${net.toLocaleString()}</span>
                <span class="adm-dim">${p.handsPlayed || 0}手</span></div>`;
        }).join('') || '<div class="adm-dim">（无人在座）</div>';
        return `<div class="adm-room">
            <div class="adm-room-h"><b>${escapeHtml(r.name)}</b> <span class="adm-dim">#${r.roomId}</span>
                <span class="adm-tags">${tags.join(' · ')}</span></div>
            <div class="adm-dim">盲注 ${r.sb}/${r.bb} · 第 ${r.handSeq} 手 · 底池 ${(r.pot || 0).toLocaleString()}${r.vacatedCount ? ` · 站起 ${r.vacatedCount} 人` : ''}</div>
            <div class="adm-players">${ps}</div>
            <div class="adm-room-act">
                <button onclick="adminEnterRoom('${r.roomId}')">▶️ 免密进入</button>
                <button class="danger" onclick="adminDissolveRoom('${r.roomId}','${encodeURIComponent(r.name)}')">🛑 解散</button>
            </div>
        </div>`;
    }).join('');
}
// 管理员：不用房间码直接进入该房间（进入后关掉管理面板，room_joined 会切到牌桌）
function adminEnterRoom(roomId) {
    if (!socket) return;
    const p = document.getElementById('admin-panel'); if (p) p.style.display = 'none';
    socket.emit('admin_join_room', { roomId });
}
// 管理员：强制解散该房间（进行中等本手打完；现金桌结算筹码+排名）
function adminDissolveRoom(roomId, name) {
    if (!socket) return;
    const nm = name ? decodeURIComponent(name) : roomId;
    if (!confirm(L(`确定解散房间「${nm}」(#${roomId})？\n进行中会等本手打完；现金桌会结算筹码并公布排名。`, `Dissolve room "${nm}" (#${roomId})?\nIn-hand it waits for the hand to finish; cash tables settle chips and post rankings.`))) return;
    socket.emit('admin_dissolve_room', { roomId });
    setTimeout(loadAdminRooms, 1500);   // 稍后刷新列表
}

// —— 钱包流水：某个玩家的每笔金币变动（排查「他的钱怎么变成这样」）——
async function loadAdminWallet(username) {
    const name = username || document.getElementById('adm-wallet-user').value.trim();
    if (!name) return;
    document.getElementById('adm-wallet-user').value = name;
    const box = document.getElementById('adm-wallet');
    box.innerHTML = '<div class="adm-empty">加载中…</div>';
    const res = await admGet(`/api/admin/wallet/${encodeURIComponent(name)}`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); box.innerHTML = `<div class="adm-empty">${escapeHtml(e.error || '加载失败')}</div>`; return; }
    const d = await res.json();
    const rows = d.transactions.map(t => {
        const when = new Date(t.at).toLocaleString('zh-CN', { hour12: false });
        const reason = t.meta && t.meta.reason ? ` · ${escapeHtml(String(t.meta.reason))}` : '';
        return `<div class="adm-tx">
            <span class="adm-dim">${when}</span>
            <span>${escapeHtml(t.typeLabel)}${reason}</span>
            <span style="color:${t.delta >= 0 ? '#4ade80' : '#f87171'};font-weight:bold">${t.delta >= 0 ? '+' : ''}${t.delta.toLocaleString()}</span>
            <span class="adm-dim">→ ${t.balanceAfter.toLocaleString()}</span>
        </div>`;
    }).join('') || '<div class="adm-empty">暂无流水</div>';
    box.innerHTML = `<div class="adm-wallet-h">${escapeHtml(d.displayName)} 当前 <b>${d.gold.toLocaleString()}</b> 金币 · 最近 ${d.transactions.length} 笔</div>
        <div class="adm-adjust">
            <input id="adm-adj-delta" type="number" placeholder="增减额(如 -1651)">
            <input id="adm-adj-reason" placeholder="备注（必填，会留痕）">
            <button onclick="adminAdjustGold('${escapeHtml(d.username)}')">提交调整</button>
        </div>${rows}`;
}

// 带备注的补偿/扣款：走钱包流水留痕，而不是直接把金币改成某个数字
async function adminAdjustGold(username) {
    const delta = parseInt(document.getElementById('adm-adj-delta').value, 10);
    const reason = document.getElementById('adm-adj-reason').value.trim();
    if (!Number.isInteger(delta) || delta === 0) { admMsg('增减额必须是非零整数', false); return; }
    if (!reason) { admMsg('必须填写备注（为什么调整）', false); return; }
    if (!confirm(`确认给 ${username} ${delta > 0 ? '补偿' : '扣除'} ${Math.abs(delta).toLocaleString()} 金币？\n备注：${reason}`)) return;
    const res = await fetch('/api/admin/adjust-gold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admToken()}` },
        body: JSON.stringify({ username, delta, reason, requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    });
    const d = await res.json();
    if (!res.ok) { admMsg(d.error || '调整失败', false); return; }
    admMsg(`${username} ${delta > 0 ? '+' : ''}${delta}，当前 ${d.balance.toLocaleString()} 金币`);
    if (username.toLowerCase() === (myUsername || '').toLowerCase()) { myGold = d.balance; updateUserBar(); }
    loadAdminWallet(username);
}

async function loadAdminUsers() {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const users = await res.json();
    const tbody = document.querySelector('#admin-users-table tbody');
    tbody.innerHTML = users.map(u => `
        <tr>
            <td>${u.username}${u.isAdmin ? ' 👑' : ''}</td>
            <td>${u.gold.toLocaleString()}</td>
            <td><input type="number" id="gold-${u.id}" value="${u.gold}" min="0"></td>
            <td><button onclick="adminSetGold('${u.username}','${u.id}')">确认</button></td>
            <td><button onclick="adminTab('wallet');loadAdminWallet('${u.username}')">💰 流水</button>
                <button onclick="adminTab('hands');loadAdminHands('${u.username}')">📜 牌谱</button></td>
        </tr>`).join('');
}

async function adminSetGold(username, userId) {
    const token = localStorage.getItem('token');
    const gold = parseInt(document.getElementById(`gold-${userId}`).value);
    if (isNaN(gold) || gold < 0) return;
    const res = await fetch('/api/admin/set-gold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username, gold })
    });
    const data = await res.json();
    const msg = document.getElementById('admin-msg');
    if (res.ok) {
        msg.textContent = `✅ ${data.username} 金币已设为 ${data.gold.toLocaleString()}`;
        // 如果改的是自己，更新本地显示
        if (username.toLowerCase() === myUsername.toLowerCase()) {
            myGold = data.gold;
            updateUserBar();
            if (socket) socket.emit('request_gold_sync');
        }
        loadAdminUsers();
    } else {
        msg.textContent = `❌ ${data.error}`;
    }
}


// —— 实时公告：当场弹在玩家屏幕上（不进收件箱）——
// 留空房间号 = 全服，含还在大厅的人。重启通知就该这么发：
// 只发牌桌的话，在大厅等开局的人完全不知道。
async function sendAdminNotice() {
    const roomId = document.getElementById('adm-notice-room').value.trim();
    const text = document.getElementById('adm-notice-text').value.trim();
    if (!text) { admMsg('内容不能为空', false); return; }
    if (!confirm(`确认向 ${roomId ? '房间 ' + roomId : '【全服所有在线玩家】'} 发送？\n\n${text}`)) return;
    const res = await fetch('/api/admin/table-notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admToken()}` },
        body: JSON.stringify({ roomId: roomId || undefined, text })
    });
    const d = await res.json();
    if (!res.ok) { admMsg(d.error || '发送失败', false); return; }
    admMsg(`公告已发送 → ${d.target}`);
    document.getElementById('adm-notice-text').value = '';
}

// —— 运营指标（2026-09-16）——
// 管理面板不翻译（全库唯二不译之一），所以这里直接写中文。
//
// 显示上的两个刻意选择：
// ① 留存给「几分之几」而不只给百分比 —— 现在就几十个用户，
//    一个 2 人的 cohort 里多一个人就是 +50%，光看百分比会对着噪声做决定。
// ② 未到期的 cohort 显示「—」而不是 0 —— 「还不知道」和「一个都没留下」完全不是一回事。
async function loadAdminMetrics() {
    const box = document.getElementById('adm-metrics');
    if (!box) return;
    const days = document.getElementById('adm-mt-days').value || 30;
    box.innerHTML = '<div class="adm-empty">加载中…</div>';
    const res = await admGet('/api/admin/metrics?days=' + days);
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        box.innerHTML = '<div class="adm-empty">' + escapeHtml(e.error || '加载失败') + '</div>';
        return;
    }
    const d = await res.json();
    const sum = document.getElementById('adm-mt-sum');
    if (sum) sum.textContent = '日界线 UTC+' + d.tzOffsetHours + ' · 查询 ' + d.queryMs + 'ms';

    const t = d.totals;
    const card = (label, value, hint) =>
        '<div class="mt-card"><div class="mt-v">' + value + '</div>' +
        '<div class="mt-l">' + label + '</div>' +
        (hint ? '<div class="mt-h">' + hint + '</div>' : '') + '</div>';

    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) + '%' : '—');
    let html = '<div class="mt-cards">'
        + card('用户总数', t.users, t.deletedUsers ? ('已注销 ' + t.deletedUsers) : '')
        + card('7 日活跃', t.active7d, pct(t.active7d, t.users) + ' 的用户')
        + card('30 日活跃', t.active30d, pct(t.active30d, t.users) + ' 的用户')
        + card('总手数', t.hands.toLocaleString(), t.matches + ' 场牙局')
        + card('从没打过牌', t.neverPlayed, pct(t.neverPlayed, t.users) + ' 的注册用户')
        + card('只玩过一天', t.onlyOneDay, '来了一次就没再回来')
        + '</div>';

    // 趋势：条形图直接用 div 宽度画，不引图表库
    // （CSP 只允许几个 CDN，而且为了一排条形图拉一个库不值）。
    const maxHands = Math.max(1, ...d.daily.map(r => r.hands));
    const maxDau = Math.max(1, ...d.daily.map(r => r.dau));
    html += '<div class="adm-wallet-h">每日趋势（最近 ' + d.days + ' 天）</div>';
    html += '<div class="mt-rows">';
    for (const r of [...d.daily].reverse()) {
        const zero = (r.dau === 0 && r.hands === 0) ? ' mt-zero' : '';
        html += '<div class="mt-row' + zero + '">'
            + '<span class="mt-d">' + r.date.slice(5) + '</span>'
            + '<span class="mt-bar"><i style="width:' + Math.round(r.dau / maxDau * 100) + '%"></i></span>'
            + '<span class="mt-n">' + r.dau + ' 人</span>'
            + '<span class="mt-bar mt-bar2"><i style="width:' + Math.round(r.hands / maxHands * 100) + '%"></i></span>'
            + '<span class="mt-n">' + r.hands + ' 手</span>'
            + '<span class="mt-x">' + (r.signups ? '+' + r.signups + ' 新' : '') + '</span>'
            + '</div>';
    }
    html += '</div>';

    // 留存
    const rt = d.retention.filter(r => r.cohort > 0);
    html += '<div class="adm-wallet-h">留存（按注册日）</div>';
    if (!rt.length) {
        html += '<div class="adm-empty">这段时间没有新注册</div>';
    } else {
        html += '<table class="mt-table"><thead><tr><th>注册日</th><th>人数</th>'
            + '<th>次日回来</th><th>7 日回来</th></tr></thead><tbody>';
        const cell = (n, total) => (n === null || n === undefined)
            ? '<td class="mt-na" title="还没到日子，不是 0">—</td>'
            : '<td>' + n + '/' + total + '<span class="mt-h"> ' + pct(n, total) + '</span></td>';
        for (const r of [...rt].reverse()) {
            html += '<tr><td>' + r.date.slice(5) + '</td><td>' + r.cohort + '</td>'
                + cell(r.retained.d1, r.cohort) + cell(r.retained.d7, r.cohort) + '</tr>';
        }
        html += '</tbody></table>';
        html += '<div class="mt-note">活跃 = 当天打过牌 或 签过到。'
            + '「—」= cohort 还没满那么多天，不是 0。</div>';
    }
    box.innerHTML = html;
}

// —— 客户端报错（2026-09-16）——
// 前端 JS 报错原本只在玩家自己的 console 里，服务端一无所知。
// 🔴 每条带【前端构建号】—— 一眼分得出「真 bug」还是「他缓存了旧 JS」，
// 后者占了玩家报障里相当大的一部分。
async function loadAdminErrors() {
    const box = document.getElementById('adm-errors');
    if (!box) return;
    box.innerHTML = '<div class="adm-empty">加载中…</div>';
    const res = await admGet('/api/admin/client-errors');
    if (!res.ok) { box.innerHTML = '<div class="adm-empty">加载失败</div>'; return; }
    const d = await res.json();
    const sum = document.getElementById('adm-err-sum');
    if (sum) sum.textContent = '内存环形缓冲，重启即清 · 当前 ' + d.total + ' 条';
    if (!d.list || !d.list.length) { box.innerHTML = '<div class="adm-empty">没有客户端报错（这是好事）</div>'; return; }
    box.innerHTML = d.list.map(e => {
        const when = new Date(e.at).toLocaleString('zh-CN', { hour12: false });
        return '<div class="adm-err">'
            + '<div class="adm-err-h"><b>' + escapeHtml(e.message) + '</b>'
            + (e.count > 1 ? '<span class="adm-err-n">×' + e.count + '</span>' : '') + '</div>'
            + '<div class="adm-err-m">' + when + ' · ' + escapeHtml(e.username || '(未登录)')
            + ' · 前端 ' + escapeHtml(e.build || '?')
            + ' · ' + escapeHtml(e.source || '') + ':' + e.line + '</div>'
            + (e.stack ? '<pre class="adm-err-s">' + escapeHtml(e.stack.split('\n').slice(0, 4).join('\n')) + '</pre>' : '')
            + '</div>';
    }).join('');
}

// —— 用户来源：地区分布 + 同网段多账号【候选】（2026-09-21）——
// 🔴 界面上必须把「这只是线索」写出来。
//    同 IP 完全不等于同一个人：同宿舍/同公司/同一个家都共享出口 IP，
//    手机运营商的 CGNAT 更是成千上万人共用一个。不写清楚的话，
//    这份名单早晚会被当成「抓到了」拿去封号。
async function loadAdminSources() {
    const box = document.getElementById('adm-sources');
    if (!box) return;
    const days = document.getElementById('adm-src-days').value || 90;
    box.innerHTML = '<div class="adm-empty">加载中…（首次会解析地理位置，稍慢）</div>';
    const res = await admGet('/api/admin/sources?days=' + days);
    if (!res.ok) { box.innerHTML = '<div class="adm-empty">加载失败</div>'; return; }
    const d = await res.json();
    const sum = document.getElementById('adm-src-sum');
    if (sum) sum.textContent = d.pendingGeo ? ('本次新解析 ' + d.pendingGeo + ' 个 IP') : '';
    // 🔴 地理库没装时要把原因说出来 —— 否则就是一片「未知」而没人知道为什么。
    let banner = '';
    if (d.geoUnavailable) {
        banner = '<div class="mt-note" style="color:#f4d35e">⚠️ 服务器上没有地理库（geoip-lite），'
            + '所以地区全显示为「未知」。在 PokerServer 目录下跑 <code>npm install</code> 即可。'
            + '来源 IP 本身照常记录，不受影响。</div>';
    }

    const dist = d.distribution || [];
    const total = dist.reduce((s2, x) => s2 + x.users, 0);
    let html = banner + '<div class="adm-wallet-h">地区分布（最近 ' + d.days + ' 天有过活动的独立账号）</div>';
    if (!dist.length) {
        html += '<div class="adm-empty">还没有数据 —— 从 2026-09-21 才开始记录，等大家下次登录就会出现。</div>';
    } else {
        const max = Math.max(1, ...dist.map(x => x.users));
        html += '<div class="mt-rows">' + dist.map(x =>
            '<div class="mt-row"><span class="mt-d">' + escapeHtml(x.country === '?' ? '未知' : x.country) + '</span>'
            + '<span class="mt-bar"><i style="width:' + Math.round(x.users / max * 100) + '%"></i></span>'
            + '<span class="mt-n">' + x.users + ' 人</span>'
            + '<span class="mt-n">' + (total ? Math.round(x.users / total * 100) : 0) + '%</span>'
            + '<span class="mt-x">' + x.events + ' 次</span></div>').join('') + '</div>';
    }

    const sn = d.sameNetwork || [];
    html += '<div class="adm-wallet-h">同网段多账号（候选）</div>';
    html += '<div class="mt-note">⚠️ <b>这只是线索，不是结论。</b>同宿舍、同公司、同一个家都会共享出口 IP；'
        + '手机运营商的 CGNAT 更是成千上万人共用一个。<b>请人工复核，不要据此自动处置。</b></div>';
    if (!sn.length) {
        html += '<div class="adm-empty">没有同网段出现多个账号</div>';
    } else {
        html += '<table class="mt-table"><thead><tr><th>网段</th><th>账号数</th><th>账号</th></tr></thead><tbody>'
            + sn.map(r => '<tr><td>' + escapeHtml(r.prefix) + '</td><td>' + r.accounts + '</td><td>'
                + r.users.map(u => escapeHtml(u.display_name || u.username)
                    + (u.deleted_at_ms ? '<span class="mt-h">（已注销）</span>' : '')).join('、')
                + '</td></tr>').join('') + '</tbody></table>';
    }
    box.innerHTML = html;
}
