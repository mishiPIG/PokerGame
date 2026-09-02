// ===== 音效（Web Audio，无需音频文件）=====
let soundOn = localStorage.getItem('soundOff') !== '1';
let audioCtx = null;
function ac() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    return audioCtx;
}
// iOS Safari 只能在用户手势中可靠地恢复音频；回到前台时也尽力恢复已解锁的上下文。
function resumeAudio(createIfNeeded = false) {
    const ctx = audioCtx || (createIfNeeded ? ac() : null);
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
        const resumed = ctx.resume();
        if (resumed?.catch) resumed.catch(() => {});
    }
    return ctx;
}
function unlockAudio() { return resumeAudio(true); }
function beep(freq, durMs, type = 'sine', gain = 0.15, delay = 0) {
    if (!soundOn) return;
    const ctx = resumeAudio(); if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t); osc.stop(t + durMs / 1000 + 0.02);
}
function sndDeal(i = 0) { beep(520, 55, 'square', 0.06, i * 0.12); }   // 发牌嗒
function sndTurn()      { beep(880, 130, 'sine', 0.22); }               // 轮到你：叮
function sndWarn()      { beep(440, 110, 'triangle', 0.22); beep(440, 110, 'triangle', 0.22, 0.16); } // 5s 警告
function sndFlip(i = 0) { beep(600, 70, 'square', 0.09, i * 0.13); beep(900, 50, 'sine', 0.05, i * 0.13 + 0.02); } // 翻公共牌
function sndFold()     { beep(300, 90, 'sawtooth', 0.12); beep(200, 130, 'sawtooth', 0.1, 0.06); }  // 弃牌嗖
function sndShow()     { beep(700, 60, 'triangle', 0.12); beep(1050, 90, 'sine', 0.12, 0.05); }       // 亮牌叮
function sndClick()    { beep(660, 30, 'sine', 0.05); }                                                // 按钮点击反馈
function sndSit()      { beep(523, 90, 'sine', 0.16); beep(784, 130, 'sine', 0.16, 0.09); beep(1047, 160, 'sine', 0.13, 0.2); } // 坐下入座：上扬三音
function sndBet()      { beep(420, 60, 'square', 0.1); beep(620, 70, 'square', 0.1, 0.06); }           // 下注：推两枚筹码
function sndRaise()    { beep(500, 55, 'square', 0.1); beep(720, 60, 'square', 0.1, 0.06); beep(960, 85, 'square', 0.11, 0.13); } // 加注：三连上扬（比下注更进一步）
function sndCall()     { beep(520, 70, 'square', 0.1); }                                                // 跟注
function sndCheck()    { beep(180, 70, 'sine', 0.14); beep(150, 90, 'sine', 0.12, 0.07); }             // 过牌：敲桌
function sndAllin()    { beep(330, 120, 'sawtooth', 0.16); beep(495, 140, 'sawtooth', 0.16, 0.1); beep(660, 200, 'sawtooth', 0.16, 0.22); } // 全下：上扬
function sndWin()      { [523, 659, 784, 1047].forEach((f, i) => beep(f, 180, 'triangle', 0.16, i * 0.1)); } // 获胜：上行琶音
function sndPot()      { beep(700, 45, 'triangle', 0.09); beep(520, 55, 'triangle', 0.1, 0.05); beep(380, 85, 'triangle', 0.1, 0.11); } // 收池：筹码归拢（下行三音）
function playSfx(type) {
    ({ bet: sndBet, raise: sndRaise, call: sndCall, check: sndCheck, fold: sndFold, allin: sndAllin, win: sndWin, pot: sndPot }[type] || (() => {}))();
}
// 金币从 fromEl 飞到 toEl（弧线缩小淡出）
function flyCoins(fromEl, toEl, count) {
    if (!fromEl || !toEl) return;
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const dx = (b.left + b.width / 2) - ax, dy = (b.top + b.height / 2) - ay;
    for (let i = 0; i < count; i++) {
        const coin = document.createElement('div');
        coin.className = 'fly-coin'; coin.textContent = '🪙';
        coin.style.left = ax + 'px'; coin.style.top = ay + 'px';
        document.body.appendChild(coin);
        requestAnimationFrame(() => {
            coin.style.transition = 'transform 0.55s cubic-bezier(0.4,0,0.6,1), opacity 0.55s';
            coin.style.transitionDelay = (i * 0.05) + 's';
            coin.style.transform = `translate(${dx}px, ${dy}px) scale(0.6)`;
            coin.style.opacity = '0';
        });
        setTimeout(() => coin.remove(), 750 + i * 50);
    }
}
function flyCoinsToWinner(winnerId) {
    flyCoins(document.getElementById('pot'), document.querySelector(`.seat[data-uid="${winnerId}"]`), 6);
}
// 高牌定庄动画：每个座位头像上方翻出一张牌，最大者高亮金光（约 2.8s 后自动清、正式发牌）
function showButtonDraw(draws, winnerId) {
    document.querySelectorAll('.bd-card').forEach(e => e.remove());
    (draws || []).forEach((dw, i) => {
        const ab = document.querySelector(`.seat[data-uid="${dw.userId}"] .avatar-block`);
        if (!ab) return;
        const r = ab.getBoundingClientRect();
        const el = document.createElement('div');
        el.className = 'bd-card' + (dw.userId === winnerId ? ' win' : '');
        el.style.left = (r.left + r.width / 2) + 'px';
        el.style.top = (r.top - 6) + 'px';
        el.style.animationDelay = (i * 0.1) + 's';
        el.innerHTML = formatCard(dw.card);
        document.body.appendChild(el);
    });
    toast(L('🎴 高牌定庄…', '🎴 High card for the button…'), 2600);
    setTimeout(() => document.querySelectorAll('.bd-card').forEach(e => e.remove()), 2700);
}
// 给别人发表情：表情从发送者头像「飞」到目标头像，落点冒泡，增强互动感
// 动态表情：给常用表情各配一种「动感」（纯 CSS keyframe，零素材、手机上也稳）
const EMOTE_MOTION = {
    '🎣': 'cast',    // 叉鱼：甩杆式摆动
    '🦈': 'chomp',   // 鲨鱼：一口一口逼近
    '🍺': 'clink',   // 干杯：碰杯左右晃
    '🌹': 'float',   // 送花：轻飘飘
    '💩': 'tumble',  // 翻滚
    '👍': 'pop',     // 弹一下
    '💰': 'pop',
    '🍀': 'float',
    '🧊': 'float',
    '👏': 'clink',
    '💪': 'pop'
};
function emoteMotion(e) { return EMOTE_MOTION[e] || 'spin'; }

// 连发计数：短时间内同一个人扔同一个表情 → 在目标头上累加 ×N，而不是刷出一堆重复气泡
const _comboMap = new Map();   // key: from|to|emote → {n, timer, el}
function bumpCombo(toUserId, emote, key) {
    const seat = document.querySelector(`.seat[data-uid="${toUserId}"]`);
    if (!seat) return;
    let c = _comboMap.get(key);
    if (!c) {
        const el = document.createElement('div');
        el.className = 'emote-combo';
        seat.appendChild(el);
        c = { n: 0, el, timer: null };
        _comboMap.set(key, c);
    }
    c.n++;
    if (c.n >= 2) { c.el.textContent = '×' + c.n; c.el.classList.add('show', 'bump'); setTimeout(() => c.el.classList.remove('bump'), 180); }
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.el.remove(); _comboMap.delete(key); }, 1600);
}

function flyEmote(fromUserId, toUserId, emote) {
    const fromEl = document.querySelector(`.seat[data-uid="${fromUserId}"] .avatar-block`);
    const toEl = document.querySelector(`.seat[data-uid="${toUserId}"] .avatar-block`);
    if (!fromEl || !toEl) { seatBubble(toUserId, emote, true); return; }
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const dx = (b.left + b.width / 2) - ax, dy = (b.top + b.height / 2) - ay;
    const el = document.createElement('div');
    el.className = 'fly-emote motion-' + emoteMotion(emote);
    el.textContent = emote;
    el.style.left = ax + 'px'; el.style.top = ay + 'px';
    // 连发时给每个飞行体一点随机偏移，看起来是「一串」而不是完全重叠的一个
    const jitter = () => (Math.random() - 0.5) * 34;
    el.style.setProperty('--dx', (dx + jitter()) + 'px');
    el.style.setProperty('--dy', (dy + jitter()) + 'px');
    document.body.appendChild(el);   // 用 CSS keyframe（比 transition+rAF 在手机上更稳）
    bumpCombo(toUserId, emote, `${fromUserId}|${toUserId}|${emote}`);
    setTimeout(() => { el.remove(); seatBubble(toUserId, emote, true); }, 640);
}
// 手机振动反馈（不支持则忽略）
function vibrate(pattern) { try { if (soundOn && navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }
// 赢额「+X」弹字：从赢家座位上飘出
function winPopup(userId, amount) {
    const seat = document.querySelector(`.seat[data-uid="${userId}"]`);
    if (!seat || !amount) return;
    const el = document.createElement('div');
    el.className = 'win-pop'; el.textContent = '+' + fmtChips(amount);
    seat.appendChild(el);
    setTimeout(() => el.remove(), 1600);
}
// 分池依次飞币 + 赢额弹字（主池先、边池后）
function animatePotsToWinners(pots, fallbackId) {
    let wonMine = false;
    if (!pots || !pots.length) {
        if (fallbackId) setTimeout(() => flyCoinsToWinner(fallbackId), 500);
        return;
    }
    let delay = 500;
    pots.forEach(pot => {
        const ws = (pot.winners || []);
        ws.forEach(w => {
            setTimeout(() => { flyCoinsToWinner(w.userId); winPopup(w.userId, w.amount); }, delay);
            if (w.userId === myUserId) wonMine = true;
        });
        if (ws.length) delay += 700;
    });
    if (wonMine) setTimeout(() => vibrate([30, 40, 30]), 550);   // 赢牌振动
}
function toggleSound() {
    soundOn = !soundOn;
    localStorage.setItem('soundOff', soundOn ? '0' : '1');
    document.getElementById('btnSound').textContent = soundOn ? '🔊' : '🔇';
    const s = document.getElementById('set-sound'); if (s) s.checked = soundOn;
    if (soundOn) { unlockAudio(); sndTurn(); }
}

// ===== 设置面板 =====
const THEMES = [
    { id: 'blue',   name: '孔雀蓝', css: 'radial-gradient(ellipse at center,#1d5a7a 0%,#0d2f44 75%)' },
    { id: 'green',  name: '翡翠绿', css: 'radial-gradient(ellipse at center,#2d6a4f 0%,#1b4332 75%)' },
    { id: 'gray',   name: '太空灰', css: 'radial-gradient(ellipse at center,#3a3f44 0%,#1c1f22 75%)' },
    { id: 'purple', name: '宝石紫', css: 'radial-gradient(ellipse at center,#4a2d6a 0%,#2a1b43 75%)' }
];
const POST_CHOICES = [0.25, 0.33, 0.5, 0.6, 0.67, 0.75, 0.8, 1, 1.25, 1.5];   // 翻后池比例
const PRE_CHOICES  = [2, 2.2, 2.5, 3, 3.5, 4, 5];                              // 翻前 BB 倍数
const MAX_QUICK = 5;   // 最多 5 个快捷尺度
let settings = {
    theme:     localStorage.getItem('s_theme') || 'green',
    cardStyle: localStorage.getItem('s_cardStyle') || 'four',   // 四色为默认（最易辨认）
    // 屏幕布局：auto=按屏幕比例自动（宽屏走横屏）/ portrait=强制竖屏 / landscape=强制横屏
    layout:    localStorage.getItem('s_layout') || 'auto',
    quickBetsPost: JSON.parse(localStorage.getItem('s_quickBetsPost') || localStorage.getItem('s_quickBets') || '[0.5,0.75,1]'),
    quickBetsPre:  JSON.parse(localStorage.getItem('s_quickBetsPre')  || '[2,2.5,3]')
};
settings.quickBetsPost = settings.quickBetsPost.slice(0, MAX_QUICK);
settings.quickBetsPre  = settings.quickBetsPre.slice(0, MAX_QUICK);
function saveSettings() {
    localStorage.setItem('s_theme', settings.theme);
    localStorage.setItem('s_cardStyle', settings.cardStyle);
    localStorage.setItem('s_layout', settings.layout);
    localStorage.setItem('s_quickBetsPost', JSON.stringify(settings.quickBetsPost));
    localStorage.setItem('s_quickBetsPre', JSON.stringify(settings.quickBetsPre));
}
function applySettings() {
    document.body.classList.remove('theme-blue', 'theme-green', 'theme-gray', 'theme-purple');
    document.body.classList.add('theme-' + settings.theme);
    // 牌面样式：四选一（four 四色 / standard 传统两色 / dark 黑面 / big 大字）
    document.body.classList.remove('cs-four', 'cs-standard', 'cs-dark', 'cs-big');
    document.body.classList.add('cs-' + settings.cardStyle);
    document.body.classList.toggle('four-color', settings.cardStyle === 'four');   // 兼容旧规则
    applyLayoutMode();
    renderQuickBets();
}
// 横竖屏：auto 时按视口宽高比判断（宽 ≥ 1.3 倍高就当横屏，覆盖电脑浏览器与手机横放）
function applyLayoutMode() {
    const auto = window.innerWidth / Math.max(1, window.innerHeight) >= 1.3;
    const landscape = settings.layout === 'landscape' || (settings.layout === 'auto' && auto);
    document.body.classList.toggle('layout-landscape', landscape);
    if (typeof lastState !== 'undefined' && lastState && typeof render === 'function') render(lastState);   // 座位环要按新半径重排
}
function setLayout(mode) {
    settings.layout = mode;
    saveSettings(); applySettings();
    document.querySelectorAll('.lay-opt').forEach(b => b.classList.toggle('sel', b.dataset.lay === mode));
}
// 窗口尺寸变化（电脑拖窗口 / 手机转屏）时，auto 模式要跟着切
window.addEventListener('resize', () => { if (settings.layout === 'auto') applyLayoutMode(); });
function openSettings()  { buildSettingsPanel(); document.getElementById('settings-overlay').style.display = 'flex'; }
function closeSettings() { document.getElementById('settings-overlay').style.display = 'none'; }
function setAvatar(url) {
    myAvatar = url;
    if (socket) socket.emit('set_avatar', { avatar: url });
    if (lastState) render(lastState);
    renderProfileAvatars();
}
function buildSettingsPanel() {
    document.getElementById('theme-row').innerHTML = THEMES.map(t =>
        `<div class="theme-swatch ${settings.theme === t.id ? 'sel' : ''}" style="background:${t.css}" onclick="setTheme('${t.id}')"><span>${t.name}</span></div>`).join('');
    document.querySelectorAll('.cs-opt').forEach(b => b.classList.toggle('sel', b.dataset.cs === settings.cardStyle));
    // 布局按钮复用了 .cs-opt 样式，上一行会把它们的选中态一并清掉，这里按 data-lay 重新点亮
    document.querySelectorAll('.lay-opt').forEach(b => b.classList.toggle('sel', b.dataset.lay === settings.layout));
    document.getElementById('cs-preview').innerHTML = ['Spades', 'Hearts', 'Diamonds', 'Clubs'].map(s => formatCard({ suit: s, rank: 'A' })).join('');
    // 翻前（BB 倍数）：预设 + 已添加的自定义值
    const preAll = [...new Set([...PRE_CHOICES, ...settings.quickBetsPre])].sort((a, b) => a - b);
    document.getElementById('quickbet-pre').innerHTML = preAll.map(v => {
        const sel = settings.quickBetsPre.includes(v);
        return `<button class="qb-opt ${sel ? 'sel' : ''}" onclick="toggleQuickBet('pre',${v})">${v}BB</button>`;
    }).join('');
    // 翻后（底池 %）
    const postAll = [...new Set([...POST_CHOICES, ...settings.quickBetsPost])].sort((a, b) => a - b);
    document.getElementById('quickbet-post').innerHTML = postAll.map(v => {
        const sel = settings.quickBetsPost.includes(v);
        return `<button class="qb-opt ${sel ? 'sel' : ''}" onclick="toggleQuickBet('post',${v})">${Math.round(v * 100)}%</button>`;
    }).join('');
    document.getElementById('set-bb').checked = displayBB;
    document.getElementById('set-sound').checked = soundOn;
}
function setTheme(id) { settings.theme = id; saveSettings(); applySettings(); buildSettingsPanel(); }
function setCardStyle(cs) { settings.cardStyle = cs; saveSettings(); applySettings(); buildSettingsPanel(); if (lastState) render(lastState); }
function qbList(kind) { return kind === 'pre' ? settings.quickBetsPre : settings.quickBetsPost; }
function toggleQuickBet(kind, v) {
    const list = qbList(kind);
    const i = list.indexOf(v);
    if (i >= 0) list.splice(i, 1);
    else {
        if (list.length >= MAX_QUICK) { alert(`最多 ${MAX_QUICK} 个快捷尺度`); return; }
        list.push(v); list.sort((a, b) => a - b);
    }
    saveSettings(); renderQuickBets(); buildSettingsPanel();
}
// 自定义输入：BB 倍数 或 百分比
function addCustomQuick(kind) {
    const input = document.getElementById(kind === 'pre' ? 'customPre' : 'customPost');
    let n = parseFloat(input.value);
    if (isNaN(n) || n <= 0) { alert('请输入有效数字'); return; }
    const v = kind === 'pre' ? Math.round(n * 10) / 10 : Math.round(n) / 100;  // 百分比转小数
    const list = qbList(kind);
    if (list.includes(v)) { input.value = ''; return; }
    if (list.length >= MAX_QUICK) { alert(`最多 ${MAX_QUICK} 个快捷尺度`); return; }
    list.push(v); list.sort((a, b) => a - b);
    input.value = '';
    saveSettings(); renderQuickBets(); buildSettingsPanel();
}
// 用 BB 倍数尺度：仅翻前、且还没人加注（当前注=大盲）时——即「开池加注」场景；
// 一旦有人加注（currentBet > 大盲），改用底池比例
function usePreBB() {
    return lastState && lastState.phase === 'preflop'
        && (!lastState.communityCards || lastState.communityCards.length === 0)
        && lastState.currentBet <= lastState.bigBlind;
}
function renderQuickBets() {
    const g = document.getElementById('quick-bet-group'); if (!g) return;
    const pre  = usePreBB();
    const set  = pre ? settings.quickBetsPre : settings.quickBetsPost;
    const kind = pre ? 'bb' : 'pot';
    const amt  = (k, v) => sizeCtx ? `<small>${fmtChips(sizeForQuick(k, v))}</small>` : '';
    // 快捷项只留预设 %/BB；All-in 已去掉（在精调面板把加注条拖到最大即全下），最小加注也很少用
    const items = [];
    set.forEach(v => items.push({ label: pre ? `${v}BB` : `${Math.round(v * 100)}%`, oc: `quickBet('${kind}',${v})`, sub: amt(kind, v) }));

    // 半圆弧环绕布局：弧心在底部中央。用正圆 + 等角分布 → 各球间距均匀（含最小/All-in 两端不再挤）
    const N = items.length;
    const ball = 38;
    const R = Math.max(82, N * 15);   // 正圆半径：球多则略大，但不过宽
    const W = 2 * R + ball + 10, H = R + ball + 10;
    const cx = W / 2, cy = H - ball / 2;
    g.style.position = 'relative'; g.style.width = W + 'px'; g.style.height = H + 'px';
    g.innerHTML = items.map((it, i) => {
        const t = N === 1 ? 0.5 : i / (N - 1);
        const ang = Math.PI * (0.9 - 0.8 * t);   // 162° → 18°，正圆上等角=视觉等距
        const x = cx + R * Math.cos(ang) - ball / 2;
        const y = cy - R * Math.sin(ang) - ball / 2;
        return `<button class="size-quick" style="left:${x}px;top:${y}px" onclick="${it.oc}">${it.label}${it.sub}</button>`;
    }).join('');
}
function setDisplayBBChecked(v) { if (v !== displayBB) toggleDisplayBB(); }
function setSoundChecked(v) { if (v !== soundOn) toggleSound(); }

// 全屏切换：彻底隐藏手机浏览器工具栏
function toggleFullscreen() {
    const el = document.documentElement;
    const d = document;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) {
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
        if (req) req.call(el);
        else alert('当前浏览器不支持全屏，建议把网页「添加到主屏幕」后从图标打开');
    } else {
        const exit = d.exitFullscreen || d.webkitExitFullscreen;
        if (exit) exit.call(d);
    }
}
document.addEventListener('fullscreenchange', () => {
    const b = document.getElementById('btnFullscreen');
    if (b) b.textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏';
});

// ===== 显示单位设置 =====
function toggleDisplayBB() {
    displayBB = !displayBB;
    localStorage.setItem('displayBB', displayBB ? '1' : '0');
    const c = document.getElementById('set-bb'); if (c) c.checked = displayBB;
    if (lastState) render(lastState);
}
