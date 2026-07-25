'use strict';

function registerAuthRoutes({ app, db, bcrypt, mailer, signToken, userPayload, requireAuth }) {
const pendingRegs   = {};   // email(lc) -> { username, email, hash, code, expires, lastSent }
const pendingResets = {};   // email(lc) -> { userId, code, expires, lastSent }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
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

}

module.exports = { registerAuthRoutes };
