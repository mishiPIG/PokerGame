'use strict';

// 金币变动类型的中文名（钱包流水展示用）
const TX_LABEL = {
    cash_buyin: '现金桌买入', cash_rebuy: '现金桌补码', cash_cashout: '现金桌兑出',
    sng_buyin: 'SNG 报名', sng_refund: 'SNG 退报名费', sng_prize: 'SNG 奖金',
    checkin: '每日签到', admin_adjust: '管理员调整', admin_set_gold: '管理员设置',
    legacy_import: '旧数据迁移', signup_bonus: '注册赠送'
};

function registerAdminRoutes({ app, db, requireAdmin, roomGames }) {
// 获取所有用户列表
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(db.getAllUsers());
});

// 设置任意玩家金币
app.post('/api/admin/set-gold', requireAdmin, (req, res) => {
    const { username, gold, requestId } = req.body || {};
    if (!username || gold === undefined)
        return res.status(400).json({ error: '缺少 username 或 gold' });
    if (!Number.isInteger(gold) || gold < 0)
        return res.status(400).json({ error: 'gold 必须为非负整数' });
    const target = db.getUserByUsername(username);
    if (!target) return res.status(404).json({ error: `用户 "${username}" 不存在` });
    db.setGold(target.id, gold, {
        operationKey: requestId ? `admin-adjust:${req.adminUser.id}:${String(requestId).slice(0, 80)}` : undefined,
        adminUserId: req.adminUser.id,
        reason: 'admin_set_gold'
    });
    console.log(`[admin] ${req.adminUser.username} 将 ${target.username} 金币设为 ${gold}`);
    res.json({ ok: true, username: target.username, gold });
});

// —— 钱包流水：查某个玩家的每笔金币变动（排查「他的钱怎么变成这样」用）——
app.get('/api/admin/wallet/:username', requireAdmin, (req, res) => {
    const target = db.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: `用户 "${req.params.username}" 不存在` });
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const rows = db.raw.prepare(`
        SELECT id, delta, balance_before, balance_after, transaction_type,
               match_id, operation_key, metadata_json, created_at_ms
        FROM wallet_transactions WHERE user_id = ?
        ORDER BY created_at_ms DESC LIMIT ?
    `).all(target.id, limit);
    res.json({
        username: target.username,
        displayName: target.displayName || target.username,
        gold: target.gold,
        transactions: rows.map(r => {
            let meta = null;
            try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : null; } catch (e) { /* 坏数据不影响列表 */ }
            return {
                id: r.id, delta: r.delta, balanceBefore: r.balance_before, balanceAfter: r.balance_after,
                type: r.transaction_type, typeLabel: TX_LABEL[r.transaction_type] || r.transaction_type,
                matchId: r.match_id, at: r.created_at_ms, meta
            };
        })
    });
});

// —— 房间总览：现在有哪些房在打、多少人、什么状态（免得 SSH 上去看日志）——
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
    const rooms = Object.entries(roomGames || {}).map(([roomId, g]) => ({
        roomId,
        name: g.config?.name || roomId,
        type: g.roomType || 'cash',
        status: g.status || 'waiting',
        phase: g.phase,
        handSeq: g.handSeq || 0,
        sb: g.blindLevels?.[g.currentLevel]?.sb ?? g.config?.sb ?? 0,
        bb: g.blindLevels?.[g.currentLevel]?.bb ?? g.config?.bb ?? 0,
        pot: g.pot || 0,
        paused: !!g.paused,
        pendingDissolve: !!g.pendingDissolve,
        players: (g.players || []).map(p => ({
            userId: p.userId, username: p.username, displayName: p.displayName || p.username,
            seat: p.seat, chips: p.chips, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0,
            away: !!p.away, standing: !!p.standing, sittingOut: !!p.sittingOut
        })),
        vacatedCount: (g.vacatedPlayers || []).length
    })).sort((a, b) => b.players.length - a.players.length);
    res.json({ rooms, totalRooms: rooms.length, totalSeated: rooms.reduce((s, r) => s + r.players.length, 0) });
});

// —— 带备注的补偿/扣款：走钱包流水留痕，而不是直接把金币改成某个数字 ——
// 相比 set-gold，这个记录的是「变动多少 + 为什么」，事后可追溯（如线上事故的补偿）。
app.post('/api/admin/adjust-gold', requireAdmin, (req, res) => {
    const { username, delta, reason, requestId } = req.body || {};
    if (!username || delta === undefined) return res.status(400).json({ error: '缺少 username 或 delta' });
    if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: 'delta 必须为非零整数' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: '必须填写备注（为什么调整）' });
    const target = db.getUserByUsername(username);
    if (!target) return res.status(404).json({ error: `用户 "${username}" 不存在` });
    // operationKey 幂等：同一个 requestId 重复提交不会重复扣/发
    const key = `admin-adjust:${req.adminUser.id}:${requestId || Date.now()}`;
    try {
        const r = db.wallet.adjust({
            userId: target.id, delta, type: 'admin_adjust', operationKey: key,
            metadata: { reason: String(reason).slice(0, 200), byAdmin: req.adminUser.username }
        });
        console.log(`[admin] ${req.adminUser.username} 调整 ${target.username} 金币 ${delta > 0 ? '+' : ''}${delta}：${reason}`);
        res.json({ ok: true, username: target.username, delta, balance: r.balance, applied: r.applied });
    } catch (e) {
        if (e.message === 'INSUFFICIENT_GOLD') return res.status(400).json({ error: '扣款会导致金币为负' });
        if (e.message === 'IDEMPOTENCY_CONFLICT') return res.status(409).json({ error: '该 requestId 已用于其他调整' });
        console.error('[admin] adjust-gold 失败', e);
        res.status(500).json({ error: e.message });
    }
});

// —— 玩家牌谱查询：查任意玩家最近的牌局（复用玩家自己的那套聚合逻辑）——
app.get('/api/admin/hands/:username', requireAdmin, (req, res) => {
    const target = db.getUserByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: `用户 "${req.params.username}" 不存在` });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const mode = (req.query.mode === 'sng' || req.query.mode === 'cash') ? req.query.mode : null;
    const room = req.query.room ? String(req.query.room).slice(0, 12) : null;
    // 牌谱是整手的完整记录（seats/results/actions…），这里顺便把「被查玩家自己的」底牌与净盈亏抽出来，
    // 免得前端再去 seats/results 里翻找（翻错就会显示成空白/undefined）。
    const hands = db.getHandsForUser(target.id, { limit, offset, mode, room }).map(h => {
        const seat = (h.seats || []).find(s => s.userId === target.id);
        const r = (h.results || []).find(x => x.userId === target.id);
        const net = (seat && r) ? (r.endChips - seat.startChips) : null;
        return {
            ts: h.ts, roomId: h.roomId, mode: h.mode, handSeq: h.handSeq,
            sb: h.sb, bb: h.bb,
            hole: seat ? seat.hole : [],
            community: h.community || [],
            won: r ? r.won : 0,
            net,
            playerCount: (h.seats || []).length
        };
    });
    res.json({ username: target.username, displayName: target.displayName || target.username, hands });
});

// —— 筹码守恒审计：网页上直接跑，不必 SSH（复用 tools/audit-chips.js 的判定逻辑）——
// 说明：审计是「扑克零和」的结构性检查——单手内 Σ结束筹码 必须等于 Σ开始筹码，
// 不等即有钱凭空出现/消失。合法的手中补码会被单独识别、不算异常。
app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const { spawn } = require('child_process');
    const path = require('path');
    const args = [path.join(__dirname, '..', '..', 'tools', 'audit-chips.js'), '--json'];
    if (req.query.room) args.push('--room', String(req.query.room).slice(0, 12));
    else if (req.query.days) args.push('--days', String(Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7))));
    else args.push('--days', '7');
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..', '..'), timeout: 60000 });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', () => {
        try { res.json(JSON.parse(out)); }
        catch (e) { res.status(500).json({ error: '审计脚本输出无法解析', detail: (err || out).slice(0, 500) }); }
    });
    child.on('error', e => res.status(500).json({ error: '审计脚本启动失败: ' + e.message }));
});

// —— 发站内信：给指定玩家，或全体（公告/维护通知）——
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
    const { username, text, title } = req.body || {};
    const body = String(text || '').trim();
    if (!body) return res.status(400).json({ error: '内容不能为空' });
    if (body.length > 2000) return res.status(400).json({ error: '内容过长（上限 2000 字）' });
    const head = String(title || '📢 系统公告').trim().slice(0, 40);
    const full = `${head}\n\n${body}\n\n—— 来自管理员 ${req.adminUser.username}`;
    let targets;
    if (username) {
        const t = db.getUserByUsername(username);
        if (!t) return res.status(404).json({ error: `用户 "${username}" 不存在` });
        targets = [t];
    } else {
        targets = db.getAllUsers();
    }
    let sent = 0;
    for (const t of targets) { try { db.addMessage(t.id, { type: 'admin', text: full }); sent++; } catch (e) { /* 单个失败不影响其余 */ } }
    console.log(`[admin] ${req.adminUser.username} 发送站内信给 ${username || '全体'}（${sent} 人）`);
    res.json({ ok: true, sent, target: username || '全体' });
});

}

module.exports = { registerAdminRoutes };
