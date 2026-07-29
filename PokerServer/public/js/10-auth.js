// ===== Auth =====
function showTab(tab) {
    document.getElementById('tab-login').style.display    = tab === 'login'    ? '' : 'none';
    document.getElementById('tab-register').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('tab-forgot').style.display   = tab === 'forgot'   ? '' : 'none';
    document.querySelectorAll('.auth-tab').forEach((b, i) =>
        b.classList.toggle('active', (tab === 'register') ? i === 1 : i === 0));   // forgot 高亮登录页
    if (tab === 'register') regBack();
    if (tab === 'forgot') { document.getElementById('fg-step1').style.display = ''; document.getElementById('fg-step2').style.display = 'none'; }
    document.getElementById('auth-error').textContent = '';
}
async function authPost(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch {}
    return { ok: res.ok, data };
}

function setAuthError(msg) {
    document.getElementById('auth-error').textContent = msg;
}

async function doLogin() {
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    if (!username || !password) return setAuthError('请填写账号和密码');
    try {
        const { ok, data } = await authPost('/api/login', { username, password });
        if (!ok) return setAuthError(data.error || '登录失败');
        onAuthSuccess(data);
    } catch { setAuthError('网络错误，请重试'); }
}

// ── 注册（邮箱验证码，两步）──
let regEmail = '';
function regBack() {
    document.getElementById('reg-step1').style.display = '';
    document.getElementById('reg-step2').style.display = 'none';
    setAuthError('');
}
async function regSendCode() {
    const username = document.getElementById('reg-user').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-pass').value;
    if (!username || !email || !password) return setAuthError('请填写用户名、邮箱和密码');
    setAuthError('发送中…');
    try {
        const { ok, data } = await authPost('/api/register/send-code', { username, email, password });
        if (!ok) return setAuthError(data.error || '发送失败');
        regEmail = email;
        document.getElementById('reg-step1').style.display = 'none';
        document.getElementById('reg-step2').style.display = '';
        document.getElementById('reg-sent-hint').textContent =
            data.mailConfigured === false ? `测试模式：验证码已打到服务器日志（未配置发信）` : `验证码已发送到 ${email}，请查收（含垃圾箱）`;
        setAuthError('');
    } catch { setAuthError('网络错误，请重试'); }
}
async function regVerify() {
    const code = document.getElementById('reg-code').value.trim();
    if (!code) return setAuthError('请输入验证码');
    try {
        const { ok, data } = await authPost('/api/register/verify', { email: regEmail, code });
        if (!ok) return setAuthError(data.error || '验证失败');
        onAuthSuccess(data);
    } catch { setAuthError('网络错误，请重试'); }
}

// ── 忘记密码（两步）──
let fgEmail = '';
async function fgSendCode() {
    const email = document.getElementById('fg-email').value.trim();
    if (!email) return setAuthError('请输入注册邮箱');
    setAuthError('发送中…');
    try {
        const { ok, data } = await authPost('/api/forgot/send-code', { email });
        if (!ok) return setAuthError(data.error || '发送失败');
        fgEmail = email;
        document.getElementById('fg-step1').style.display = 'none';
        document.getElementById('fg-step2').style.display = '';
        document.getElementById('fg-sent-hint').textContent = `若该邮箱已注册，验证码已发送到 ${email}`;
        setAuthError('');
    } catch { setAuthError('网络错误，请重试'); }
}
async function fgReset() {
    const code = document.getElementById('fg-code').value.trim();
    const newPassword = document.getElementById('fg-pass').value;
    if (!code || !newPassword) return setAuthError('请输入验证码和新密码');
    try {
        const { ok, data } = await authPost('/api/forgot/reset', { email: fgEmail, code, newPassword });
        if (!ok) return setAuthError(data.error || '重置失败');
        onAuthSuccess(data);
    } catch { setAuthError('网络错误，请重试'); }
}

function onAuthSuccess({ token, user }) {
    localStorage.setItem('token', token);
    myUserId   = user.id;
    myUsername = user.username;
    myDisplayName = user.displayName || user.username;
    myDisplayNameChangedAtMs = user.displayNameChangedAtMs || null;
    myGold     = user.gold;
    isAdmin    = !!user.isAdmin;
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('game-section').style.display = '';
    document.getElementById('admin-toggle').style.display = isAdmin ? '' : 'none';
    updateUserBar();
    connectSocket(token);
}

function doLogout() {
    cancelVoiceRecording();
    stopVoicePlayback();
    localStorage.removeItem('token');
    if (socket) { socket.disconnect(); socket = null; }
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('game-section').style.display = 'none';
    myHoleCards = []; revealedCards = {}; currentRoom = '';
    lastState = null; prevCommunityCount = 0;
    holeJustDealt = false; revealJustHappened = false;
    localStorage.removeItem('currentRoom');
    document.getElementById('lobby-view').style.display = '';
    document.getElementById('table-view').style.display = 'none';
}
