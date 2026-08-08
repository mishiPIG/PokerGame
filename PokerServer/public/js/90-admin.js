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
    ['users', 'rooms', 'wallet'].forEach(t => {
        const pane = document.getElementById('adm-pane-' + t);
        if (pane) pane.style.display = t === name ? '' : 'none';
    });
    document.querySelectorAll('.adm-tab').forEach(b => b.classList.toggle('sel', b.dataset.at === name));
    if (name === 'rooms') loadAdminRooms();
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
        </div>`;
    }).join('');
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
            <td><button onclick="adminTab('wallet');loadAdminWallet('${u.username}')">💰 流水</button></td>
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

