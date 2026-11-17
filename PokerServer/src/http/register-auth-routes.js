'use strict';

const crypto = require('crypto');
const { extractIp } = require('../ops/client-ip');
const { createSendCodeLimiter } = require('../ops/send-code-limiter');
const { createFailureLimiter } = require('../ops/failure-limiter');
const { normalizeDisplayName } = require('../account/display-name');
const { refreshLiveUser } = require('../account/live-user');

function registerAuthRoutes({ app, db, bcrypt, mailer, signToken, userPayload, requireAuth, io, roomGames }) {
// 注册/登录来源埋点（2026-09-21）。两个用途：看用户分布在哪些地区、
// 以及将来防同一人开多账号（尤其是做了「邀请注册送金币」之后）。
// 🔴 **登录也要记**，不只是注册 —— 存量用户的注册 IP 已经永久丢了，
//    只有靠他们下次登录才能把来源补齐。
// ⚠️ 记录失败绝不能连累登录（record 内部已吞异常）。
const noteSource = (req, userId, kind) => {
    try { db.loginEvents.record({ userId, kind, ip: extractIp(req.headers, req.socket?.remoteAddress) }); }
    catch (e) { console.error('[login-event] 埋点异常', e.message); }
};
// 三个发码接口共用一个按 IP 的限流：它们烧的是同一份发信额度。见 send-code-limiter.js。
const sendLimiter = createSendCodeLimiter();
const ipBlocked = (req, res) => {
    const r = sendLimiter.check(extractIp(req.headers, req.socket?.remoteAddress));
    if (r.ok) return false;
    res.status(429).json({ error: '此网络请求验证码过于频繁，请稍后再试', k: 'sendTooOftenIp' });
    return true;
};
const pendingRegs   = {};   // email(lc) -> { username, email, hash, code, expires, lastSent }
const pendingResets = {};   // email(lc) -> { userId, code, expires, lastSent }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 请求体里的字段一律先当成「可能是任何类型」：传个对象 / 数组进来，原来 .trim() 直接抛错、接口回 500。
const str = (v) => (typeof v === 'string' ? v : '');
const gen6 = () => String(crypto.randomInt(100000, 1000000));
// 验证码输错次数上限。没有它的话 6 位数字可以在 10 分钟有效期里穷举 ——
// 找回密码那条尤其要紧：猜中就直接拿到登录令牌。错满就作废，要重新发码（发码有按 IP / 按邮箱的限流）。
const MAX_CODE_TRIES = 5;
function wrongCode(store, key, res) {
    const p = store[key];
    p.tries = (p.tries || 0) + 1;
    if (p.tries >= MAX_CODE_TRIES) {
        delete store[key];
        return res.status(429).json({ error: '验证码错误次数过多，请重新获取', k: 'codeTooMany' });
    }
    return res.status(400).json({ error: '验证码错误', k: 'codeWrong' });
}
// 注册资料的校验。注册和「游客保存账号」共用这一份 ——
// 两处各写一套的话规则迟早会漂移，而保存出来的账号必须和注册出来的【完全一样】，不能多出第三种账号。
// 返回 { fail: [状态码, 响应体] } 或 { username, email, password }（已规整）。
function checkSignup(body) {
    let { username, email, password } = body || {};
    username = str(username).trim(); email = str(email).trim().toLowerCase(); password = str(password);
    const fail = (status, error, k) => ({ fail: [status, { error, k }] });
    if (!username || !email || !password) return fail(400, '请填写用户名、邮箱和密码', 'signupFields');
    if (username.length < 2 || username.length > 20) return fail(400, '用户名 2-20 字符', 'nameLen');
    // 用户名会出现在别人的页面上（管理面板、点击事件里）。能拼出 HTML / 跳出 JS 字符串的字符一律不收：
    // 客户端该转义的地方都转了，这是第二道。现有用户名里一个都没有这些字符（2026-11-14 查过）。
    if (/[<>"'`&\\]/.test(username)) return fail(400, '用户名不能包含 < > " \' ` & \\ 这些符号', 'nameChars');
    // guest_ 开头留给游客号：否则有人注册一个 guest_xxx，和随机生成的游客用户名撞到一起
    if (/^guest_/i.test(username)) return fail(400, '用户名不能以 guest_ 开头', 'nameReserved');
    if (!EMAIL_RE.test(email)) return fail(400, '邮箱格式不正确', 'badEmail');
    if (password.length < 6) return fail(400, '密码至少 6 位', 'pwdShort');
    if (db.getUserByUsername(username)) return fail(409, '用户名已被注册', 'nameTaken');
    if (db.getUserByEmail(email)) return fail(409, '该邮箱已注册，可直接登录或找回密码', 'emailTakenHint');
    return { username, email, password };
}

// 注册第一步：校验 + 发验证码
app.post('/api/register/send-code', async (req, res) => {
    const checked = checkSignup(req.body);
    if (checked.fail) return res.status(checked.fail[0]).json(checked.fail[1]);
    const { username, email, password } = checked;
    const prev = pendingRegs[email];
    if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试', k: 'sendTooOften' });
    if (ipBlocked(req, res)) return;
    const code = gen6();
    const hash = await bcrypt.hash(password, 10);
    pendingRegs[email] = { username, email, hash, code, expires: Date.now() + 600000, lastSent: Date.now() };
    try { await mailer.sendCode(email, code, 'register'); }
    catch (e) { console.error('发信失败', e.message); return res.status(500).json({ error: '验证码发送失败，请稍后重试', k: 'sendFailed' }); }
    res.json({ ok: true, mailConfigured: mailer.isConfigured() });
});

// 注册第二步：验证码正确则建号
app.post('/api/register/verify', async (req, res) => {
    let { email, code } = req.body || {};
    email = str(email).trim().toLowerCase();
    const p = pendingRegs[email];
    if (!p) return res.status(400).json({ error: '请先获取验证码', k: 'needCode' });
    if (Date.now() > p.expires) { delete pendingRegs[email]; return res.status(400).json({ error: '验证码已过期，请重新获取', k: 'codeExpiredNew' }); }
    if (String(code).trim() !== p.code) return wrongCode(pendingRegs, email, res);
    try {
        const user = db.createUser(p.username, p.hash, false, p.email);
        noteSource(req, user.id, 'signup');
        delete pendingRegs[email];
        res.json({ token: signToken(user), user: userPayload(user) });
    } catch (err) {
        if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: '用户名已被注册', k: 'nameTaken' });
        if (err.message?.includes('EMAIL')) return res.status(409).json({ error: '该邮箱已注册', k: 'emailTaken' });
        console.error(err); res.status(500).json({ error: '服务器错误', k: 'serverError' });
    }
});

// 登录：用户名或邮箱 + 密码
// 🔴 限流（2026-09-30，防暴力试密码 / 撞库）。原来登录接口完全没有限流：可以对一个账号无限次试密码，
//    而每次 bcrypt 比对都要吃几十毫秒 CPU —— 刷登录本身就能把 1GB 的小机器拖垮。只数【失败】：
//    · 同一 IP：15 分钟 30 次（手机 CGNAT 一个出口很多人，不能太紧）
//    · 同一 IP × 同一账号：15 分钟 8 次（真正拦住「对着一个号猜」）
//    · 同一账号（不分 IP）：15 分钟 60 次（分布式慢慢猜也有上限；定得宽，免得别人故意输错把你锁在门外）
//    账号维度用【输入的名字】做 key，不管这个号存不存在 —— 否则「会不会被限流」本身就泄露账号是否注册过。
//    闸挡在 bcrypt 之前：被挡住的请求一点 CPU 都不花。成功登录清掉「这个 IP × 这个号」的计数。
const WIN15 = 15 * 60 * 1000;
const loginByIp = createFailureLimiter({ max: 30, windowMs: WIN15 });
const loginByIpAcct = createFailureLimiter({ max: 8, windowMs: WIN15 });
const loginByAcct = createFailureLimiter({ max: 60, windowMs: WIN15 });
// 账号不存在时也做一次同样耗时的比对：否则「不存在 → 立刻返回」比「存在但密码错」快得多，
// 量一下响应时间就能枚举出哪些用户名注册过。成本 10 与真实密码哈希一致。
const DUMMY_HASH = bcrypt.hashSync('pokerdojo-timing-equalizer', 10);
app.post('/api/login', async (req, res) => {
    let { username, password } = req.body || {};
    username = str(username).trim(); password = str(password);
    if (!username || !password) return res.status(400).json({ error: '请填写账号和密码', k: 'loginFields' });
    const ip = extractIp(req.headers, req.socket?.remoteAddress) || '(unknown)';
    const acct = username.toLowerCase().slice(0, 120);
    const keys = [[loginByIp, ip], [loginByIpAcct, ip + '|' + acct], [loginByAcct, acct]];
    const blocked = keys.map(([l, k]) => l.check(k)).find(r => !r.ok);
    if (blocked) {
        const minutes = Math.max(1, Math.ceil(blocked.retryAfterMs / 60000));
        return res.status(429).json({ error: `尝试次数过多，请 ${minutes} 分钟后再试`, k: 'loginTooMany', p: { minutes } });
    }
    const found = username.includes('@') ? db.getUserByEmail(username) : db.getUserByUsername(username);
    // 游客号没有密码，不能用「用户名 + 密码」登录：当成不存在处理（照样做一次等时比对）。
    // 它的 password_hash 不是 bcrypt 哈希，本来就比不中；这里显式排除，是不想把这件事押在库的行为上。
    const user = found && !found.isGuest ? found : null;
    const ok = await bcrypt.compare(String(password), user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
        keys.forEach(([l, k]) => l.fail(k));
        return res.status(401).json({ error: '账号或密码错误', k: 'badLogin' });
    }
    loginByIpAcct.clear(ip + '|' + acct);
    noteSource(req, user.id, 'login');
    res.json({ token: signToken(user), user: userPayload(user) });
});

// 忘记密码第一步：发重置验证码
app.post('/api/forgot/send-code', async (req, res) => {
    let { email } = req.body || {};
    email = str(email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确', k: 'badEmail' });
    // ⚠️ IP 闸必须在查邮箱【之前】：放在后面的话，「被限流 / 没被限流」本身就泄露了邮箱是否注册过
    if (ipBlocked(req, res)) return;
    const user = db.getUserByEmail(email);
    // 不泄露邮箱是否存在：一律回 ok；仅存在时才真的发
    if (user) {
        const prev = pendingResets[email];
        if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试', k: 'sendTooOften' });
        const code = gen6();
        pendingResets[email] = { userId: user.id, code, expires: Date.now() + 600000, lastSent: Date.now() };
        try { await mailer.sendCode(email, code, 'reset'); } catch (e) { console.error('发信失败', e.message); }
    }
    res.json({ ok: true });
});

// 忘记密码第二步：验证码 + 新密码
app.post('/api/forgot/reset', async (req, res) => {
    let { email, code, newPassword } = req.body || {};
    email = str(email).trim().toLowerCase();
    newPassword = str(newPassword);
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位', k: 'newPwdShort' });
    const p = pendingResets[email];
    if (!p) return res.status(400).json({ error: '请先获取验证码', k: 'needCode' });
    if (Date.now() > p.expires) { delete pendingResets[email]; return res.status(400).json({ error: '验证码已过期', k: 'codeExpired' }); }
    if (String(code).trim() !== p.code) return wrongCode(pendingResets, email, res);
    const hash = await bcrypt.hash(newPassword, 10);
    db.setPassword(p.userId, hash);
    delete pendingResets[email];
    const user = db.getUserById(p.userId);
    res.json({ token: signToken(user), user: userPayload(user) });
});

// 绑定/更换邮箱（已登录用户）：老账号补邮箱以启用找回密码
const pendingBinds = {};   // userId -> { email, code, expires, lastSent }
// 🔴 改绑邮箱必须输入当前密码（2026-11-14）。
//    原来只要登录着就能改：偷到一个登录令牌（30 天有效）的人，先把邮箱改成自己的，
//    再走「忘记密码」—— 账号就永久归他了，原主人连找回都找不回来。
//    密码输错按账号计数：15 分钟内错 5 次就先停，免得这里变成一个猜密码的入口。
const bindPwdFails = new Map();   // userId -> [时间戳]
const BIND_PWD_MAX = 5, BIND_PWD_WINDOW = 15 * 60 * 1000;
app.post('/api/bind-email/send-code', requireAuth, async (req, res) => {
    let { email, password } = req.body || {};
    email = str(email).trim().toLowerCase();
    password = str(password);
    if (!password) return res.status(400).json({ error: '请输入当前密码', k: 'bindNeedPwd' });
    const now = Date.now();
    const fails = (bindPwdFails.get(req.authUser.id) || []).filter(t => now - t < BIND_PWD_WINDOW);
    if (fails.length >= BIND_PWD_MAX) return res.status(429).json({ error: '密码错误次数过多，请 15 分钟后再试', k: 'bindPwdTooMany' });
    let pwdOk = false;
    try { pwdOk = await bcrypt.compare(password, req.authUser.password_hash || ''); } catch { pwdOk = false; }
    if (!pwdOk) {
        fails.push(now); bindPwdFails.set(req.authUser.id, fails);
        return res.status(403).json({ error: '密码不正确', k: 'delBadPwd' });
    }
    bindPwdFails.delete(req.authUser.id);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确', k: 'badEmail' });
    const existing = db.getUserByEmail(email);
    if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: '该邮箱已被其他账号绑定', k: 'emailOther' });
    const prev = pendingBinds[req.authUser.id];
    if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试', k: 'sendTooOften' });
    if (ipBlocked(req, res)) return;
    const code = gen6();
    pendingBinds[req.authUser.id] = { email, code, expires: Date.now() + 600000, lastSent: Date.now() };
    try { await mailer.sendCode(email, code, 'bind'); }
    catch (e) { console.error('发信失败', e.message); return res.status(500).json({ error: '验证码发送失败，请稍后重试', k: 'sendFailed' }); }
    res.json({ ok: true });
});
app.post('/api/bind-email/verify', requireAuth, (req, res) => {
    const p = pendingBinds[req.authUser.id];
    if (!p) return res.status(400).json({ error: '请先获取验证码', k: 'needCode' });
    if (Date.now() > p.expires) { delete pendingBinds[req.authUser.id]; return res.status(400).json({ error: '验证码已过期', k: 'codeExpired' }); }
    if (String((req.body || {}).code).trim() !== p.code) return wrongCode(pendingBinds, req.authUser.id, res);
    const existing = db.getUserByEmail(p.email);
    if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: '该邮箱已被占用', k: 'emailInUse' });
    db.setEmail(req.authUser.id, p.email);
    delete pendingBinds[req.authUser.id];
    res.json({ ok: true, email: p.email });
});

// ===== 游客（2026-11-17）=====
// 只填一个昵称就能进来打牌。游客是 users 表里 is_guest=1 的一行（见 006-guests.sql），
// 身份只靠浏览器里那个令牌 —— 所以客户端在四处提醒「保存账号」（常驻提示 / 打过几手后 / 点受限功能时 / 退出前）。
//
// 按 IP 限流：游客号不要邮箱，建号没有任何成本。每个新号有 1 万金币、能占一个房间名额，
// 不限的话一个脚本就能把用户表和房间名额刷满。一小时 20 个：一间宿舍、一桌人同时点进来够用。
const guestLimiter = createSendCodeLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
app.post('/api/guest', (req, res) => {
    const name = normalizeDisplayName((req.body || {}).name);
    if (!name) return res.status(400).json({ error: '昵称须为 2–16 个字符，仅支持中文、字母、数字、空格、_、-、.', k: 'nameFormat' });
    if (!guestLimiter.check(extractIp(req.headers, req.socket?.remoteAddress)).ok) {
        return res.status(429).json({ error: '此网络创建游客账号过于频繁，请稍后再试，或直接注册', k: 'guestTooMany' });
    }
    try {
        const user = db.createGuest(name);
        noteSource(req, user.id, 'signup');
        console.log(`[guest] 新游客 ${user.username}`);
        res.json({ token: signToken(user), user: userPayload(user) });
    } catch (err) { console.error(err); res.status(500).json({ error: '服务器错误', k: 'serverError' }); }
});

// 游客「保存账号」：两步，和注册完全一样（同一份 checkSignup、同样要邮箱验证码），
// 区别只在最后一步 —— 不新建一行，而是把资料补到游客自己那一行上（db.upgradeGuest）。
// 🔴 只有游客能走这条路。正式账号拿着令牌调这里必须被拒：否则它就是一个不用输旧密码的改密后门。
const pendingUpgrades = {};   // userId -> { username, email, hash, code, expires, lastSent }
const NOT_GUEST = { error: '这个账号已经是正式账号了', k: 'notGuest' };
app.post('/api/guest/upgrade/send-code', requireAuth, async (req, res) => {
    if (!req.authUser.isGuest) return res.status(403).json(NOT_GUEST);
    const checked = checkSignup(req.body);
    if (checked.fail) return res.status(checked.fail[0]).json(checked.fail[1]);
    const { username, email, password } = checked;
    const prev = pendingUpgrades[req.authUser.id];
    if (prev && Date.now() - prev.lastSent < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试', k: 'sendTooOften' });
    if (ipBlocked(req, res)) return;
    const code = gen6();
    const hash = await bcrypt.hash(password, 10);
    pendingUpgrades[req.authUser.id] = { username, email, hash, code, expires: Date.now() + 600000, lastSent: Date.now() };
    try { await mailer.sendCode(email, code, 'register'); }
    catch (e) { console.error('发信失败', e.message); return res.status(500).json({ error: '验证码发送失败，请稍后重试', k: 'sendFailed' }); }
    res.json({ ok: true, mailConfigured: mailer.isConfigured() });
});
app.post('/api/guest/upgrade/verify', requireAuth, (req, res) => {
    const id = req.authUser.id;
    if (!req.authUser.isGuest) return res.status(403).json(NOT_GUEST);
    const p = pendingUpgrades[id];
    if (!p) return res.status(400).json({ error: '请先获取验证码', k: 'needCode' });
    if (Date.now() > p.expires) { delete pendingUpgrades[id]; return res.status(400).json({ error: '验证码已过期，请重新获取', k: 'codeExpiredNew' }); }
    if (String((req.body || {}).code).trim() !== p.code) return wrongCode(pendingUpgrades, id, res);
    try {
        const user = db.upgradeGuest(id, { username: p.username, email: p.email, passwordHash: p.hash });
        if (!user) return res.status(403).json(NOT_GUEST);
        delete pendingUpgrades[id];
        // 他可能正坐在牌桌上：把内存里认识他的地方一起改过来，不用断线重连
        refreshLiveUser({ io, roomGames, user });
        console.log(`[guest] 游客转正 → ${user.username}`);
        res.json({ token: signToken(user), user: userPayload(user) });
    } catch (err) {
        // 从发码到验码之间，用户名 / 邮箱被别人抢先用了。游客那一行没有被改动（一条 UPDATE 是原子的）。
        if (err.message?.includes('EMAIL')) return res.status(409).json({ error: '该邮箱已注册', k: 'emailTaken' });
        if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: '用户名已被注册', k: 'nameTaken' });
        console.error(err); res.status(500).json({ error: '服务器错误', k: 'serverError' });
    }
});

}

module.exports = { registerAuthRoutes };
