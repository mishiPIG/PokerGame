// ===== Admin =====
let isAdmin = false;

function toggleAdminPanel() {
    const panel = document.getElementById('admin-panel');
    const visible = panel.style.display !== 'none';
    if (!visible) loadAdminUsers();
    panel.style.display = visible ? 'none' : '';
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

