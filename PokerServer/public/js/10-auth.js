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
        if (!ok) return setAuthError(apiErr(data, '登录失败', 'Login failed'));
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
        if (!ok) return setAuthError(apiErr(data, '发送失败', 'Failed to send'));
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
        const { ok, data } = await authPost('/api/register/verify', { email: regEmail, code, shareRef: peekShareRef() });
        if (!ok) return setAuthError(apiErr(data, '验证失败', 'Verification failed'));
        clearShareRef();
        try { localStorage.setItem('newAccount', '1'); } catch { /* 只影响新手提示，存不了就不显示 */ }   // 第一次进桌给三步提示
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
        if (!ok) return setAuthError(apiErr(data, '发送失败', 'Failed to send'));
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
        if (!ok) return setAuthError(apiErr(data, '重置失败', 'Reset failed'));
        onAuthSuccess(data);
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
}

// ── 游客：只填一个昵称就进来（2026-11-17）──
// 昵称框预填一个随机名字：不想起名的人直接点按钮就行，一步都不多。
function randomGuestName() {
    // i18n-ok: 成对的 zh/en 数据表（下一行按界面语言取其中一列）
    const zh = ['同花', '顺子', '葫芦', '河牌', '翻牌', '庄位', '大盲', '黑桃', '红心', '梅花'];
    const en = ['Ace', 'King', 'Queen', 'Jack', 'River', 'Flop', 'Button', 'Flush', 'Spade', 'Club'];
    const words = L(zh, en);
    return words[Math.floor(Math.random() * words.length)] + String(10 + Math.floor(Math.random() * 90));
}
function initGuestEntry() {
    const input = document.getElementById('guest-name');
    if (input && !input.value) input.value = randomGuestName();
    // 是点朋友的邀请链接进来的：说清楚「填个昵称就能进那一桌」，别让人以为还得先注册
    const hint = document.getElementById('invite-hint');
    if (hint) hint.style.display = pendingInviteToken ? '' : 'none';
}
async function doGuest() {
    const input = document.getElementById('guest-name');
    const name = (input.value || '').trim() || randomGuestName();
    const btn = document.getElementById('guest-go');
    btn.disabled = true;          // 防连点：点两下会建出两个游客号
    setAuthError('');
    try {
        const { ok, data } = await authPost('/api/guest', { name, shareRef: peekShareRef() });
        if (!ok) return setAuthError(apiErr(data, '进入失败，请重试', 'Could not start, please try again'));
        clearShareRef();
        onAuthSuccess(data);
    } catch { setAuthError(L('网络错误，请重试', 'Network error, please try again')); }
    finally { btn.disabled = false; }
}

// ── 游客「保存账号」──
// 和注册同样两步（资料 → 邮箱验证码），区别是补在游客自己那个账号上：筹码、牌谱、战绩都不动。
function openSaveAccount() {
    if (!isGuest) return;
    saveAccountBack();
    document.getElementById('save-account-modal').style.display = 'flex';
}
function closeSaveAccount() { document.getElementById('save-account-modal').style.display = 'none'; }
function setSaMsg(m) { document.getElementById('sa-msg').textContent = m || ''; }
function saveAccountStep(n) {
    document.getElementById('sa-step1').style.display = n === 1 ? '' : 'none';
    document.getElementById('sa-step2').style.display = n === 2 ? '' : 'none';
    document.getElementById('sa-send').style.display = n === 1 ? '' : 'none';
    document.getElementById('sa-done').style.display = n === 2 ? '' : 'none';
}
function saveAccountBack() { saveAccountStep(1); setSaMsg(''); }
async function saveAccountSend() {
    const username = document.getElementById('sa-user').value.trim();
    const email = document.getElementById('sa-email').value.trim();
    const password = document.getElementById('sa-pass').value;
    if (!username || !email || !password) return setSaMsg(L('请填写用户名、邮箱和密码', 'Enter username, email and password'));
    setSaMsg(L('发送中…', 'Sending…'));
    try {
        const { ok, data } = await authPostToken('/api/guest/upgrade/send-code', { username, email, password });
        if (!ok) return setSaMsg(apiErr(data, '发送失败', 'Failed to send'));
        saveAccountStep(2);
        setSaMsg(data.mailConfigured === false
            ? L('测试模式：验证码已打到服务器日志（未配置发信）', 'Test mode: code printed to the server log (email not configured)')
            : L(`验证码已发送到 ${email}，请查收（含垃圾箱）`, `Code sent to ${email} — check your inbox (and spam)`));
        document.getElementById('sa-code').focus();
    } catch { setSaMsg(L('网络错误，请重试', 'Network error, please try again')); }
}
async function saveAccountVerify() {
    const code = document.getElementById('sa-code').value.trim();
    if (!code) return setSaMsg(L('请输入验证码', 'Enter the code'));
    try {
        const { ok, data } = await authPostToken('/api/guest/upgrade/verify', { code });
        if (!ok) return setSaMsg(apiErr(data, '验证失败', 'Verification failed'));
        // 已经是正式账号了。账号还是同一个（id 没变），所以牌桌 / 连接都不用动 ——
        // 只换掉本地的令牌和「我是游客」这个状态。服务端那边已经把在线连接上的身份一起改了。
        localStorage.setItem('token', data.token);
        if (socket) socket.auth = { token: data.token };   // 之后断线重连用新令牌
        myUsername = data.user.username;
        setGuest(false);
        try { localStorage.removeItem('guestHands'); localStorage.removeItem('guestNudgeAt'); } catch {}
        closeSaveAccount();
        updateUserBar();
        if (document.getElementById('profile-overlay').style.display !== 'none') renderProfileInfo();
        refreshCheckinDot();
        socket?.emit('friend_list');
        toast(L('✅ 账号已保存。以后用用户名或邮箱 + 密码就能登录', '✅ Account saved. Sign in with your username or email and password from now on'), 5000);
    } catch { setSaMsg(L('网络错误，请重试', 'Network error, please try again')); }
}

// ── 提醒游客保存账号 ──
// 游客的身份只在这个浏览器里。打过几手牌、有了舍不得丢的东西之后提醒一次最合适：
// 一进来就催等于又把注册表摆到了门口。每 24 小时最多提醒一次。
// 手数记在 localStorage：打完直接关页面的人，下次打开回到大厅时也能提醒到。
const GUEST_NUDGE_HANDS = 5;
function noteGuestHand() {
    if (!isGuest) return;
    try { localStorage.setItem('guestHands', String((parseInt(localStorage.getItem('guestHands'), 10) || 0) + 1)); } catch {}
}
function maybeNudgeGuest() {
    if (!isGuest) return;
    let hands = 0, last = 0;
    try { hands = parseInt(localStorage.getItem('guestHands'), 10) || 0; last = parseInt(localStorage.getItem('guestNudgeAt'), 10) || 0; } catch {}
    if (hands < GUEST_NUDGE_HANDS || Date.now() - last < 86400000) return;
    try { localStorage.setItem('guestNudgeAt', String(Date.now())); } catch {}
    uiConfirm(L(`你已经以游客身份打了 ${hands} 手牌。保存账号后，筹码、牌谱和战绩才不会因为换浏览器或清缓存而丢失。`,
        `You have played ${hands} hands as a guest. Save your account so your chips, hand history and stats survive a new browser or cleared cache.`),
        { ok: L('保存账号', 'Save account'), cancel: L('以后再说', 'Later') })
        .then(yes => { if (yes) openSaveAccount(); });
}

function onAuthSuccess({ token, user }) {
    localStorage.setItem('token', token);
    myUserId   = user.id;
    myUsername = user.username;
    myDisplayName = user.displayName || user.username;
    myDisplayNameChangedAtMs = user.displayNameChangedAtMs || null;
    myGold     = user.gold;
    isAdmin    = !!user.isAdmin;
    setGuest(user.isGuest);
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('game-section').style.display = '';
    document.getElementById('admin-toggle').style.display = isAdmin ? '' : 'none';
    updateUserBar();
    connectSocket(token);
}

async function doLogout() {
    // 🔴 游客退出登录 = 丢号。他没有密码，令牌一清，这个账号就再也进不来了（筹码和牌谱一起）。
    //    所以必须先说清楚后果。「点外面 / 取消」= 不退出：这个确认框的默认结果必须是安全的那个。
    if (isGuest) {
        const sure = await uiConfirm(
            L('你现在是游客。退出登录后，这个账号就再也进不来了，筹码和牌谱会一起丢失。\n想保留的话，先点「我的 → 保存账号」。',
              'You are playing as a guest. If you sign out, this account is gone for good, along with its chips and hand history.\nTo keep it, tap "Me → Save account" first.'),
            { ok: L('仍然退出', 'Sign out anyway'), cancel: L('先不退出', 'Stay'), danger: true });
        if (!sure) return;
    }
    cancelVoiceRecording();
    stopVoicePlayback();
    setGuest(false);
    try { localStorage.removeItem('guestHands'); localStorage.removeItem('guestNudgeAt'); } catch {}
    localStorage.removeItem('token');
    if (socket) { socket.disconnect(); socket = null; }
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('game-section').style.display = 'none';
    myHoleCards = []; revealedCards = {}; currentRoom = '';
    lastState = null; prevCommunityCount = 0;
    holeJustDealt = false; revealJustHappened = false;
    dealFx = null; revealFx = null; allinSpot = false;
    localStorage.removeItem('currentRoom');
    document.getElementById('lobby-view').style.display = '';
    document.getElementById('table-view').style.display = 'none';
    initGuestEntry();
}
