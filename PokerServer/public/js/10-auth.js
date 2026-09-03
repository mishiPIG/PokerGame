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
    if (!username || !password) return setAuthError(L('请填写账号和密码', 'Enter your username and password'));
    try {
        const { ok, data } = await authPost('/api/login', { username, password });
        if (!ok) return setAuthError(data.error || L('登录失败', 'Login failed'));
        onAuthSuccess(data);
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
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
    if (!username || !email || !password) return setAuthError(L('请填写用户名、邮箱和密码', 'Enter username, email and password'));
    setAuthError(L('发送中…', 'Sending…'));
    try {
        const { ok, data } = await authPost('/api/register/send-code', { username, email, password });
        if (!ok) return setAuthError(data.error || L('发送失败', 'Failed to send'));
        regEmail = email;
        document.getElementById('reg-step1').style.display = 'none';
        document.getElementById('reg-step2').style.display = '';
        document.getElementById('reg-sent-hint').textContent =
            data.mailConfigured === false ? L('测试模式：验证码已打到服务器日志（未配置发信）', 'Test mode: code printed to the server log (email not configured)') : L(`验证码已发送到 ${email}，请查收（含垃圾箱）`, `Code sent to ${email} — check your inbox (and spam)`);
        setAuthError('');
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
}
async function regVerify() {
    const code = document.getElementById('reg-code').value.trim();
    if (!code) return setAuthError(L('请输入验证码', 'Enter the code'));
    try {
        const { ok, data } = await authPost('/api/register/verify', { email: regEmail, code });
        if (!ok) return setAuthError(data.error || L('验证失败', 'Verification failed'));
        onAuthSuccess(data);
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
}

// ── 忘记密码（两步）──
let fgEmail = '';
async function fgSendCode() {
    const email = document.getElementById('fg-email').value.trim();
    if (!email) return setAuthError(L('请输入注册邮箱', 'Enter your registered email'));
    setAuthError(L('发送中…', 'Sending…'));
    try {
        const { ok, data } = await authPost('/api/forgot/send-code', { email });
        if (!ok) return setAuthError(data.error || L('发送失败', 'Failed to send'));
        fgEmail = email;
        document.getElementById('fg-step1').style.display = 'none';
        document.getElementById('fg-step2').style.display = '';
        document.getElementById('fg-sent-hint').textContent = L(`若该邮箱已注册，验证码已发送到 ${email}`, `If that email is registered, a code has been sent to ${email}`);
        setAuthError('');
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
}
async function fgReset() {
    const code = document.getElementById('fg-code').value.trim();
    const newPassword = document.getElementById('fg-pass').value;
    if (!code || !newPassword) return setAuthError(L('请输入验证码和新密码', 'Enter the code and a new password'));
    try {
        const { ok, data } = await authPost('/api/forgot/reset', { email: fgEmail, code, newPassword });
        if (!ok) return setAuthError(data.error || L('重置失败', 'Reset failed'));
        onAuthSuccess(data);
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
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
