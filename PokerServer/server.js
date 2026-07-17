const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Deck, HandEvaluator } = require('./PokerLogic');
const db = require('./database');
const stats = require('./stats');
const equity = require('./equity');
const mailer = require('./mailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
// 本地开发模式必须显式开启（npm run dev），生产/测试服默认永不开启。
const LOCAL_DEV = process.env.LOCAL_DEV === '1';
app.use(express.json());
app.use('/avatars', express.static(__dirname + '/avatars'));   // 本地头像图片
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const PHASES = {
    WAITING:  'waiting',
    PREFLOP:  'preflop',
    FLOP:     'flop',
    TURN:     'turn',
    RIVER:    'river',
    SHOWDOWN: 'showdown'
};

const DEFAULT_SMALL_BLIND = 10;
const DEFAULT_BIG_BLIND   = 20;
// JWT 私章：优先环境变量；否则用本地 secret.key（不进 git、部署不覆盖，像 data.json）；
// 首次缺失则自动生成强随机密钥并落盘。绝不使用写死在代码里的默认值（公开仓库可见 → 可伪造令牌）
const JWT_SECRET = (() => {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
    const keyPath = path.join(__dirname, 'secret.key');
    try {
        if (fs.existsSync(keyPath)) {
            const k = fs.readFileSync(keyPath, 'utf8').trim();
            if (k.length >= 16) return k;
        }
    } catch {}
    const k = crypto.randomBytes(48).toString('hex');   // 96 位十六进制强随机
    try { fs.writeFileSync(keyPath, k, { mode: 0o600 }); console.log('🔐 已生成新的 JWT 私章 secret.key（旧登录令牌将失效，需重新登录一次）'); }
    catch (e) { console.error('⚠️ 无法写入 secret.key，本次用内存随机密钥（重启会掉登录）：', e.message); }
    return k;
})();

// 仅供本机联调：每次 npm run dev 保证两个双人测试账号可登录。
// 此分支受 LOCAL_DEV 显式环境变量保护，普通 node server.js / pm2 都不会执行。
if (LOCAL_DEV) {
    for (const [username, password] of [['test', 'test'], ['test2', 'test2']]) {
        const hash = bcrypt.hashSync(password, 8);
        const existing = db.getUserByUsername(username);
        if (existing) db.setPassword(existing.id, hash);
        else db.createUser(username, hash, false, null);
    }
    console.log('🧪 本地开发账号已就绪：test / test，test2 / test2');
}

// 标准 SNG 升盲表（级别 0 起，初始 25/50；SB=BB/2，每级 BB ×1.3~1.5 取整，行业标准结构）
const STANDARD_BLIND_LEVELS = [
    { sb: 25,   bb: 50   },
    { sb: 50,   bb: 100  },
    { sb: 75,   bb: 150  },
    { sb: 100,  bb: 200  },
    { sb: 150,  bb: 300  },
    { sb: 200,  bb: 400  },
    { sb: 300,  bb: 600  },
    { sb: 400,  bb: 800  },
    { sb: 500,  bb: 1000 },
    { sb: 600,  bb: 1200 },
    { sb: 800,  bb: 1600 },
    { sb: 1000, bb: 2000 },
    { sb: 1500, bb: 3000 },
    { sb: 2000, bb: 4000 },
    { sb: 3000, bb: 6000 }
];
const INITIAL_BB = STANDARD_BLIND_LEVELS[0].bb;   // 200BB 计算基准（默认初始记分牌 10000 = 200BB）

// 当前房间的盲注：现金桌用固定配置；SNG 按当前级别；否则默认
function gameSB(game) {
    if (game.roomType === 'cash') return game.config.sb;
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].sb;
    return DEFAULT_SMALL_BLIND;
}
function gameBB(game) {
    if (game.roomType === 'cash') return game.config.bb;
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].bb;
    return DEFAULT_BIG_BLIND;
}
function gameAnte(game) {
    return (game.roomType === 'cash' && game.config.ante) ? game.config.ante : 0;
}

// 行动思考时间（毫秒）
const ACTION_TIME = 15000;    // 初始 15s
const EXTRA_STEP  = 15000;    // 每次加时 +15s
const EXTRA_MAX   = 120000;   // 单次行动累计加时上限 2min
const RUNOUT_DELAY = 1400;    // all-in 摊牌跑马，每条街发牌间隔
const FIXED_BUYIN  = 50;      // 旧默认（保留兼容）
const SNG_BUYIN_TIERS = [110, 220, 550, 1100];   // SNG 报名费档位（2 人冠军得 200/400/1000/2000）
// SNG 冠军实得 = 奖池 × 10/11（平台抽 1/11 ≈ 9%）：110×2=220→200，1100×2=2200→2000
function sngPrize(pool) { return Math.floor((pool || 0) * 10 / 11); }
// 现金桌金币↔筹码汇率（含 ~10% 抽水）：买入 0.11 金币/筹码，兑出 0.10 金币/筹码
const BUYIN_RATE   = 0.11;    // 例：110 金币 → 1000 筹码
const CASHOUT_RATE = 0.10;    // 例：1000 筹码 → 100 金币

const roomGames = {};

// ===== Admin middleware =====

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        const user = db.getUserById(payload.id);
        if (!user?.isAdmin) return res.status(403).json({ error: '无管理员权限' });
        req.adminUser = user;
        next();
    } catch {
        res.status(401).json({ error: '登录已过期' });
    }
}

// 获取所有用户列表
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(db.getAllUsers());
});

// 设置任意玩家金币
app.post('/api/admin/set-gold', requireAdmin, (req, res) => {
    const { username, gold } = req.body || {};
    if (!username || gold === undefined)
        return res.status(400).json({ error: '缺少 username 或 gold' });
    if (!Number.isInteger(gold) || gold < 0)
        return res.status(400).json({ error: 'gold 必须为非负整数' });
    const target = db.getUserByUsername(username);
    if (!target) return res.status(404).json({ error: `用户 "${username}" 不存在` });
    db.setGold(target.id, gold);
    console.log(`[admin] ${req.adminUser.username} 将 ${target.username} 金币设为 ${gold}`);
    res.json({ ok: true, username: target.username, gold });
});

// 任意登录用户：解析 JWT
function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        const user = db.getUserById(payload.id);
        if (!user) return res.status(401).json({ error: '用户不存在' });
        req.authUser = user;
        next();
    } catch { res.status(401).json({ error: '登录已过期' }); }
}

// ===== 桌内临时语音 =====
// 语音只用于当前牌桌的短暂互动：不进聊天历史、不备份、不进数据库。
// 服务器重启时直接清空；正常运行时 1 小时过期，定时物理删除。
const VOICE_DIR = path.join(__dirname, 'voice_tmp');
const VOICE_TTL_MS = 60 * 60 * 1000;
const VOICE_SWEEP_MS = 5 * 60 * 1000;
const VOICE_BUBBLE_MS = 10000;
const VOICE_MAX_DURATION_MS = 15000;
const VOICE_MAX_BYTES = 512 * 1024;
const VOICE_DIR_MAX_BYTES = 200 * 1024 * 1024;
const VOICE_MAX_PER_HOUR = 60;
const VOICE_UPLOAD_GAP_MS = 3000;
const VOICE_MAX_CONCURRENT_UPLOADS = 12;
const VOICE_MAX_PER_USER_UPLOADS = 2;
const VOICE_UPLOAD_TIMEOUT_MS = 10000;
const VOICE_MIMES = new Map([
    ['audio/mp4', 'm4a'], ['audio/aac', 'aac'], ['audio/mpeg', 'mp3'],
    ['audio/webm', 'webm'], ['audio/ogg', 'ogg']
]);
const voiceEntries = new Map();
const voiceRate = new Map();
const voiceUserUploads = new Map();
let voiceBytes = 0;
let voiceUploadsInFlight = 0;
let musicMetadataModule = null;

function resetVoiceTempDir() {
    try {
        fs.rmSync(VOICE_DIR, { recursive: true, force: true });
        fs.mkdirSync(VOICE_DIR, { recursive: true, mode: 0o700 });
    } catch (e) {
        console.error('⚠️ 无法初始化临时语音目录：', e.message);
    }
}

function removeVoiceEntry(id) {
    const entry = voiceEntries.get(id);
    if (!entry) return;
    voiceEntries.delete(id);
    voiceBytes = Math.max(0, voiceBytes - entry.size);
    try { fs.unlinkSync(entry.file); } catch (e) { if (e.code !== 'ENOENT') console.warn('[voice] 删除失败：', e.message); }
}

function sweepExpiredVoices(now = Date.now()) {
    for (const [id, entry] of voiceEntries) {
        if (entry.expiresAt <= now) removeVoiceEntry(id);
    }
}

function userIsConnectedToRoom(userId, roomId) {
    const members = io.sockets.adapter.rooms.get(roomId);
    if (!members) return false;
    for (const sid of members) {
        const s = io.sockets.sockets.get(sid);
        if (s?.user?.id === userId && s.currentRoom === roomId) return true;
    }
    return false;
}

function voicePublicMessage(entry) {
    return {
        id: entry.id, userId: entry.userId, username: entry.username,
        durationMs: entry.durationMs, expiresAt: entry.expiresAt,
        bubbleUntil: entry.bubbleUntil
    };
}

function syncRecentVoices(socket, roomId) {
    const now = Date.now();
    for (const entry of voiceEntries.values()) {
        if (entry.roomId === roomId && entry.bubbleUntil > now)
            socket.emit('voice_broadcast', voicePublicMessage(entry));
    }
}

function allowVoiceUpload(userId, now = Date.now()) {
    let rate = voiceRate.get(userId);
    if (!rate || now - rate.windowStart >= 60 * 60 * 1000) {
        rate = { windowStart: now, count: 0, lastAt: 0 };
    }
    if (now - rate.lastAt < VOICE_UPLOAD_GAP_MS || rate.count >= VOICE_MAX_PER_HOUR) return false;
    rate.lastAt = now;
    rate.count++;
    voiceRate.set(userId, rate);
    return true;
}

async function actualVoiceDurationMs(buffer, mime) {
    musicMetadataModule ||= await import('music-metadata');
    const metadata = await musicMetadataModule.parseBuffer(
        buffer,
        { mimeType: mime, size: buffer.length },
        { duration: true, skipCovers: true }
    );
    const seconds = metadata?.format?.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('NO_DURATION');
    return Math.round(seconds * 1000);
}

function voiceUploadGate(req, res, next) {
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isInteger(contentLength) || contentLength <= 0)
        return res.status(411).json({ error: '语音上传必须声明文件大小' });
    if (contentLength > VOICE_MAX_BYTES)
        return res.status(413).json({ error: '语音文件过大' });
    if (voiceUploadsInFlight >= VOICE_MAX_CONCURRENT_UPLOADS)
        return res.status(503).json({ error: '当前语音上传较多，请稍后再试' });
    const userId = req.authUser.id;
    const userCount = voiceUserUploads.get(userId) || 0;
    if (userCount >= VOICE_MAX_PER_USER_UPLOADS)
        return res.status(429).json({ error: '同一账号最多同时上传 2 条语音' });
    voiceUploadsInFlight++;
    voiceUserUploads.set(userId, userCount + 1);
    let released = false;
    const timeout = setTimeout(() => {
        if (!released) req.destroy();       // 绝对时限，慢速持续传输也不能续期
    }, VOICE_UPLOAD_TIMEOUT_MS);
    timeout.unref?.();
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timeout);
        voiceUploadsInFlight--;
        const left = (voiceUserUploads.get(userId) || 1) - 1;
        if (left > 0) voiceUserUploads.set(userId, left); else voiceUserUploads.delete(userId);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
}

resetVoiceTempDir();
const voiceSweepTimer = setInterval(() => sweepExpiredVoices(), VOICE_SWEEP_MS);
voiceSweepTimer.unref?.();

app.post('/api/voice', requireAuth, voiceUploadGate,
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: VOICE_MAX_BYTES }),
    async (req, res) => {
        const roomId = String(req.headers['x-room-id'] || '');
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!roomGames[roomId] || !userIsConnectedToRoom(req.authUser.id, roomId))
            return res.status(403).json({ error: '你已不在该房间' });
        if (!VOICE_MIMES.has(mime)) return res.status(415).json({ error: '不支持的录音格式' });
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > VOICE_MAX_BYTES)
            return res.status(400).json({ error: '语音文件为空或过大' });
        let durationMs;
        try { durationMs = await actualVoiceDurationMs(req.body, mime); }
        catch { return res.status(422).json({ error: '无法解析语音真实时长' }); }
        if (durationMs < 300 || durationMs > VOICE_MAX_DURATION_MS)
            return res.status(400).json({ error: '语音时长必须在 0.3～15 秒之间' });
        if (!allowVoiceUpload(req.authUser.id))
            return res.status(429).json({ error: '发送太频繁，请稍后再试' });

        sweepExpiredVoices();
        if (voiceBytes + req.body.length > VOICE_DIR_MAX_BYTES)
            return res.status(507).json({ error: '临时语音空间已满，请稍后再试' });

        const id = crypto.randomBytes(16).toString('hex');
        const file = path.join(VOICE_DIR, `${id}.${VOICE_MIMES.get(mime)}`);
        const now = Date.now();
        try {
            fs.writeFileSync(file, req.body, { mode: 0o600, flag: 'wx' });
        } catch (e) {
            console.error('[voice] 写入失败：', e.message);
            return res.status(500).json({ error: '语音保存失败' });
        }
        const entry = {
            id, roomId, userId: req.authUser.id, username: req.authUser.username,
            file, mime, size: req.body.length, durationMs,
            createdAt: now, expiresAt: now + VOICE_TTL_MS,
            bubbleUntil: now + VOICE_BUBBLE_MS
        };
        voiceEntries.set(id, entry);
        voiceBytes += entry.size;
        io.in(roomId).emit('voice_broadcast', voicePublicMessage(entry));
        res.status(201).json({ ok: true, id, expiresAt: entry.expiresAt });
    }
);

app.get('/api/voice/:id', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).json({ error: '语音不存在' });
    const entry = voiceEntries.get(id);
    if (!entry) return res.status(404).json({ error: '语音已失效' });
    if (entry.expiresAt <= Date.now()) {
        removeVoiceEntry(id);
        return res.status(410).json({ error: '语音已过期' });
    }
    if (!userIsConnectedToRoom(req.authUser.id, entry.roomId))
        return res.status(403).json({ error: '仅当前房间成员可播放' });
    res.set('Cache-Control', 'private, no-store');
    res.type(entry.mime);
    res.sendFile(entry.file);
});

// 我的牌谱（最近若干手，可按 mode=sng|cash 筛选）
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
    res.json({ id: u.id, username: u.username, gold: u.gold, email: u.email || null, isAdmin: !!u.isAdmin });
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
    const gold = db.applyCheckin(u.id, today, streak, reward);
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

// ===== Auth routes（邮箱验证码注册 + 忘记密码）=====

const pendingRegs   = {};   // email(lc) -> { username, email, hash, code, expires, lastSent }
const pendingResets = {};   // email(lc) -> { userId, code, expires, lastSent }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
const signToken = u => jwt.sign({ id: u.id, username: u.username, isAdmin: !!u.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
const userPayload = u => ({ id: u.id, username: u.username, gold: u.gold, isAdmin: !!u.isAdmin, email: u.email || null });

// 注册第一步：校验 + 发验证码
app.post('/api/register/send-code', async (req, res) => {
    let { username, email, password } = req.body || {};
    username = (username || '').trim(); email = (email || '').trim().toLowerCase();
    if (!username || !email || !password) return res.status(400).json({ error: '请填写用户名、邮箱和密码' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名 2-20 字符' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (db.getUserByUsername(username)) return res.status(409).json({ error: '用户名已被注册' });
    if (db.getUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册，可直接登录或找回密码' });
    const prev = pendingRegs[email];
    if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
    const code = gen6();
    const hash = await bcrypt.hash(password, 10);
    pendingRegs[email] = { username, email, hash, code, expires: Date.now() + 600000, lastSent: Date.now() };
    try { await mailer.sendCode(email, code, 'register'); }
    catch (e) { console.error('发信失败', e.message); return res.status(500).json({ error: '验证码发送失败，请稍后重试' }); }
    res.json({ ok: true, mailConfigured: mailer.isConfigured() });
});

// 注册第二步：验证码正确则建号
app.post('/api/register/verify', async (req, res) => {
    let { email, code } = req.body || {};
    email = (email || '').trim().toLowerCase();
    const p = pendingRegs[email];
    if (!p) return res.status(400).json({ error: '请先获取验证码' });
    if (Date.now() > p.expires) { delete pendingRegs[email]; return res.status(400).json({ error: '验证码已过期，请重新获取' }); }
    if (String(code).trim() !== p.code) return res.status(400).json({ error: '验证码错误' });
    try {
        const user = db.createUser(p.username, p.hash, false, p.email);
        delete pendingRegs[email];
        res.json({ token: signToken(user), user: userPayload(user) });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: '用户名已被注册' });
        if (err.message?.includes('EMAIL')) return res.status(409).json({ error: '该邮箱已注册' });
        console.error(err); res.status(500).json({ error: '服务器错误' });
    }
});

// 登录：用户名或邮箱 + 密码
app.post('/api/login', async (req, res) => {
    let { username, password } = req.body || {};
    username = (username || '').trim();
    if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
    const user = username.includes('@') ? db.getUserByEmail(username) : db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: '账号或密码错误' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '账号或密码错误' });
    res.json({ token: signToken(user), user: userPayload(user) });
});

// 忘记密码第一步：发重置验证码
app.post('/api/forgot/send-code', async (req, res) => {
    let { email } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const user = db.getUserByEmail(email);
    // 不泄露邮箱是否存在：一律回 ok；仅存在时才真的发
    if (user) {
        const prev = pendingResets[email];
        if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
        const code = gen6();
        pendingResets[email] = { userId: user.id, code, expires: Date.now() + 600000, lastSent: Date.now() };
        try { await mailer.sendCode(email, code, 'reset'); } catch (e) { console.error('发信失败', e.message); }
    }
    res.json({ ok: true });
});

// 忘记密码第二步：验证码 + 新密码
app.post('/api/forgot/reset', async (req, res) => {
    let { email, code, newPassword } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const p = pendingResets[email];
    if (!p) return res.status(400).json({ error: '请先获取验证码' });
    if (Date.now() > p.expires) { delete pendingResets[email]; return res.status(400).json({ error: '验证码已过期' }); }
    if (String(code).trim() !== p.code) return res.status(400).json({ error: '验证码错误' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.setPassword(p.userId, hash);
    delete pendingResets[email];
    const user = db.getUserById(p.userId);
    res.json({ token: signToken(user), user: userPayload(user) });
});

// 绑定/更换邮箱（已登录用户）：老账号补邮箱以启用找回密码
const pendingBinds = {};   // userId -> { email, code, expires, lastSent }
app.post('/api/bind-email/send-code', requireAuth, async (req, res) => {
    let { email } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const existing = db.getUserByEmail(email);
    if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
    const prev = pendingBinds[req.authUser.id];
    if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
    const code = gen6();
    pendingBinds[req.authUser.id] = { email, code, expires: Date.now() + 600000, lastSent: Date.now() };
    try { await mailer.sendCode(email, code, 'bind'); }
    catch (e) { console.error('发信失败', e.message); return res.status(500).json({ error: '验证码发送失败，请稍后重试' }); }
    res.json({ ok: true });
});
app.post('/api/bind-email/verify', requireAuth, (req, res) => {
    const p = pendingBinds[req.authUser.id];
    if (!p) return res.status(400).json({ error: '请先获取验证码' });
    if (Date.now() > p.expires) { delete pendingBinds[req.authUser.id]; return res.status(400).json({ error: '验证码已过期' }); }
    if (String((req.body || {}).code).trim() !== p.code) return res.status(400).json({ error: '验证码错误' });
    const existing = db.getUserByEmail(p.email);
    if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: '该邮箱已被占用' });
    db.setEmail(req.authUser.id, p.email);
    delete pendingBinds[req.authUser.id];
    res.json({ ok: true, email: p.email });
});

// ===== Game helpers =====

function activePlayers(game) {
    return game.players.filter(p => !p.folded);
}

function canAct(p) {
    return !p.folded && !p.allIn;
}

function findNextActionIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (canAct(game.players[idx])) return idx;
    }
    return -1;
}

function isBettingRoundComplete(game) {
    const active = activePlayers(game);
    if (active.length <= 1) return true;
    const canStill = active.filter(canAct);
    if (canStill.length === 0) return true;
    return canStill.every(p => p.hasActed && p.currentBet === game.currentBet);
}

// 收注：把本街各家下注累加到本手累计投入 committed（真边池在摊牌时按 committed 计算）
function collectBetsToPot(game) {
    game.players.forEach(p => {
        p.committed = (p.committed || 0) + p.currentBet;
        p.currentBet = 0;
        p.hasActed = false;
    });
    game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    game.currentBet = 0;
    game.lastRaiseSize = gameBB(game);   // 新街最小加注增量重置为大盲
}

// 构建主池 + 边池：返回 [{ amount, eligible:[player,...] }]（按 all-in 档位分层）
function buildSidePots(game) {
    const contribs = game.players
        .filter(p => (p.committed || 0) > 0)
        .map(p => ({ p, amt: p.committed, folded: p.folded }));
    const pots = [];
    let remaining = contribs.filter(c => c.amt > 0);
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0;
        const eligible = [];
        for (const c of remaining) {
            amount += minAmt;
            c.amt -= minAmt;
            if (!c.folded) eligible.push(c.p);
        }
        pots.push({ amount, eligible });
        remaining = remaining.filter(c => c.amt > 0);
    }
    return pots;
}

// 实时分池：仅当「某未弃牌玩家 all-in 且投入 < 其他未弃牌玩家」才分主/边池；
// 否则（只是有人还没跟注/加注）视为单一底池——避免行动未完成时误显边池
function livePots(game) {
    const contribs = game.players
        .map(p => ({ amt: (p.committed || 0) + (p.currentBet || 0), folded: p.folded, allIn: !!p.allIn }))
        .filter(c => c.amt > 0);
    if (!contribs.length) return [];
    const maxLive = Math.max(0, ...contribs.filter(c => !c.folded).map(c => c.amt));
    const hasAllInSide = contribs.some(c => !c.folded && c.allIn && c.amt < maxLive);
    if (!hasAllInSide) {
        const total = contribs.reduce((s, c) => s + c.amt, 0);
        return [{ amount: total, eligibleCount: contribs.filter(c => !c.folded).length }];
    }
    // 确有 all-in 边池：按档位分层
    const pots = [];
    let remaining = contribs.slice();
    while (remaining.length > 0) {
        const minAmt = Math.min(...remaining.map(c => c.amt));
        let amount = 0, eligibleCount = 0;
        for (const c of remaining) { amount += minAmt; c.amt -= minAmt; if (!c.folded) eligibleCount++; }
        pots.push({ amount, eligibleCount });
        remaining = remaining.filter(c => c.amt > 0);
    }
    return pots;
}

function broadcastState(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const state = {
        phase: game.phase,
        pot: game.pot,
        currentBet: game.currentBet,
        smallBlind: gameSB(game),
        bigBlind: gameBB(game),
        ante:       gameAnte(game),
        minBuyIn:   game.config?.minBuyIn || 0,
        maxBuyIn:   game.config?.maxBuyIn || 0,
        minBet:     gameBB(game),                                       // 本街首注最小额
        minRaiseTo: game.currentBet + (game.lastRaiseSize || gameBB(game)), // 最小加注目标额
        roomType:   game.roomType || 'cash',
        roomName:   game.config?.name || roomId,
        maxPlayers: game.config?.maxPlayers || 9,
        sidePots:   livePots(game),
        spectators: listSpectators(roomId),
        vacatedUserIds: (game.vacatedPlayers || []).map(v => v.userId),   // 站起围观者（可带原筹码回座）
        statsHistory: game.statsHistory || [],       // 已离开/淘汰玩家（战绩面板灰显）
        tableEndAt: game.tableEndAt || null,         // 现金桌训练结束时间戳
        ownerUserId:    game.ownerUserId || null,
        status:         game.status || 'waiting',
        currentLevel:   game.currentLevel || 0,
        nextLevelAt:    game.roomType === 'sng' && game.status === 'running' && game.levelStartTime
                        ? game.levelStartTime + game.config.levelMinutes * 60000 : null,
        pendingLevelUp: !!game.pendingLevelUp,
        tournamentOver: game.tournamentOver || false,
        actionDeadline: game.actionOnIdx >= 0 ? (game.actionDeadline || null) : null, // 行动截止时间戳(ms)
        actionTotalMs:  game.actionOnIdx >= 0 ? (game.actionTotalMs || ACTION_TIME) : null, // 本次行动总时长(环形进度)
        canAddTime:     game.actionOnIdx >= 0 && (game.extraAddedThisTurn || 0) < EXTRA_MAX, // 还能加时
        buttonUserId:   game.players[game.buttonIdx]?.userId || null,
        actionOnUserId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.userId || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            userId:     p.userId,
            username:   p.username,
            seat:       p.seat ?? 0,
            avatar:     p.avatar || null,
            chips:      p.chips,
            currentBet: p.currentBet,
            folded:     p.folded,
            allIn:      p.allIn,
            ready:      p.ready,
            away:       !!p.away,
            sittingOut: !!p.sittingOut,            // 现金桌坐出（等补码）
            reserved:   !!p.reserved,              // 留座离座中
            standing:   !!p.standing,              // 站起围观中（筹码保留，结束时结算）
            reserveLeaveAt: p.reserveLeaveAt || null,
            pendingRebuy: p.pendingRebuy || 0,     // 下一手生效的补码
            autoRebuy:  !!p.autoRebuy,             // 现金桌自动补码
            buyIn:      p.buyIn || 0,              // 累计带入（战绩面板）
            handsPlayed: p.handsPlayed || 0        // 已玩手数（战绩面板）
        }))
    };
    io.in(roomId).emit('game_state', state);
    emitHandHints(roomId);
}

// 房间内未入座的观众（在 room 但不在 players）
function listSpectators(roomId) {
    const game = roomGames[roomId];
    if (!game) return [];
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return [];
    const seated = new Set(game.players.map(p => p.socketId));
    const specs = [];
    for (const sid of room) {
        if (seated.has(sid)) continue;
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) specs.push({ userId: s.user.id, username: s.user.username, avatar: db.getUserById(s.user.id)?.avatar || null });
    }
    return specs;
}

// 向每位在局玩家私发其「当前最强 5 张牌」+ 牌型名（仅 flop 起，showdown 由 reveal 接管）
function emitHandHints(roomId) {
    const game = roomGames[roomId];
    if (!game || game.phase === PHASES.SHOWDOWN) return;
    const comLen = game.communityCards.length;
    if (comLen < 3) return;
    game.players.forEach(p => {
        if (p.folded || !p.socketId || !game.holeCards[p.userId]) return;
        const cards = game.communityCards.concat(game.holeCards[p.userId]);
        const bh = HandEvaluator.bestHandFrom(cards);
        if (!bh) return;
        const community = bh.indices.filter(i => i < comLen);
        const hole = bh.indices.filter(i => i >= comLen).map(i => i - comLen);
        io.to(p.socketId).emit('my_hand', { community, hole, category: bh.category });
    });
}

// ===== 行动计时器（服务器权威）=====

function clearActionTimer(game) {
    if (game.actionTimer) { clearTimeout(game.actionTimer); game.actionTimer = null; }
}

// 给当前行动玩家开始计时；超时自动 check / fold
function startActionTimer(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearActionTimer(game);
    if (game.actionOnIdx < 0) { game.actionDeadline = null; return; }
    game.extraAddedThisTurn = 0;
    game.actionStartedAt = Date.now();   // 用于记录思考时间（牌谱）
    // 离桌挂机的玩家：快速自动行动，避免每步等满 15s
    const actor = game.players[game.actionOnIdx];
    const ms = (actor && actor.away) ? 800 : ACTION_TIME;
    game.actionDeadline = Date.now() + ms;
    game.actionTotalMs = ms;
    game.actionTimer = setTimeout(() => onActionTimeout(roomId), ms);
}

function onActionTimeout(roomId) {
    const game = roomGames[roomId];
    if (!game || game.actionOnIdx < 0) return;
    const player = game.players[game.actionOnIdx];
    if (!player) return;
    const toCall = game.currentBet - player.currentBet;
    if (toCall <= 0) {
        player.hasActed = true;
        recordAction(game, player, 'check', player.currentBet);
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动过牌`);
    } else {
        player.folded = true; player.hasActed = true;
        recordAction(game, player, 'fold', 0);
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动弃牌`);
    }
    afterAction(roomId);
}

// 一次行动后推进：本街结束则进下一阶段，否则轮到下一位并重启计时
function afterAction(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (isBettingRoundComplete(game)) {
        advanceStage(roomId);
    } else {
        game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
        startActionTimer(roomId);
        broadcastState(roomId);
    }
}

function dealCommunity(game, count) {
    game.deck.drawCard(); // burn
    const dealt = [];
    for (let i = 0; i < count; i++) {
        const c = game.deck.drawCard();
        game.communityCards.push(c);
        dealt.push(c);
    }
    return dealt;
}

// 全押跑马实时胜率：仅在已亮牌的全押跑马中计算并广播
function emitEquity(roomId) {
    const game = roomGames[roomId];
    if (!game || !game.allinRevealed || game.phase === PHASES.SHOWDOWN) return;
    const holes = {};
    activePlayers(game).forEach(p => { if (game.holeCards[p.userId]) holes[p.userId] = game.holeCards[p.userId]; });
    if (Object.keys(holes).length < 2) return;
    try { io.in(roomId).emit('equity', equity.computeEquity(holes, game.communityCards)); } catch (e) {}
}

function advanceStage(roomId) {
    const game = roomGames[roomId];
    clearActionTimer(game);   // 进入新阶段前先停掉上一位的计时

    // all-in 跑马：当至多 1 名活跃玩家还能行动（其余已全押且已跟齐）→ 无更多下注，先亮牌再发完
    const act = activePlayers(game);
    const bettingClosed = act.length > 1 && act.filter(canAct).length <= 1;
    if (!game.allinRevealed && bettingClosed) {
        game.allinRevealed = true;
        collectBetsToPot(game);                 // 先把全押筹码收进底池
        const reveals = {};
        act.forEach(p => {
            const h = game.holeCards[p.userId];
            if (h) reveals[p.userId] = h.map(c => ({ suit: c.suit, rank: c.rank }));
        });
        io.in(roomId).emit('server_msg', `🃏 双方全押，亮牌！`);
        io.in(roomId).emit('allin_reveal', { reveals });
        broadcastState(roomId);                 // 先展示亮牌（公共牌暂不变）
        emitEquity(roomId);                     // 亮牌即算一次当前胜率
        clearTimeout(game.runoutTimer);
        game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
        return;                                 // 下一次 advanceStage 才开始发公共牌
    }

    while (true) {
        const active = activePlayers(game);
        if (active.length <= 1) {
            collectBetsToPot(game);
            if (active.length === 1) {
                const winner = active[0];
                winner.chips += game.pot;   // 其余全弃，独得全部投入
                io.in(roomId).emit('server_msg', `🏆 ${winner.username} 赢得底池 ${game.pot}（其余弃牌）`);
                io.in(roomId).emit('sfx', 'win');
                saveHandHistory(game, { [winner.userId]: game.pot });
            } else {
                saveHandHistory(game, {});
            }
            game.pot = 0;
            game.players.forEach(p => p.committed = 0);
            game.phase = PHASES.SHOWDOWN;
            game.actionOnIdx = -1;
            applyPendingLevelUp(roomId);
            broadcastState(roomId);
            maybeEndSNG(roomId);
            if (!game.tournamentOver) scheduleNextHand(roomId);
            return;
        }
        collectBetsToPot(game);
        if (game.phase === PHASES.PREFLOP) {
            game.phase = PHASES.FLOP;
            const flop = dealCommunity(game, 3);
            io.in(roomId).emit('server_msg', `🌅 Flop: ${flop.map(c => c.toString()).join(' | ')}`);
        } else if (game.phase === PHASES.FLOP) {
            game.phase = PHASES.TURN;
            const [turn] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌇 Turn: ${turn.toString()}`);
        } else if (game.phase === PHASES.TURN) {
            game.phase = PHASES.RIVER;
            const [river] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌃 River: ${river.toString()}`);
        } else if (game.phase === PHASES.RIVER) {
            game.phase = PHASES.SHOWDOWN;
            doShowdown(roomId);
            return;
        }
        // 至多 1 人能行动（其余全押）→ 不再要任何人行动，直接跑马
        const act2 = activePlayers(game);
        if (act2.length > 1 && act2.filter(canAct).length <= 1) {
            game.actionOnIdx = -1;
        } else {
            game.actionOnIdx = findNextActionIdx(game, game.buttonIdx);
        }
        if (game.actionOnIdx < 0) {
            // 无人可行动（全押 all-in 跑马）：发完这条街先展示，间隔一段时间再发下一张
            broadcastState(roomId);
            emitEquity(roomId);                 // 每发一条街重算胜率（跳动）
            clearTimeout(game.runoutTimer);
            game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
            return;
        }
        startActionTimer(roomId);
        broadcastState(roomId);
        return;
    }
}

function doShowdown(roomId) {
    const game = roomGames[roomId];
    const active = activePlayers(game);
    io.in(roomId).emit('server_msg', `\n--- 🃏 Showdown ---`);

    // 每位仍在局玩家的 7 张牌得分
    const scoreOf = {};
    active.forEach(p => {
        scoreOf[p.userId] = HandEvaluator.evaluate7Cards(game.communityCards.concat(game.holeCards[p.userId]));
    });

    // 广播所有手牌
    const reveals = {};
    active.forEach(p => {
        reveals[p.userId] = game.holeCards[p.userId].map(c => ({ suit: c.suit, rank: c.rank }));
    });

    // 真边池：逐池在「有资格的玩家」中取最强手分配；平局均分，余数给第一位
    const pots = buildSidePots(game);
    const winShare = {};   // userId -> 赢得总额
    const potResults = []; // 逐池结果（主池在前，边池在后），供客户端依次飞币动画
    pots.forEach((pot, idx) => {
        if (!pot.eligible.length) return;
        const best = Math.min(...pot.eligible.map(p => scoreOf[p.userId]));
        const winners = pot.eligible.filter(p => scoreOf[p.userId] === best);
        const split = Math.floor(pot.amount / winners.length);
        const rem = pot.amount - split * winners.length;
        winners.forEach((w, i) => {
            const amt = split + (i === 0 ? rem : 0);
            w.chips += amt;
            winShare[w.userId] = (winShare[w.userId] || 0) + amt;
        });
        potResults.push({
            amount: pot.amount, main: idx === 0,
            label: idx === 0 ? '主池' : `边池${idx}`,
            winners: winners.map(w => ({ userId: w.userId, amount: split + 0 }))
        });
    });

    // 每个赢家各自的最强 5 张（分池/平分时两位赢家都要高亮各自的牌，不能只亮一个）
    const winnerIds = Object.keys(winShare);
    const overallId = winnerIds.sort((a, b) => winShare[b] - winShare[a])[0];
    const bestByWinner = {};
    winnerIds.forEach(id => {
        if (!game.holeCards[id]) return;
        const wb = HandEvaluator.bestHand(game.communityCards.concat(game.holeCards[id]));
        bestByWinner[id] = {
            community: wb.indices.filter(i => i < 5),
            hole: wb.indices.filter(i => i >= 5).map(i => i - 5),
            category: wb.category
        };
    });
    const ob = bestByWinner[overallId] || { community: [], hole: [], category: '' };
    io.in(roomId).emit('showdown_reveal', {
        reveals, winners: winnerIds, winnerId: overallId,
        bestCommunity: ob.community, bestHole: ob.hole, category: ob.category,
        bestByWinner, pots: potResults
    });
    const label = winnerIds.map(id => {
        const p = game.players.find(x => x.userId === id);
        return `${p ? p.username : id} +${winShare[id]}`;
    }).join('，');
    io.in(roomId).emit('server_msg', `🏆 ${label}（边池数 ${pots.length}）`);

    saveHandHistory(game, winShare);   // 牌谱落库
    game.pot = 0;
    game.players.forEach(p => p.committed = 0);
    game.actionOnIdx = -1;
    applyPendingLevelUp(roomId);
    broadcastState(roomId);
    io.in(roomId).emit('sfx', 'win');
    maybeEndSNG(roomId);
    if (!game.tournamentOver) scheduleNextHand(roomId);
}

// 全员准备就绪后自动开新局
function tryStartHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.tournamentOver) return;
    if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) return;
    if (game.players.length < 2) return;
    if (!game.players.every(p => p.ready)) return;
    startHand(roomId);
}

// 该玩家本手是否参与发牌（有筹码且未坐出）
function canPlay(p) { return p.chips > 0 && !p.sittingOut; }
function liveCount(game) { return game.players.filter(canPlay).length; }
// 从 fromIdx 起（不含）找下一个可参与的玩家索引；找不到返回 -1
function nextLiveIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (canPlay(game.players[idx])) return idx;
    }
    return -1;
}

function startHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;

    const BB = gameBB(game), SB = gameSB(game);
    // 至少 2 名可参与玩家（有筹码、未坐出）才能开局
    if (liveCount(game) < 2) {
        io.in(roomId).emit('server_msg', `⏳ 在座可玩玩家不足 2 人，等待补码 / 入座`);
        return;
    }
    clearTimeout(game.nextHandTimer);
    clearTimeout(game.runoutTimer);
    game.rabbitStreets = 0;   // 重置「看后续牌」状态
    // 第一手开始：标记 running；SNG 启动升盲计时；现金桌启动训练时长倒计时
    if (game.status !== 'running') {
        game.status = 'running';
        if (game.roomType === 'sng') { game.levelStartTime = Date.now(); startLevelTimer(roomId); }
        if (game.roomType === 'cash') startTableTimer(roomId);
        broadcastRoomList();
    }
    // 按座位号排序数组（开局前安全：数组顺序=环桌顺序，决定行动/盲注方向）
    game.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    // 按钮位按「座位号」轮转到下一个可参与玩家（与数组插入/删除解耦）
    const liveSeats = game.players.filter(canPlay).map(p => p.seat).sort((a, b) => a - b);
    let bseat;
    if (game.buttonSeat == null || game.buttonSeat < 0) bseat = liveSeats[0];
    else { bseat = liveSeats.find(s => s > game.buttonSeat); if (bseat == null) bseat = liveSeats[0]; }
    game.buttonSeat = bseat;
    game.buttonIdx = game.players.findIndex(p => p.seat === bseat);

    game.deck.reset(); game.deck.shuffle();
    console.log(`[deal] 房间 ${roomId} 新一手已重新洗牌（crypto） shuffleId=${game.deck.lastShuffleId}`);
    game.holeCards = {}; game.communityCards = [];
    game.shownCards = {};   // 本局主动亮牌记录（userId -> Set(牌索引)）
    game.allinRevealed = false;   // 全押亮牌标志
    game.pot = 0; game.currentBet = 0;
    game.lastRaiseSize = BB;   // 本街最小加注增量（每条街在 collectBetsToPot 重置）
    game.players.forEach(p => {
        p.currentBet = 0; p.committed = 0; p.allIn = false; p.hasActed = false;
        p.ready = false;   // 开局即清空准备状态，下一局需重新准备
        // 坐出（无筹码/等补码）玩家本手不参与：标记 folded、不发牌
        p.folded = !canPlay(p);
    });
    game.phase = PHASES.PREFLOP;

    // 位置：可参与玩家中 N=2（heads-up）按钮位=SB、preflop 先动；N≥3 按钮后第一位=SB、+1=BB、BB 后(UTG)先动
    const live = liveCount(game);
    const headsUp = live === 2;
    const sbIdx = headsUp ? game.buttonIdx : nextLiveIdx(game, game.buttonIdx);
    const bbIdx = nextLiveIdx(game, sbIdx);
    const sb = game.players[sbIdx];
    const bb = game.players[bbIdx];
    const sbAmt = Math.min(SB, sb.chips);
    const bbAmt = Math.min(BB, bb.chips);
    sb.chips -= sbAmt; sb.currentBet = sbAmt;
    bb.chips -= bbAmt; bb.currentBet = bbAmt;
    if (sb.chips === 0) sb.allIn = true;
    if (bb.chips === 0) bb.allIn = true;
    game.currentBet = bbAmt;

    // 前注 ante（现金桌可选）：直接进底池，不计入当前下注
    const ante = gameAnte(game);
    if (ante > 0) {
        game.players.forEach(p => {
            if (p.folded) return;   // 坐出玩家不交前注
            const a = Math.min(ante, p.chips);
            p.chips -= a; p.committed += a;
            if (p.chips === 0) p.allIn = true;
        });
        game.pot = game.players.reduce((s, p) => s + (p.committed || 0), 0);
    }

    io.in(roomId).emit('server_msg', `\n--- 🎲 新一局开始 ---`);
    io.in(roomId).emit('server_msg', `💰 SB: ${sb.username} (${sbAmt}) | BB: ${bb.username} (${bbAmt})`);

    game.players.forEach(p => {
        if (p.folded) return;   // 坐出玩家不发牌
        const c1 = game.deck.drawCard();
        const c2 = game.deck.drawCard();
        game.holeCards[p.userId] = [c1, c2];
        io.to(p.socketId).emit('hole_cards', [
            { suit: c1.suit, rank: c1.rank },
            { suit: c2.suit, rank: c2.rank }
        ]);
    });

    // 牌谱记录初始化（数据资产：玩家×模式×时序）——仅记录参与本手的玩家
    game.hand = {
        ts: Date.now(), roomId, mode: game.roomType,
        sb: SB, bb: BB, ante,
        buttonUserId: game.players[game.buttonIdx]?.userId || null,
        seats: game.players.filter(p => !p.folded).map(p => ({
            userId: p.userId, username: p.username,
            seat: p.seat ?? 0, avatar: p.avatar || null,          // 座位号/头像（回放布局用）
            startChips: p.chips + p.currentBet + (p.committed || 0),   // 还原下盲前筹码
            hole: game.holeCards[p.userId].map(c => `${c.rank}${c.suit[0]}`)
        })),
        actions: []   // { userId, street, action, amount, thinkMs }（amount=该街行动后的 currentBet 总额）
    };
    game.players.forEach(p => { if (!p.folded) p.handsPlayed = (p.handsPlayed || 0) + 1; });

    // preflop 第一个行动：heads-up = SB（按钮）；N≥3 = BB 后第一位（UTG）
    game.actionOnIdx = headsUp ? sbIdx : findNextActionIdx(game, bbIdx);
    startActionTimer(roomId);
    broadcastState(roomId);
}

// 记录一次行动到牌谱
function recordAction(game, player, action, amount) {
    if (!game.hand) return;
    game.hand.actions.push({
        userId: player.userId, street: game.phase, action,
        amount: amount || 0,
        thinkMs: game.actionStartedAt ? Date.now() - game.actionStartedAt : 0
    });
}

// 一手结束落库牌谱（含公共牌与各家结果）
function saveHandHistory(game, winShare) {
    if (!game.hand) return;
    game.hand.community = game.communityCards.map(c => `${c.rank}${c.suit[0]}`);
    game.hand.results = game.hand.seats.map(s => ({
        userId: s.userId,
        won: (winShare && winShare[s.userId]) || 0,
        endChips: (game.players.find(p => p.userId === s.userId) || {}).chips ?? 0
    }));
    db.appendHand(game.hand);
    game.hand = null;
}

// ===== 房间 / 大厅 =====

const lobbySockets = new Set();   // 当前停留在大厅页的 socketId，用于推送房间列表

function clampInt(v, min, max, def) {
    v = parseInt(v);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
}

function genRoomId() {
    let id;
    do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (roomGames[id]);
    return id;
}

function roomSummary(roomId, userId) {
    const g = roomGames[roomId];
    return {
        roomId,
        roomType:   g.roomType,
        name:       g.config?.name || roomId,
        ownerName:  g.ownerName || '',
        maxPlayers: g.config?.maxPlayers || 2,
        playerCount: g.players.length,
        status:     g.status,                    // waiting | running | finished
        levelMinutes: g.config?.levelMinutes || 0,
        startingStack: g.config?.startingStack || 0,
        buyIn:      g.config?.buyIn || 0,
        sb:         g.config?.sb || 0,
        bb:         g.config?.bb || 0,
        ante:       g.config?.ante || 0,
        minBuyIn:   g.config?.minBuyIn || 0,
        isMember:   !!(userId && g.players.some(p => p.userId === userId))   // 我是否本房成员（可重进）
    };
}

function listRooms(userId) {
    return Object.keys(roomGames)
        .filter(id => roomGames[id].roomType && roomGames[id].status !== 'finished')
        .map(id => roomSummary(id, userId));
}

function broadcastRoomList() {
    for (const sid of lobbySockets) {
        const s = io.sockets.sockets.get(sid);
        io.to(sid).emit('room_list', listRooms(s && s.user && s.user.id));
    }
}

// SNG 升盲计时器
function startLevelTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng') return;
    clearTimeout(game.levelTimer);
    game.levelTimer = setTimeout(() => onLevelUp(roomId), game.config.levelMinutes * 60000);
}

function onLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.status !== 'running') return;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    if (inHand) {
        // 牌局进行中：挂起涨盲，等本局结束再应用并重启倒计时（不在此重启计时）
        game.pendingLevelUp = true;
        io.in(roomId).emit('server_msg', `⏫ 涨盲时间到，将于本局结束后升盲`);
        broadcastState(roomId);
        return;
    }
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

function doLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.currentLevel < game.blindLevels.length - 1) {
        game.currentLevel++;
        const lvl = game.blindLevels[game.currentLevel];
        io.in(roomId).emit('server_msg', `⏫ 升盲！级别 ${game.currentLevel + 1}：${lvl.sb}/${lvl.bb}`);
    }
    game.levelStartTime = Date.now();
}

// 本局结束时若有挂起的涨盲，则应用并重启倒计时
function applyPendingLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || !game.pendingLevelUp) return;
    game.pendingLevelUp = false;
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

// SNG 结束判定：仅剩 1 人有筹码 → 比赛结束，奖池给赢家
function maybeEndSNG(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng' || game.tournamentOver) return;
    const alive = game.players.filter(p => p.chips > 0);
    if (alive.length <= 1) {
        game.tournamentOver = true;
        game.status = 'finished';
        clearTimeout(game.levelTimer);
        const winner = alive[0];
        if (winner) {
            const prize = sngPrize(game.prizePool);
            if (prize > 0) {
                const fresh = db.getUserById(winner.userId).gold;
                db.setGold(winner.userId, fresh + prize);
                if (winner.socketId) io.to(winner.socketId).emit('gold_update', { gold: fresh + prize });
            }
            io.in(roomId).emit('server_msg', `🏆🏆 ${winner.username} 夺冠！奖池 ${prize} 金币`);
            io.in(roomId).emit('tournament_over', { winner: winner.username, prize });
        }
        // 公布按名次排名（冠军→淘汰倒序）+ 给每位玩家（含已淘汰离开者）发消息
        sendMatchResult(roomId, `【${game.config.name}】比赛结束`, buildRanking(game, winner && winner.userId, sngPrize(game.prizePool)));
        broadcastRoomList();
    }
}

// 记录离开/淘汰玩家的最终战绩（供战绩面板灰显 + 结束排名）
function recordLeft(game, p) {
    if (!game.statsHistory) game.statsHistory = [];
    const net = (p.chips || 0) - (p.buyIn || 0);
    const ex = game.statsHistory.find(h => h.userId === p.userId);
    if (ex) { ex.net = net; ex.handsPlayed = p.handsPlayed || 0; ex.buyIn = p.buyIn || 0; }
    else game.statsHistory.push({ userId: p.userId, username: p.username, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, net, left: true });
}

// 构建结束排名：现金=按盈亏(筹码)；SNG=冠军→淘汰倒序(盈亏金币)
function buildRanking(game, winnerId, prize) {
    if (game.roomType === 'cash') {
        const cur = game.players.map(p => ({ userId: p.userId, username: p.username, net: (p.chips || 0) - (p.buyIn || 0) }));
        const vac = (game.vacatedPlayers || []).map(v => ({ userId: v.userId, username: v.username, net: (v.chips || 0) - (v.buyIn || 0) }));
        const covered = new Set([...cur, ...vac].map(r => r.userId));
        const hist = (game.statsHistory || []).filter(h => !covered.has(h.userId))
            .map(h => ({ userId: h.userId, username: h.username, net: h.net }));
        return [...cur, ...vac, ...hist].sort((a, b) => b.net - a.net)
            .map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, net: r.net, unit: '筹码' }));
    }
    const fee = game.config.buyIn || 0;
    const order = [];
    const w = game.players.find(p => p.userId === winnerId);
    if (w) order.push({ userId: w.userId, username: w.username, net: (prize || 0) - fee });
    (game.statsHistory || []).slice().reverse().forEach(h => order.push({ userId: h.userId, username: h.username, net: -fee }));
    return order.map((r, i) => ({ rank: i + 1, userId: r.userId, username: r.username, net: r.net, unit: '金币' }));
}

// 公布排名：在线玩家弹结算面板；所有参与者（含离线/已离开）进收件箱
function sendMatchResult(roomId, title, ranking) {
    if (!ranking || !ranking.length) return;
    io.in(roomId).emit('match_result', { title, ranking });
    ranking.forEach(r => {
        const sign = r.net >= 0 ? '+' : '';
        const line = ranking.map(x => `${x.rank}. ${x.username} ${x.net >= 0 ? '+' : ''}${x.net}`).join('\n');
        db.addMessage(r.userId, { type: 'result', text: `${title}\n你第 ${r.rank}/${ranking.length} 名，盈亏 ${sign}${r.net} ${r.unit}\n\n排名：\n${line}` });
    });
}

// 现金桌训练时长倒计时：到点自动结束并结算排名
function startTableTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return;
    const ms = Math.round((game.config.durationH || 2) * 3600 * 1000) + (game.extraMs || 0);
    game.tableEndAt = Date.now() + ms;
    clearTimeout(game.tableTimer);
    game.tableTimer = setTimeout(() => endCashTable(roomId, '训练时长已到'), ms);
}
function extendTable(roomId, addMs) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'cash') return;
    game.extraMs = (game.extraMs || 0) + addMs;
    if (game.tableEndAt) {
        game.tableEndAt += addMs;
        clearTimeout(game.tableTimer);
        game.tableTimer = setTimeout(() => endCashTable(roomId, '训练时长已到'), Math.max(0, game.tableEndAt - Date.now()));
    }
}

// 结束现金桌：结算所有在座筹码→金币，公布排名+发消息，全员（含观众）回大厅
function endCashTable(roomId, reason) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
    game.tournamentOver = true; game.status = 'finished';
    clearTimeout(game.tableTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer); clearActionTimer(game);
    for (const p of game.players) if (p.reserveTimer) clearTimeout(p.reserveTimer);
    const ranking = buildRanking(game);
    game.players.forEach(p => cashOut(p));   // 结算筹码→金币
    (game.vacatedPlayers || []).forEach(vp => cashOut(vp));   // 站起围观者的筹码也在结束时结算
    if (ranking.length) sendMatchResult(roomId, `【${game.config.name}】${reason || '比赛结束'}`, ranking);
    else io.in(roomId).emit('room_dissolved');   // 空桌（如刚创建即解散）：直接回大厅
    // 把房间内所有 socket（在座玩家 + 观众）踢回大厅
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) for (const sid of [...room]) {
        const s = io.sockets.sockets.get(sid);
        if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); if (s.user) s.emit('room_list', listRooms(s.user.id)); }
    }
    delete roomGames[roomId];
    broadcastRoomList();
}

// 一局结束后自动开下一局（SNG/现金桌进行中，无需重新准备）
// 注意：总是排一次定时清理（标记坐出/兑出/生效补码），即使人数不足也要让坐出状态落地
function scheduleNextHand(roomId) {
    const game = roomGames[roomId];
    if (!game || game.tournamentOver) return;
    if (game.roomType !== 'sng' && game.roomType !== 'cash') return;
    clearTimeout(game.nextHandTimer);
    game.nextHandTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (!g || g.tournamentOver || g.phase !== PHASES.SHOWDOWN) return;
        removeBustedPlayers(g);   // 结算后：SNG 淘汰 / 现金桌兑出离场者移除、坐出者保留、挂起补码生效
        if (liveCount(g) >= 2) startHand(roomId);
        else broadcastState(roomId);   // 人不够：停摆，等补码/坐下（坐出状态已标记）
    }, 5000);
}

// 现金桌兑出：剩余筹码按汇率兑回金币，返回兑出金币数
function cashOut(p) {
    const payout = Math.max(0, Math.floor((p.chips || 0) * CASHOUT_RATE));
    if (payout > 0) {
        const fresh = db.getUserById(p.userId).gold;
        db.setGold(p.userId, fresh + payout);
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('gold_update', { gold: fresh + payout });
    }
    return payout;
}

// 站起围观：把玩家移出座位（座位腾空、可被他人坐下），转为观众；筹码存入 vacatedPlayers，
// 结束/解散时统一结算（不立即兑出）。与「留座离桌」(reserved, 保留座位) 区分。
function vacateSeat(game, idx) {
    const p = game.players[idx];
    if (!p) return;
    if (!game.vacatedPlayers) game.vacatedPlayers = [];
    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
    game.vacatedPlayers.push({
        userId: p.userId, username: p.username, avatar: p.avatar || null,
        chips: p.chips, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, socketId: p.socketId
    });
    game.players.splice(idx, 1);
    if (game.buttonIdx > idx) game.buttonIdx--;
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
}

// 为某座位扣金币、登记挂起补码（下一手生效）。成功返回 true
function chargeRebuy(p, chips) {
    const fresh = db.getUserById(p.userId);
    if (!fresh) return false;
    const cost = Math.ceil(chips * BUYIN_RATE);
    if (fresh.gold < cost) return false;
    db.setGold(p.userId, fresh.gold - cost);
    if (p.socketId) io.to(p.socketId).emit('gold_update', { gold: fresh.gold - cost });
    p.pendingRebuy = (p.pendingRebuy || 0) + chips;
    p.buyIn = (p.buyIn || 0) + chips;
    return true;
}

// 下一手前的座位清理：
// - 现金桌：主动离场者兑出移除；筹码归零者「保留座位坐出」（可补码回来），不淘汰
// - SNG：筹码归零者淘汰移除
function removeBustedPlayers(game) {
    const roomId = Object.keys(roomGames).find(id => roomGames[id] === game);
    for (let i = game.players.length - 1; i >= 0; i--) {
        const p = game.players[i];
        if (game.roomType === 'cash') {
            // 站起围观待腾位（本手结束）：移出座位到 vacatedPlayers，座位空出
            if (p.vacateAfter) { vacateSeat(game, i); continue; }
            // 自动补码：耗尽且开启 autoRebuy 且无挂起 → 自动按最小带入补一手
            if (p.chips <= 0 && p.autoRebuy && !(p.pendingRebuy > 0) && !p.leaving) {
                if (chargeRebuy(p, game.config.minBuyIn)) io.in(roomId).emit('server_msg', `🔁 ${p.username} 自动补码 ${game.config.minBuyIn}`);
            }
            // 有挂起补码：下一手生效（加筹码，取消坐出）
            if (p.pendingRebuy > 0) { p.chips += p.pendingRebuy; p.pendingRebuy = 0; p.sittingOut = false; }
            if (p.leaving) {
                recordLeft(game, p);   // 战绩面板灰显 + 结束排名
                const payout = cashOut(p);
                io.in(roomId).emit('server_msg', `🚪 ${p.username} 离场，兑出 ${payout} 金币`);
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('busted_out'); }
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            } else if (p.chips <= 0 && !p.sittingOut) {
                p.sittingOut = true;   // 坐出（保留座位），等补码
                io.in(roomId).emit('server_msg', `💤 ${p.username} 记分牌耗尽，坐出（可补码回来）`);
            }
        } else {
            if (p.chips <= 0) {
                recordLeft(game, p);   // SNG 淘汰顺序（用于结束排名：先淘汰=末名）
                io.in(roomId).emit('server_msg', `💀 ${p.username} 出局`);
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('busted_out'); }
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            }
        }
    }
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// 以观众身份进桌（不入座、不带入）：用于现金桌「坐下式」入座
function joinAsSpectator(roomId, socket) {
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    socket.emit('room_joined', { roomId });
    broadcastState(roomId);
    broadcastRoomList();
}

// 座位占用集合 / 找首个空座
function occupiedSeats(game) { return new Set(game.players.map(p => p.seat)); }
function firstFreeSeat(game) {
    const taken = occupiedSeats(game);
    for (let s = 0; s < game.config.maxPlayers; s++) if (!taken.has(s)) return s;
    return -1;
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// seat=指定座位号（现金桌坐下式由客户端点选；不传则取首个空座）
function seatPlayer(roomId, socket, user, buyInChips, seat) {
    const game = roomGames[roomId];
    const fresh = db.getUserById(user.id);
    // 座位分配（固定座位号；客户端按 seat 环形定位）
    if (seat == null || seat < 0 || seat >= game.config.maxPlayers || occupiedSeats(game).has(seat)) {
        seat = firstFreeSeat(game);
    }
    if (seat < 0) { socket.emit('server_msg', '⚠️ 没有空座位'); return false; }
    let chips;
    if (game.roomType === 'cash') {
        const maxB = game.config.maxBuyIn || 1e9;
        chips = clampInt(buyInChips, game.config.minBuyIn, maxB, game.config.minBuyIn);
        const cost = Math.ceil(chips * BUYIN_RATE);
        if (fresh.gold < cost) { socket.emit('server_msg', `⚠️ 金币不足：买入 ${chips} 筹码需 ${cost} 金币（当前 ${fresh.gold}）`); return false; }
        db.setGold(user.id, fresh.gold - cost); user.gold = fresh.gold - cost;
        socket.emit('gold_update', { gold: user.gold });
    } else {
        const fee = game.config.buyIn || 0;
        if (fresh.gold < fee) { socket.emit('server_msg', `⚠️ 金币不足报名费 ${fee}（当前 ${fresh.gold}）`); return false; }
        if (fee > 0) {
            db.setGold(user.id, fresh.gold - fee); user.gold = fresh.gold - fee;
            game.prizePool = (game.prizePool || 0) + fee;
            socket.emit('gold_update', { gold: user.gold });
        }
        chips = game.config.startingStack;
    }
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    const newP = {
        userId: user.id, socketId: socket.id, username: user.username, seat,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips, currentBet: 0, buyIn: chips,   // 入座即记录带入额（战绩 net=chips-buyIn=0，避免首次广播显示 +chips）
        folded: inHand, allIn: false, hasActed: false, ready: false   // 中途加入则本局坐出（下一局开局重置）
    };
    // 牌局进行中：追加到末尾（避免打乱在用的数组索引），坐出本手；局间则按座位插入
    if (inHand) {
        game.players.push(newP);
    } else {
        let ins = game.players.findIndex(p => p.seat > seat);
        if (ins < 0) ins = game.players.length;
        game.players.splice(ins, 0, newP);
        if (ins <= game.buttonIdx) game.buttonIdx++;
    }
    socket.emit('room_joined', { roomId });
    socket.to(roomId).emit('server_msg', `🪑 ${user.username} 入座 ${seat + 1} 号位`);
    broadcastState(roomId);
    broadcastRoomList();
    return true;
}

// ===== Socket auth middleware =====

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('未登录'));
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(payload.id);
        if (!user) return next(new Error('用户不存在'));
        socket.user = { ...user }; // shallow copy so we can mutate gold cache
        next();
    } catch {
        next(new Error('登录已过期，请重新登录'));
    }
});

// ===== Socket handlers =====

io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`[+] ${user.username} 上线`);
    socket.emit('gold_update', { gold: user.gold });
    socket.emit('profile', { avatar: db.getUserById(user.id)?.avatar || null });

    // 网络延迟测量：回声
    socket.on('latency_ping', (t) => socket.emit('latency_pong', t));

    // 设置头像：持久化 + 更新在座玩家 + 重广播
    socket.on('set_avatar', ({ avatar }) => {
        if (avatar && typeof avatar !== 'string') return;
        db.setAvatar(user.id, avatar || null);
        user.avatar = avatar || null;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const p = game.players.find(pl => pl.userId === user.id);
            if (p) { p.avatar = avatar || null; broadcastState(roomId); }
        }
        socket.emit('profile', { avatar: avatar || null });
    });

    // 进入大厅：订阅房间列表
    socket.on('enter_lobby', () => {
        lobbySockets.add(socket.id);
        socket.currentRoom = null;
        socket.emit('room_list', listRooms(user.id));
    });

    // 创建 SNG 房间（双人升盲），创建者自动入座
    socket.on('create_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'sng', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            config: {
                name:        (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的比赛`,
                maxPlayers:  clampInt(cfg.maxPlayers, 2, 9, 2),              // 2–9 人（引擎已支持多人）
                startingStack: clampInt(cfg.startingStack, 5000, 30000, 10000),
                levelMinutes:  clampInt(cfg.levelMinutes, 3, 10, 3),
                buyIn:         SNG_BUYIN_TIERS.includes(+cfg.buyIn) ? +cfg.buyIn : SNG_BUYIN_TIERS[0]
            },
            blindLevels: STANDARD_BLIND_LEVELS,
            currentLevel: 0, levelStartTime: null, prizePool: 0, tournamentOver: false,
            statsHistory: []
        };
        if (!seatPlayer(roomId, socket, user)) { delete roomGames[roomId]; }
    });

    // 创建现金桌（2–9 人，固定盲注，金币↔筹码买入），创建者按 buyInChips 买入
    socket.on('create_cash_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        const bb = clampInt(cfg.bb, 20, 1000, 40);
        const sb = clampInt(cfg.sb, 10, bb, Math.floor(bb / 2));
        const minBuyIn = clampInt(cfg.minBuyIn, 2000, 8000, 2000);
        const maxBuyIn = clampInt(cfg.maxBuyIn, 0, 60000, 0);   // 0=无限制
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'cash', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            config: {
                name:      (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的现金桌`,
                maxPlayers: clampInt(cfg.maxPlayers, 2, 9, 6),
                sb, bb, ante: clampInt(cfg.ante, 0, 80, 0), minBuyIn, maxBuyIn,
                durationH: [0.5, 1, 2, 3, 4, 5, 6].includes(+cfg.durationH) ? +cfg.durationH : 2
            },
            prizePool: 0, tournamentOver: false,
            statsHistory: [], tableEndAt: null, extraMs: 0
        };
        // 现金桌：房主先以观众身份进桌，点空座位「坐下」再带入（坐下式入座）
        joinAsSpectator(roomId, socket);
    });

    // 加入已有房间（含断线重连）
    socket.on('join_room', ({ roomId, buyInChips }) => {
        const game = roomGames[roomId];
        if (!game) { socket.emit('server_msg', '⚠️ 房间不存在或已结束'); socket.emit('room_list', listRooms(user.id)); return; }

        // 断线重连
        const existing = game.players.find(p => p.userId === user.id);
        if (existing) {
            existing.socketId = socket.id;
            existing.away = false;   // 重连后恢复在桌
            // 重连/重新进入即取消留座倒计时；站起或留座回来，有筹码则接上原座位继续（战绩不清零）
            if (existing.reserveTimer) { clearTimeout(existing.reserveTimer); existing.reserveTimer = null; }
            if (existing.reserved || existing.standing) {
                existing.reserved = false; existing.standing = false;
                if (existing.chips > 0) existing.sittingOut = false;
            }
            lobbySockets.delete(socket.id);
            socket.join(roomId);
            socket.currentRoom = roomId;
            socket.emit('room_joined', { roomId });
            socket.emit('server_msg', '🔄 重新连接成功');
            if (game.holeCards[user.id]) {
                socket.emit('hole_cards', game.holeCards[user.id].map(c => ({ suit: c.suit, rank: c.rank })));
            }
            // 若正轮到他行动，重连后重启计时（away 已置 false → 恢复满时长，并取消可能的 away 快速超时）
            if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN
                && game.actionOnIdx >= 0 && game.players[game.actionOnIdx]?.userId === user.id) {
                startActionTimer(roomId);
            }
            // 现金桌：重新进入后若在局间且够人，恢复续局
            else if (game.roomType === 'cash' && game.status === 'running' && !existing.sittingOut
                && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2) {
                scheduleNextHand(roomId);
            }
            broadcastState(roomId);
            broadcastRoomList();
            return;
        }

        if (game.roomType === 'cash') {
            // 现金桌：先进桌当观众，点空座「坐下」再带入
            joinAsSpectator(roomId, socket);
            return;
        }
        // SNG 不许中途加入（开赛即锁定座位）
        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', '⚠️ 房间已满'); return; }
        if (game.status === 'running') { socket.emit('server_msg', '⚠️ 比赛已开始，无法加入'); return; }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) { socket.emit('server_msg', '⚠️ 牌局进行中，请稍后'); return; }
        seatPlayer(roomId, socket, user, buyInChips);
    });

    // 坐下入座（现金桌坐下式）：观众点空座位 → 带入筹码正式入座
    socket.on('sit_down', ({ buyInChips, seat }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.roomType !== 'cash') { socket.emit('server_msg', '⚠️ 该房间无需坐下'); return; }
        if (game.players.find(p => p.userId === user.id)) { socket.emit('server_msg', '⚠️ 你已入座'); return; }
        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', '⚠️ 座位已满'); return; }
        if (occupiedSeats(game).has(seat)) { socket.emit('server_msg', '⚠️ 该座位已被占用'); return; }
        if (seatPlayer(roomId, socket, user, buyInChips, seat)) {
            // 带入额已在 seatPlayer 内记录（buyIn=chips），此处不再重复累加
            // 入座后若满足开局条件且现金桌进行中/可开，尝试开局
            if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) {
                if (game.status === 'running') { if (liveCount(game) >= 2) startHand(roomId); }
            }
        }
    });

    // 站起围观（现金桌）：离座腾位（座位变空、他人可坐），转观众；筹码保留，只在结束/解散时结算
    socket.on('stand_up', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') { socket.emit('server_msg', '⚠️ 仅现金桌可站起'); return; }
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        const p = game.players[idx];
        const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded;
        io.in(roomId).emit('server_msg', `🧍 ${user.username} 站起围观（座位空出，筹码保留至结束结算）`);
        if (midHand) {
            // 本手还在牌里：先弃牌打完本手，本手结束后再离座腾位（removeBustedPlayers 处理）
            p.folded = true; p.hasActed = true; p.vacateAfter = true;
            if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
            else if (isBettingRoundComplete(game)) advanceStage(roomId);
            else broadcastState(roomId);
        } else {
            vacateSeat(game, idx);
            broadcastState(roomId);
        }
        broadcastRoomList();
    });

    // 留座离座（现金桌）：保留座位、坐出本手，2 分钟内不回来自动站起兑出
    socket.on('reserve_leave', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        const p = game.players.find(pl => pl.userId === user.id);
        if (!p) return;
        p.away = true; p.reserved = true; p.sittingOut = true;
        p.reserveLeaveAt = Date.now() + 120000;
        if (p.reserveTimer) clearTimeout(p.reserveTimer);
        p.reserveTimer = setTimeout(() => {
            const g = roomGames[roomId]; if (!g) return;
            const pp = g.players.find(x => x.userId === user.id);
            if (!pp || !pp.reserved) return;
            // 留座超时：转为「站起围观」（坐出、筹码保留，不兑出），结束时再结算
            pp.reserved = false; pp.standing = true; pp.sittingOut = true; pp.reserveTimer = null;
            io.in(roomId).emit('server_msg', `⌛ ${pp.username} 留座超时，自动站起围观（筹码保留）`);
            broadcastState(roomId); broadcastRoomList();
        }, 120000);
        io.in(roomId).emit('server_msg', `💺 ${user.username} 留座离座（2 分钟内回来保留座位）`);
        broadcastState(roomId);
    });

    // 回到座位（取消留座/坐出；站起围观者带原筹码回到一个空座）
    socket.on('sit_back', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        // 站起围观回座：从 vacatedPlayers 恢复到空座（带回原筹码，不再扣买入）
        if (game.vacatedPlayers) {
            const vi = game.vacatedPlayers.findIndex(v => v.userId === user.id);
            if (vi >= 0) {
                const seat = firstFreeSeat(game);
                if (seat < 0) { socket.emit('server_msg', '⚠️ 暂无空座，无法回座'); return; }
                const vp = game.vacatedPlayers.splice(vi, 1)[0];
                const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
                game.players.push({
                    userId: user.id, socketId: socket.id, username: user.username, seat,
                    avatar: db.getUserById(user.id)?.avatar || null,
                    chips: vp.chips, currentBet: 0, buyIn: vp.buyIn, handsPlayed: vp.handsPlayed || 0,
                    folded: inHand, allIn: false, hasActed: false, ready: false, sittingOut: vp.chips <= 0
                });
                io.in(roomId).emit('server_msg', `🪑 ${user.username} 回到座位（${seat + 1} 号位）`);
                if (game.status === 'running' && !inHand && liveCount(game) >= 2) scheduleNextHand(roomId);
                broadcastState(roomId); broadcastRoomList();
                return;
            }
        }
        const p = game.players.find(pl => pl.userId === user.id);
        if (!p) return;
        if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
        p.away = false; p.reserved = false; p.standing = false;
        if (p.chips > 0) p.sittingOut = false;   // 有筹码才能立即回桌
        io.in(roomId).emit('server_msg', `🪑 ${user.username} 回到座位`);
        if (game.roomType === 'cash' && game.status === 'running'
            && (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) && liveCount(game) >= 2)
            scheduleNextHand(roomId);
        broadcastState(roomId);
    });

    // 退出房间，返回大厅
    socket.on('leave_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const idx = game.players.findIndex(p => p.userId === user.id);
            if (idx >= 0) {
                const p = game.players[idx];
                const midHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded;
                if (game.roomType === 'cash') {
                    // 训练赛：退出房间 = 站起离桌，保留座位+筹码，【不立即兑出】；
                    // 只在本局结束/解散/全员离开时统一结算金币。回大厅可随时「重新进入」
                    // 接上原座位、带入与盈亏（战绩不清零）。
                    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
                    p.standing = true; p.away = true; p.reserved = false; p.sittingOut = true;
                    socket.leave(roomId);
                    socket.emit('left_room');
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开牌桌（座位与筹码保留，结束时结算）`);
                    if (midHand) { p.folded = true; p.hasActed = true; }
                    // 全员离桌(无人在座)且无观众 → 直接结算收尾，避免空房悬挂持有筹码
                    const anyActive = game.players.some(pl => !pl.standing && !pl.away);
                    if (!anyActive && listSpectators(roomId).length === 0) {
                        endCashTable(roomId, '全员离开');
                    } else if (midHand) {
                        if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
                        else if (isBettingRoundComplete(game)) advanceStage(roomId);
                        else broadcastState(roomId);
                        broadcastRoomList();
                    } else { broadcastState(roomId); broadcastRoomList(); }
                } else if (game.status !== 'running') {
                    // SNG 开赛前退出：退还报名费、移除座位
                    if (game.config.buyIn > 0) {
                        const fresh = db.getUserById(user.id).gold;
                        db.setGold(user.id, fresh + game.config.buyIn);
                        game.prizePool = Math.max(0, (game.prizePool || 0) - game.config.buyIn);
                        user.gold = fresh + game.config.buyIn;
                        socket.emit('gold_update', { gold: user.gold });
                    }
                    game.players.splice(idx, 1);
                    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开房间`);
                    if (game.players.length === 0) {
                        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
                        clearActionTimer(game); delete roomGames[roomId];
                    } else broadcastState(roomId);
                } else {
                    // SNG 开赛后退出：保留座位（离桌挂机），本局自动弃牌推进
                    p.away = true;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离桌（座位保留，盲注照扣，可重连）`);
                    if (midHand) {
                        p.folded = true; p.hasActed = true;
                        if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
                        else if (isBettingRoundComplete(game)) advanceStage(roomId);
                        else broadcastState(roomId);
                    } else broadcastState(roomId);
                }
            } else {
                // 观众离开（现金桌未入座）：退出 socket.io 房间并刷新观众列表
                socket.leave(roomId);
                if (game.players.length === 0 && listSpectators(roomId).length <= 1) {
                    // 若还有站起围观者的筹码没结算，走 endCashTable 结算再关房，避免筹码/金币丢失
                    if ((game.vacatedPlayers || []).length) { endCashTable(roomId, '全员离开'); }
                    else {
                        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
                        clearActionTimer(game); delete roomGames[roomId];
                    }
                } else broadcastState(roomId);
            }
        }
        socket.currentRoom = null;
        lobbySockets.add(socket.id);
        socket.emit('left_room');
        socket.emit('room_list', listRooms(user.id));
        broadcastRoomList();
    });

    // 解散/提前结束：仅房主。现金桌=结算筹码+公布排名；SNG=奖池给筹码领先者+公布排名
    socket.on('dissolve_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以解散房间'); return; }

        if (game.roomType === 'cash') {
            io.in(roomId).emit('server_msg', `🛑 房主提前结束了比赛`);
            endCashTable(roomId, '房主提前结束');   // 结算 + 排名 + 收件箱
            return;
        }
        // SNG：奖池（抽水后）给当前筹码最多者，并公布排名
        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer); clearActionTimer(game);
        for (const p of game.players) if (p.reserveTimer) clearTimeout(p.reserveTimer);
        const prize = sngPrize(game.prizePool);
        const leader = [...game.players].sort((a, b) => b.chips - a.chips)[0];
        if (leader && prize > 0) {
            const fresh = db.getUserById(leader.userId).gold;
            db.setGold(leader.userId, fresh + prize);
            if (leader.socketId) io.to(leader.socketId).emit('gold_update', { gold: fresh + prize });
        }
        sendMatchResult(roomId, `【${game.config.name}】房主提前结束`, buildRanking(game, leader && leader.userId, prize));
        io.in(roomId).emit('server_msg', `🛑 房主解散了房间`);
        io.in(roomId).emit('room_dissolved');
        for (const p of game.players) {
            const s = io.sockets.sockets.get(p.socketId);
            if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('room_list', listRooms(p.userId)); }
        }
        delete roomGames[roomId];
        broadcastRoomList();
    });

    // 比赛加时（现金桌房主）：延长训练时长
    socket.on('extend_match', ({ minutes }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以加时'); return; }
        const m = clampInt(minutes, 0, 120, 0);
        if (m <= 0) return;
        extendTable(roomId, m * 60000);
        io.in(roomId).emit('server_msg', `⏱ 房主加时 ${m} 分钟`);
        broadcastState(roomId);
    });

    // 现金桌补码：金币按汇率买入筹码，下一手生效（不能超过带入上限）；可设自动补码
    socket.on('rebuy', ({ amount, auto }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game || game.roomType !== 'cash') return;
        const p = game.players.find(x => x.userId === user.id);
        if (!p) return;
        if (typeof auto === 'boolean') p.autoRebuy = auto;
        const maxB = game.config.maxBuyIn || 1e9;
        const cap = maxB - p.chips - (p.pendingRebuy || 0);
        if (amount === 0 || amount == null) {   // 仅切换自动补码、不补当前码
            io.in(roomId).emit('server_msg', `🔁 ${user.username} ${p.autoRebuy ? '开启' : '关闭'}自动补码`);
            broadcastState(roomId); return;
        }
        if (cap <= 0) { socket.emit('server_msg', '⚠️ 已达带入上限'); return; }
        const chips = clampInt(amount, gameBB(game), cap, Math.min(cap, game.config.minBuyIn));
        if (!chargeRebuy(p, chips)) { socket.emit('server_msg', `⚠️ 金币不足，补 ${chips} 筹码需 ${Math.ceil(chips * BUYIN_RATE)} 金币`); return; }
        user.gold = db.getUserById(user.id).gold;
        const between = game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN;
        const inActiveHand = !between && !p.folded;
        if (inActiveHand) {
            io.in(roomId).emit('server_msg', `💵 ${user.username} 补码 ${chips}（下一手生效）`);
        } else {
            // 不在牌局中：立即生效，回到座位
            p.chips += p.pendingRebuy; p.pendingRebuy = 0; p.sittingOut = false;
            io.in(roomId).emit('server_msg', `💵 ${user.username} 补码 ${chips} 筹码`);
            // 若比赛进行中且当前停摆，重新排下一手
            if (game.status === 'running' && between && liveCount(game) >= 2) scheduleNextHand(roomId);
        }
        broadcastState(roomId);
    });

    // 房主点「开始」：开赛前手动开局（≥2 名在座可玩玩家）
    socket.on('start_game', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以开始'); return; }
        if (game.status === 'running') { socket.emit('server_msg', '⚠️ 比赛已开始'); return; }
        if (liveCount(game) < 2) { socket.emit('server_msg', '⚠️ 至少 2 名玩家入座才能开始'); return; }
        startHand(roomId);
    });

    // 准备 / 取消准备：全员准备且 >=2 人时自动开局
    socket.on('toggle_ready', (roomId) => {
        const game = roomGames[roomId];
        if (!game) return;
        // 仅开赛前需要准备；比赛开始后自动续局，无需重新准备
        if (game.roomType === 'sng' && game.status === 'running') return;
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', '⚠️ 牌局进行中，无法更改准备状态'); return;
        }
        const p = game.players.find(p => p.userId === user.id);
        if (!p) { socket.emit('server_msg', '⚠️ 你还未入座'); return; }
        p.ready = !p.ready;
        io.in(roomId).emit('server_msg', `${p.ready ? '✅' : '⬜'} ${p.username} ${p.ready ? '已准备' : '取消准备'}`);
        broadcastState(roomId);
        tryStartHand(roomId);
    });

    // 主动亮牌：摊牌阶段（含弃牌结束的局间）玩家可选择亮出自己某张/全部底牌
    socket.on('show_card', ({ roomId, index }) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const hole = game.holeCards[user.id];
        if (!hole) return;
        index = parseInt(index);
        if (index !== 0 && index !== 1) return;
        game.shownCards = game.shownCards || {};
        const set = game.shownCards[user.id] || (game.shownCards[user.id] = new Set());
        if (set.has(index)) return;
        set.add(index);
        const shown = [...set].map(i => ({ index: i, suit: hole[i].suit, rank: hole[i].rank }));
        io.in(roomId).emit('show_cards', { userId: user.id, cards: shown });
        io.in(roomId).emit('server_msg', `👁️ ${user.username} 亮出一张牌`);
        // 每亮一张牌就重置局间倒计时，给大家看牌的时间
        scheduleNextHand(roomId);
    });

    // 看后续牌（rabbit hunt）：弃牌结束的局间，任一玩家可逐步发出剩余公共牌仅供观看
    socket.on('rabbit_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const n = game.communityCards.length;
        if (n >= 5) return;                       // 已到河牌（含真摊牌），无可发
        const count = n === 0 ? 3 : 1;            // 0→翻牌3张，3→转牌1张，4→河牌1张
        const dealt = dealCommunity(game, count);
        io.in(roomId).emit('server_msg', `🐰 看后续牌：${dealt.map(c => c.toString()).join(' ')}`);
        scheduleNextHand(roomId);                 // 重置局间倒计时，给看牌时间
        broadcastState(roomId);
    });

    // 桌内文字聊天：广播给同房间（含观众）。限频 + 长度限制
    socket.on('chat_msg', ({ text }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        text = (text || '').toString().slice(0, 120).trim();
        if (!text) return;
        const now = Date.now();
        if (now - (socket._lastChat || 0) < 600) return;   // 限频 0.6s
        socket._lastChat = now;
        io.in(roomId).emit('chat_broadcast', { userId: user.id, username: user.username, text, ts: now });
    });

    // 表情/互动：在发送者座位上方冒一个大表情（可带目标=扔给某人）。限频
    socket.on('emote', ({ emote, targetUserId }) => {
        const roomId = socket.currentRoom;
        if (!roomId || !roomGames[roomId]) return;
        if (typeof emote !== 'string' || emote.length > 8) return;
        const now = Date.now();
        if (now - (socket._lastEmote || 0) < 800) return;   // 限频 0.8s
        socket._lastEmote = now;
        io.in(roomId).emit('emote_broadcast', { userId: user.id, emote, targetUserId: targetUserId || null });
    });

    // 重连/刷新后只恢复尚在 10 秒展示期内的语音气泡，不构成聊天历史。
    socket.on('voice_sync', (roomId) => {
        roomId = String(roomId || '');
        if (socket.currentRoom !== roomId || !roomGames[roomId]) return;
        syncRecentVoices(socket, roomId);
    });

    socket.on('player_action', ({ roomId, action, amount }) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.actionOnIdx < 0 || game.players[game.actionOnIdx]?.userId !== user.id) {
            socket.emit('server_msg', '⚠️ 不是你的回合'); return;
        }

        const player = game.players[game.actionOnIdx];
        const tag = player.username;

        switch (action) {
            case 'fold':
                player.folded = true; player.hasActed = true;
                io.in(roomId).emit('server_msg', `❌ ${tag} 弃牌`);
                break;

            case 'check':
                if (player.currentBet < game.currentBet) {
                    socket.emit('server_msg', '⚠️ 有未跟注，不能 Check'); return;
                }
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `✓ ${tag} 过牌`);
                break;

            case 'call': {
                const toCall = game.currentBet - player.currentBet;
                if (toCall <= 0) { socket.emit('server_msg', '⚠️ 无需跟注'); return; }
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay; player.currentBet += pay;
                if (player.chips === 0) player.allIn = true;
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `📞 ${tag} 跟注 ${pay}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'bet': {
                if (game.currentBet > 0) { socket.emit('server_msg', '⚠️ 已有下注，请用 Raise'); return; }
                const betTo = parseInt(amount);
                const maxBet = player.currentBet + player.chips;   // 全下额
                const allInBet = betTo === maxBet;
                const minBet = gameBB(game);
                // 最小下注 = 大盲（不足大盲只能全下）
                if (!betTo || (betTo < minBet && !allInBet)) {
                    socket.emit('server_msg', `⚠️ 下注最少 ${minBet}`); return;
                }
                if (betTo > maxBet) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                player.chips -= betTo; player.currentBet = betTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = betTo;
                game.lastRaiseSize = betTo;   // 首注额即为后续最小加注增量基准
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `💸 ${tag} 下注 ${betTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'raise': {
                if (game.currentBet === 0) { socket.emit('server_msg', '⚠️ 无人下注，请用 Bet'); return; }
                const raiseTo = parseInt(amount);
                const maxRaise = player.currentBet + player.chips;          // 全下额
                const allInRaise = raiseTo === maxRaise;
                const minRaiseTo = game.currentBet + game.lastRaiseSize;    // 最小加注目标
                if (!raiseTo || raiseTo <= game.currentBet) {
                    socket.emit('server_msg', `⚠️ 加注须大于当前注 ${game.currentBet}`); return;
                }
                // 未达最小加注：仅当全下时允许（all-in for less）
                if (raiseTo < minRaiseTo && !allInRaise) {
                    socket.emit('server_msg', `⚠️ 至少加注到 ${minRaiseTo}（最小加注增量 ${game.lastRaiseSize}）`); return;
                }
                const needed = raiseTo - player.currentBet;
                if (needed > player.chips) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                const increment = raiseTo - game.currentBet;
                // 完整加注才刷新最小增量；all-in for less 不重开下注（保持原增量）
                if (increment >= game.lastRaiseSize) game.lastRaiseSize = increment;
                player.chips -= needed; player.currentBet = raiseTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = raiseTo;
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `🔼 ${tag} 加注到 ${raiseTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            default: return;
        }

        recordAction(game, player, action, player.currentBet);   // 牌谱

        // 行动音效
        let sfxType = action;
        if ((action === 'bet' || action === 'raise' || action === 'call') && player.allIn) sfxType = 'allin';
        io.in(roomId).emit('sfx', sfxType);

        clearActionTimer(game);   // 玩家已行动，取消其计时
        afterAction(roomId);
    });

    // 加时：仅当前行动玩家可用，单次行动累计上限 EXTRA_MAX
    socket.on('add_time', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.actionOnIdx < 0) return;
        if (game.players[game.actionOnIdx]?.userId !== user.id) return;
        if ((game.extraAddedThisTurn || 0) >= EXTRA_MAX) {
            socket.emit('server_msg', '⚠️ 本次行动加时已达上限'); return;
        }
        const add = Math.min(EXTRA_STEP, EXTRA_MAX - game.extraAddedThisTurn);
        game.extraAddedThisTurn += add;
        game.actionDeadline += add;
        game.actionTotalMs = (game.actionTotalMs || ACTION_TIME) + add;
        clearActionTimer(game);
        game.actionTimer = setTimeout(() => onActionTimeout(roomId), Math.max(0, game.actionDeadline - Date.now()));
        io.in(roomId).emit('server_msg', `⏱ ${user.username} 加时 +${add / 1000}s`);
        broadcastState(roomId);
    });

    socket.on('disconnect', () => {
        console.log(`[-] ${user.username} 下线`);
        lobbySockets.delete(socket.id);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        const player = game.players[idx];
        player.away = true;   // 标记掉线（座位保留，可重连）

        io.to(roomId).emit('server_msg', `🔌 ${user.username} 掉线（保留座位，可重连）`);

        // ⚠️ 不再「掉线即立即弃牌」！socket.io 网络抖动/传输切换会瞬断重连，
        // 立即弃牌会误杀正常玩家（表现为「闪回大厅再进来就成了弃牌」）。
        // 改为交给行动计时器兜底：
        //  · 若正轮到掉线者：保留当前计时不动，给重连留出时间；到点 onActionTimeout
        //    会「无注则自动过牌(留在局里)、有注才弃牌」——比无条件弃牌合理得多。
        //  · 若没轮到他：留在本局，等轮到他时 startActionTimer 见 away 走快速超时自动处理。
        // 重连(join_room)会把 away 置回 false 并（若轮到他）重启计时。
        broadcastState(roomId);
    });
});

const PORT = process.env.PORT || 3000;
const onListening = () => {
    const host = LOCAL_DEV ? '127.0.0.1' : '0.0.0.0';
    console.log(`🚀 扑克服务器已启动！${host}:${PORT}${LOCAL_DEV ? ' (本地开发模式)' : ''}`);
};
if (LOCAL_DEV) server.listen(PORT, '127.0.0.1', onListening);
else server.listen(PORT, onListening);
