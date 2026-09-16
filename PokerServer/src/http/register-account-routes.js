'use strict';

const buildInfo = require('../build-info');
const { findBlockingRoom } = require('../account/deletion-guards');

function registerAccountRoutes({ app, db, stats, mailer, requireAuth, requireAdmin, bcrypt, roomGames }) {
// 版本信息（公开，不需要登录）：部署脚本和玩家报 bug 都靠它对上是哪一版。
// 客户端会把它和【打包进前端 JS 的构建号】一起显示 —— 两者不一致就说明玩家
// 的浏览器/APK WebView 缓存了旧前端（薄壳架构下这是最常见的「我这边复现不了」）。
app.get('/api/version', (req, res) => {
    res.json({
        version: buildInfo.version,
        commit: buildInfo.commit,
        builtAt: buildInfo.builtAt,
        env: buildInfo.env,
        label: buildInfo.label,
        uptimeSec: Math.floor((Date.now() - buildInfo.startedAt) / 1000)
    });
});

app.get('/api/my-hands', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const mode = (req.query.mode === 'sng' || req.query.mode === 'cash') ? req.query.mode : null;
    const room = req.query.room ? String(req.query.room).slice(0, 12) : null;
    res.json(db.getHandsForUser(req.authUser.id, { limit, offset, mode, room }));
});

// 当前账号信息（含邮箱，供个人主页显示/更换邮箱）
app.get('/api/me', requireAuth, (req, res) => {
    const u = req.authUser;
    res.json({ id: u.id, username: u.username, displayName: u.displayName, displayNameChangedAtMs: u.displayNameChangedAtMs, gold: u.gold, email: u.email || null, isAdmin: !!u.isAdmin });
});

// 我的生涯统计（从牌谱聚合 VPIP/PFR/3bet/AF/WTSD…，可按 mode 筛选）
app.get('/api/my-stats', requireAuth, (req, res) => {
    res.json(stats.computeUserStats(req.authUser.id, req.query.mode));
});

// 我的站内消息（收件箱）：比赛结束排名等
app.get('/api/my-messages', requireAuth, (req, res) => {
    res.json(db.getMessages(req.authUser.id));
});
app.post('/api/messages/read', requireAuth, (req, res) => {
    db.markMessagesRead(req.authUser.id);
    res.json({ ok: true });
});

// ===== 每日签到（连续签到递增奖励，断签重置）=====
// 奖励表：第 1~7 天，第 7 天后封顶 1000。均值≈543/天，鼓励每日回访。可自由调。
const CHECKIN_REWARDS = [200, 300, 400, 500, 600, 800, 1000];
const rewardForStreak = s => CHECKIN_REWARDS[Math.min(Math.max(s, 1), 7) - 1];
// 以香港时间(UTC+8)为「日」边界，服务器时区无关
const dayStr = (offsetDays = 0) =>
    new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);

app.get('/api/checkin/status', requireAuth, (req, res) => {
    const u = req.authUser;
    const today = dayStr(0);
    const claimed = u.lastCheckin === today;
    const curStreak = u.checkinStreak || 0;
    // 未签到时预告：昨天签过则 streak+1，否则重置为 1
    const nextStreak = claimed ? curStreak : (u.lastCheckin === dayStr(1) ? curStreak + 1 : 1);
    res.json({
        claimed,
        streak: claimed ? curStreak : (u.lastCheckin === dayStr(1) ? curStreak : 0),
        todayReward: rewardForStreak(nextStreak),
        rewards: CHECKIN_REWARDS,
        gold: u.gold
    });
});

app.post('/api/checkin', requireAuth, (req, res) => {
    const u = req.authUser;
    const today = dayStr(0);
    if (u.lastCheckin === today) return res.status(400).json({ error: '今日已签到', k: 'checkedIn' });
    const streak = (u.lastCheckin === dayStr(1) ? (u.checkinStreak || 0) : 0) + 1;
    const reward = rewardForStreak(streak);
    let gold;
    try {
        gold = db.applyCheckin(u.id, today, streak, reward);
    } catch (error) {
        if (error.message === 'ALREADY_CHECKED_IN') return res.status(400).json({ error: '今日已签到', k: 'checkedIn' });
        throw error;
    }
    console.log(`[checkin] ${u.username} 连续${streak}天 +${reward} → ${gold}`);
    res.json({ ok: true, reward, streak, gold });
});

// ===== Bug / 建议反馈 =====
app.post('/api/feedback', requireAuth, (req, res) => {
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: '请填写反馈内容', k: 'feedbackEmpty' });
    if (text.length > 2000) return res.status(400).json({ error: '内容过长（≤2000字）', k: 'feedbackLong' });
    const rec = {
        ts: Date.now(),
        userId: req.authUser.id,
        username: req.authUser.username,
        text: text.slice(0, 2000),
        contact: (req.body?.contact || '').toString().slice(0, 120),
        ua: (req.headers['user-agent'] || '').slice(0, 200),
        // 版本自动附带：指望玩家自己去设置面板翻出版本号复制过来，基本不会发生。
        // serverVersion = 收到反馈时线上跑的版本；clientBuild = 他浏览器里那份前端的构建号。
        // 两者不一致 = 他用的是缓存的旧前端，很多「复现不了」的反馈都是这个原因。
        serverVersion: buildInfo.label,
        clientBuild: (req.body?.clientBuild || '').toString().slice(0, 40) || 'unknown'
    };
    db.appendFeedback(rec);
    console.log(`[feedback] ${req.authUser.username}: ${text.slice(0, 80)}`);
    // 同时发一封到管理员邮箱（异步，失败不影响提交）
    mailer.sendFeedback(rec).catch(e => console.error('反馈邮件发送失败', e.message));
    res.json({ ok: true });
});
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
    res.json(db.getFeedback(Math.min(parseInt(req.query.limit) || 200, 500)));
});

// ===== 注销账号（2026-09-16）=====
// 上架 Google Play / App Store 硬性要求 App 内能删除账号。
// 策略（删什么、留什么、为什么）全部写在 storage/account-deletion-repository.js 的开头，
// 动这块之前先读那段 —— 数据删了就回不来了。
//
// 删之前三道闸：① 不在牌局里（见 account/deletion-guards.js）② 重输密码 ③ 不是最后一个管理员

app.post('/api/account/delete', requireAuth, async (req, res) => {
    // requireAuth 已经把完整的 user 放在 req.authUser 上了（注意不是 req.user），
    // 而且它查不到人就直接 401 —— 这正好顺带保证了【注销后旧 token 立刻作废】：
    // JWT 本身没过期，但库里那行已经被 deleted_at_ms 滤掉了，换不到任何东西。
    const user = req.authUser;

    // ② 必须重新输一次密码。删号不可撤销，而一个被人捡到的已登录设备
    //    不该能把整个账号抹掉 —— 这道闸挡的是「会话被盗用」，不是「忘了自己是谁」。
    const password = String((req.body || {}).password || '');
    if (!password) return res.status(400).json({ error: '请输入密码以确认注销', k: 'delNeedPwd' });
    let ok = false;
    try { ok = await bcrypt.compare(password, user.password_hash); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: '密码不正确', k: 'delBadPwd' });

    const room = findBlockingRoom(roomGames, user.id);
    if (room) return res.status(409).json({
        error: '你还在牌局 ' + room + ' 里，请先退出并结算后再注销', k: 'delInRoom' });

    // ③ 最后一个管理员不许把自己删了 —— 删完就再也进不了管理面板，
    //    只能 SSH 上服务器跑 create-admin.js 才能救回来。
    if (user.isAdmin) {
        const admins = db.getAllUsers().filter(u => u.isAdmin).length;
        if (admins <= 1) return res.status(409).json({ error: '你是唯一的管理员，请先指定另一位管理员', k: 'delLastAdmin' });
    }

    const result = db.accountDeletion.anonymizeIdentity(user.id);
    if (!result.ok) return res.status(409).json({ error: '注销失败：' + result.reason, k: 'delFailed' });
    console.log('[account] 账号已注销 user=' + user.id + ' -> ' + result.handle);

    // 身份已经销毁（登录立刻失效），剩下的牌谱擦除分批做。
    // **每批之间让出事件循环** —— 上万手牌一口气擦会把服务卡住几百毫秒，
    // 而本项目的底线是绝不能影响正在进行的牌局。
    // 中途断了也不要紧：擦除是幂等的，启动时的清扫会接着擦完。
    let scrubbed = 0;
    try {
        for (let i = 0; i < 400; i++) {
            const n = db.accountDeletion.scrubHandBatch(user.id, result.handle);
            scrubbed += n;
            if (n === 0) break;
            await new Promise(r => setImmediate(r));
        }
    } catch (e) {
        console.error('[account] 牌谱擦除中断（启动清扫会接着做）', e.message);
    }
    const remaining = db.accountDeletion.pendingHandCount(user.id, result.handle);
    console.log('[account] 牌谱匿名化 已擦 ' + scrubbed + ' 手，剩余 ' + remaining);
    res.json({ ok: true, handle: result.handle, scrubbed, remaining });
});

}

module.exports = { registerAccountRoutes };
