'use strict';

const buildInfo = require('../build-info');

function registerAccountRoutes({ app, db, stats, mailer, requireAuth, requireAdmin }) {
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
    if (u.lastCheckin === today) return res.status(400).json({ error: '今日已签到' });
    const streak = (u.lastCheckin === dayStr(1) ? (u.checkinStreak || 0) : 0) + 1;
    const reward = rewardForStreak(streak);
    let gold;
    try {
        gold = db.applyCheckin(u.id, today, streak, reward);
    } catch (error) {
        if (error.message === 'ALREADY_CHECKED_IN') return res.status(400).json({ error: '今日已签到' });
        throw error;
    }
    console.log(`[checkin] ${u.username} 连续${streak}天 +${reward} → ${gold}`);
    res.json({ ok: true, reward, streak, gold });
});

// ===== Bug / 建议反馈 =====
app.post('/api/feedback', requireAuth, (req, res) => {
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: '请填写反馈内容' });
    if (text.length > 2000) return res.status(400).json({ error: '内容过长（≤2000字）' });
    const rec = {
        ts: Date.now(),
        userId: req.authUser.id,
        username: req.authUser.username,
        text: text.slice(0, 2000),
        contact: (req.body?.contact || '').toString().slice(0, 120),
        ua: (req.headers['user-agent'] || '').slice(0, 200)
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

}

module.exports = { registerAccountRoutes };
