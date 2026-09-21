'use strict';

// 金币变动类型的中文名（钱包流水展示用）
const TX_LABEL = {
    cash_buyin: '现金桌买入', cash_rebuy: '现金桌补码', cash_cashout: '现金桌兑出',
    sng_buyin: 'SNG 报名', sng_refund: 'SNG 退报名费', sng_prize: 'SNG 奖金',
    checkin: '每日签到', admin_adjust: '管理员调整', admin_set_gold: '管理员设置',
    legacy_import: '旧数据迁移', signup_bonus: '注册赠送'
};

function registerAdminRoutes({ app, db, requireAdmin, roomGames, io, clientErrors }) {
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


// 实时公告：**当场弹在屏幕上**，不是站内信。
// 🔴 为什么要有这条：/api/admin/broadcast 只写 📬 收件箱，正在打牌的人当场看不到。
//    2026-08-10 要通知玩家重启时撞过一次（只能靠站内信 + 口头说），
//    2026-09-16 又撞了一次 —— 想上生产，可三个人正在 preflop，
//    只剩「干等」或「硬切掉他们」两个选择。这条给出第三条路：先说一声。
// 公告内容是管理员自由输入的，**不翻译**（和房间名同理，属于用户自输内容）；
// 客户端只负责把它显示出来。
app.post('/api/admin/table-notice', requireAdmin, (req, res) => {
    const { roomId, text } = req.body || {};
    const body = String(text || '').trim().slice(0, 200);
    if (!body) return res.status(400).json({ error: '内容不能为空' });
    const payload = { text: body, from: req.adminUser.username, at: Date.now() };

    if (roomId) {
        const rid = String(roomId).trim();
        if (!roomGames[rid]) return res.status(404).json({ error: `房间 ${rid} 不存在或已结束` });
        io.in(rid).emit('admin_notice', payload);
        console.log(`[admin] ${req.adminUser.username} 向房间 ${rid} 发公告: ${body}`);
        return res.json({ ok: true, target: `房间 ${rid}` });
    }
    // 不指定房间 = 全服（含大厅里的人）。重启通知正是这一种：
    // 只发给牌桌的话，在大厅等着开局的人完全不知道。
    io.emit('admin_notice', payload);
    console.log(`[admin] ${req.adminUser.username} 向全服发公告: ${body}`);
    res.json({ ok: true, target: '全服' });
});

// 最近的客户端报错（内存环形缓冲，重启即清）。
// 每条带【前端构建号】—— 一眼分得出「真 bug」还是「他缓存了旧 JS」，
// 后者占了玩家报障里相当大的一部分。
// 用户来源：地区分布 + 同网段多账号【候选】（2026-09-21）。
//
// 🔴 地理解析走【一次性子进程】（tools/geo-lookup.js），因为 geoip-lite 一 require
//    就吃 +108MB 常驻内存，而生产是 1GB 的 t3.micro。结果写进 ip_geo 缓存，
//    每个 IP 只解析一次。解析失败不影响接口 —— 显示「未知」比让面板 500 诚实。
app.get('/api/admin/sources', requireAdmin, (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
    try {
        const pending = db.loginEvents.unresolvedIps({ limit: 300 });
        let geoUnavailable = false;
        if (pending.length) {
            try {
                const r = require('child_process').spawnSync(process.execPath,
                    [require('path').join(__dirname, '../../tools/geo-lookup.js')],
                    { input: JSON.stringify(pending), encoding: 'utf8', timeout: 20000 });
                if (r.status === 3) geoUnavailable = true;   // 地理库没装
                // 🔴 库没装的时候【绝对不能把这批 null 写进缓存】。
                //    unresolvedIps 的判据是「ip_geo 里没有这一行」，一旦写进去，
                //    这些 IP 就永远不会再被重查 —— 于是只要管理员在装库之前点开过
                //    一次这个页面，那批 IP 就被【永久钉死成「未知」】，以后装了库也没用。
                //    null 在这里有两种含义，必须分开：
                //      「查过了，查不到」→ 该缓存（否则每次都重复去查同一批）
                //      「没法查（库没装）」→ 绝不能缓存
                //    把后者当成前者，就是又一次「我不知道」被悄悄写成了一个确定答案
                //    （同部署自查那次把取不到的基准 echo 成 0）。
                if (r.stdout && !geoUnavailable) db.loginEvents.saveGeo(JSON.parse(r.stdout));
            } catch (e) {
                console.error('[admin] 地理解析失败（不影响列表）', e.message);
            }
        }
        res.json({
            days,
            distribution: db.loginEvents.distributionByCountry({ days }),
            // ⬇️ 叫 candidates 不叫 matches：同网段只是线索，不是结论。
            sameNetwork: db.loginEvents.sameNetworkCandidates({ minAccounts: 2, days }),
            pendingGeo: pending.length,
            // 🔴 把「地理库没装」告诉前端。静默降级成一片「未知」
            // 而不说原因，和「只写日志没人读的检查」是同一个毛病。
            geoUnavailable,
        });
    } catch (e) {
        console.error('[admin] sources 失败', e);
        res.status(500).json({ error: '查询失败：' + e.message });
    }
});

app.get('/api/admin/client-errors', requireAdmin, (req, res) => {
    res.json({ total: clientErrors ? clientErrors.size() : 0, list: clientErrors ? clientErrors.list() : [] });
});

// 运营指标：这个产品到底有没有人在用。
// ROADMAP 的结论是核心风险已从「牌局出错」变成「做了没人用」，而我们一个能回答
// 这件事的数字都没有 —— 只能靠「最近好像没人反馈」这种体感。
// 口径与日界线（显式 UTC+8）全在 metrics-repository.js 里，那里也说明了为什么。
app.get('/api/admin/metrics', requireAdmin, (req, res) => {
    // 上限 180 天：这几条查询会扫全量 hand_players，别让一个手抖的 ?days=99999
    // 把生产库拖住（管理员接口也一样要设上限）。
    const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
    try {
        const t0 = Date.now();
        const payload = {
            days,
            tzOffsetHours: db.metrics.TZ_OFFSET_HOURS,
            generatedAt: Date.now(),
            totals: db.metrics.totals(),
            daily: db.metrics.daily({ days }),
            retention: db.metrics.retention({ days }),
        };
        payload.queryMs = Date.now() - t0;
        res.json(payload);
    } catch (e) {
        console.error('[admin] metrics 失败', e);
        res.status(500).json({ error: '统计失败：' + e.message });
    }
});

}

module.exports = { registerAdminRoutes };
