// 轻量 JSON 文件数据库，适合小规模好友场景
// 生产升级时可直接替换为 SQLite/PostgreSQL，对外接口不变
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.json');

function load() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { return { users: {} }; }
}

function save(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
    createUser(username, passwordHash, isAdmin = false, email = null) {
        const data = load();
        const lc = username.toLowerCase();
        if (Object.values(data.users).some(u => u.username.toLowerCase() === lc))
            throw new Error('UNIQUE constraint failed');
        if (email && Object.values(data.users).some(u => (u.email || '').toLowerCase() === email.toLowerCase()))
            throw new Error('EMAIL constraint failed');
        const id = crypto.randomUUID();
        data.users[id] = {
            id,
            username,
            email: email ? email.toLowerCase() : null,
            password_hash: passwordHash,
            gold: 10000,
            isAdmin: isAdmin,
            avatar: null,
            created_at: new Date().toISOString()
        };
        save(data);
        return data.users[id];
    },

    getUserByEmail(email) {
        if (!email) return null;
        const lc = email.toLowerCase();
        return Object.values(load().users).find(u => (u.email || '').toLowerCase() === lc) || null;
    },
    setPassword(id, passwordHash) {
        const data = load();
        if (data.users[id]) { data.users[id].password_hash = passwordHash; save(data); }
    },
    setEmail(id, email) {
        const data = load();
        if (data.users[id]) { data.users[id].email = email ? email.toLowerCase() : null; save(data); }
    },

    // 站内消息（收件箱）：比赛结束/排名等发给玩家（含离线/已离开者）
    addMessage(userId, msg) {
        const data = load();
        const u = data.users[userId];
        if (!u) return;
        if (!u.messages) u.messages = [];
        u.messages.push({ id: crypto.randomUUID(), ts: Date.now(), read: false, ...msg });
        if (u.messages.length > 100) u.messages = u.messages.slice(-100);   // 上限 100 条
        save(data);
    },
    getMessages(userId) {
        const u = load().users[userId];
        return (u && u.messages) ? u.messages.slice().reverse() : [];   // 新的在前
    },
    markMessagesRead(userId) {
        const data = load();
        const u = data.users[userId];
        if (u && u.messages) { u.messages.forEach(m => m.read = true); save(data); }
    },

    setAvatar(id, avatar) {
        const data = load();
        if (data.users[id]) { data.users[id].avatar = avatar; save(data); }
    },

    getUserByUsername(username) {
        const lc = username.toLowerCase();
        return Object.values(load().users).find(u => u.username.toLowerCase() === lc) || null;
    },

    getUserById(id) {
        return load().users[id] || null;
    },

    setGold(id, gold) {
        const data = load();
        if (data.users[id]) { data.users[id].gold = gold; save(data); }
    },

    setAdmin(id, isAdmin) {
        const data = load();
        if (data.users[id]) { data.users[id].isAdmin = isAdmin; save(data); }
    },

    getAllUsers() {
        return Object.values(load().users).map(({ id, username, gold, isAdmin }) =>
            ({ id, username, gold, isAdmin: !!isAdmin })
        );
    },

    // 牌谱：每手一行追加到 hands.jsonl（JSON Lines，按时序、便于按 玩家×模式 筛选；量大可换 DB）
    appendHand(record) {
        try { fs.appendFileSync(path.join(__dirname, 'hands.jsonl'), JSON.stringify(record) + '\n'); }
        catch (e) { console.error('appendHand failed', e.message); }
    },

    // 读取某玩家参与的最近 N 手牌谱（按时序倒序）；可按模式筛选
    getHandsForUser(userId, { limit = 30, mode = null } = {}) {
        const file = path.join(__dirname, 'hands.jsonl');
        if (!fs.existsSync(file)) return [];
        let lines;
        try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
        catch { return []; }
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            let h;
            try { h = JSON.parse(lines[i]); } catch { continue; }
            if (mode && h.mode !== mode) continue;
            if (!h.seats || !h.seats.some(s => s.userId === userId)) continue;
            out.push(h);
        }
        return out;
    }
};
