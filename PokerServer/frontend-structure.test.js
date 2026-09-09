const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_DIR = path.join(ROOT, 'public', 'js');
const CSS_DIR = path.join(ROOT, 'public', 'css');

const EXPECTED_SCRIPTS = [
    '00-state.js',
    // i18n 必须排在 05-utils 之前：后面几乎每个文件都会用到 t() / L()（2026-08-28 加）
    '03-i18n.js',
    '05-utils.js',
    '10-auth.js',
    '20-socket.js',
    '30-room.js',
    '40-profile.js',
    '41-history.js',
    '42-replay.js',
    '50-audio-settings.js',
    '60-chat.js',
    '61-voice.js',
    '70-actions.js',
    '71-hotkeys.js',
    '80-table-renderer.js',
    '90-admin.js',
    '99-bootstrap.js'
];

const EXPECTED_STYLES = [
    '00-shell.css',
    '10-auth-user.css',
    '20-table.css',
    '30-lobby.css',
    '40-settings.css',
    '41-table-menu.css',
    '42-chat-voice.css',
    '43-modals.css',
    '44-replay.css',
    '45-profile.css',
    '46-history.css',
    '50-effects.css'
];

function loadedAssets(pattern) {
    return [...INDEX.matchAll(pattern)].map(match => match[1]);
}

function source(file) {
    return fs.readFileSync(path.join(JS_DIR, file), 'utf8');
}

function frontendContext() {
    const context = { localStorage: { getItem() { return null; } } };
    vm.createContext(context);
    vm.runInContext(source('05-utils.js'), context);
    return context;
}

function declarationCount(symbol) {
    const pattern = new RegExp(`(?:function|const|let|var)\\s+${symbol}\\b`, 'g');
    return EXPECTED_SCRIPTS.reduce((total, file) => total + (source(file).match(pattern) || []).length, 0);
}

test('index loads componentized scripts and styles in dependency order', () => {
    assert.deepEqual(loadedAssets(/<script src="\/js\/([^"]+)"><\/script>/g), EXPECTED_SCRIPTS);
    assert.deepEqual(loadedAssets(/<link rel="stylesheet" href="\/css\/([^"]+)">/g), EXPECTED_STYLES);
    for (const file of EXPECTED_SCRIPTS) assert.equal(fs.existsSync(path.join(JS_DIR, file)), true, file);
    for (const file of EXPECTED_STYLES) assert.equal(fs.existsSync(path.join(CSS_DIR, file)), true, file);
});

test('index contains no large inline style or application script', () => {
    // 唯一允许的内联样式 = 开场画面(#boot-splash)的首屏关键 CSS：外链样式表到达之前
    // 就必须是深绿底，否则会先闪一层白，比没有开场更难看（见 index.html 里的注释）。
    // 所以这里不再一刀切禁止 <style>，而是守住「只此一块、且必须小」——
    // 防的是大段样式表重新爬回 index.html，不是防这块刻意为之的关键 CSS。
    const inlineStyles = [...INDEX.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    assert.equal(inlineStyles.length, 1, 'index.html 只应保留开场画面那一块内联关键 CSS');
    assert.match(inlineStyles[0], /#boot-splash/, '唯一的内联样式必须是开场画面的关键 CSS');
    assert.ok(inlineStyles[0].length < 2500, `内联关键 CSS 过大（${inlineStyles[0].length} 字符）——样式该放 public/css/`);
    // 应用脚本一律外链：内联 <script> 一个都不该有
    const inlineScripts = [...INDEX.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(inlineScripts.length, 0, '应用脚本必须放 public/js/，不要内联进 index.html');
});

test('缩小牌面必须走 --card-w，或自己显式覆盖 rank/suit 字号', () => {
    // 🔴 2026-09-09 线上 bug：牌谱回放把牌缩到 24-26px 时只写了 width/height，
    //    但 rank/suit 字号是 calc(var(--card-w) * 0.62 / 0.6) 算出来的，
    //    --card-w 仍停留在 :root 的值 ——【电脑宽屏会顶到上限 40px】，
    //    于是 26px 的牌上顶着 24.8px 的数字，直接撑爆牌面。
    //    手机上 --card-w 本来就小，所以这个 bug 只在电脑端暴露、肉眼也难发现。
    // 合法写法只有两种：① 在容器上设 --card-w/--card-h（推荐，见 .hd-hole / .hi-cards）
    //                   ② 直接写 width，但【同时】显式覆盖 .rank / .suit 字号（见 .cs-preview）
    const files = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(path.join(CSS_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const selector = m[1].trim().split('\n').pop().trim();
            if (!/\.card\b/.test(selector)) continue;
            if (!/\bwidth:\s*\d+px/.test(m[2])) continue;
            const prefix = selector.split('.card')[0].trim();
            // 合法情形 ①：容器自己设了 --card-w（字号就会跟着对）
            const varAt = prefix ? text.indexOf(prefix + ' {') : -1;
            const containerSetsVar = varAt >= 0 && /--card-w/.test(text.slice(varAt, varAt + 200));
            // 合法情形 ②：显式覆盖了 rank 字号
            const marker = prefix ? prefix + ' .card .rank' : '.card .rank';
            const at = text.indexOf(marker);
            const declaresRank = at >= 0 && /font-size/.test(text.slice(at, at + 120));
            if (!containerSetsVar && !declaresRank) offenders.push(file + '  ' + selector);
        }
    }
    assert.deepEqual(offenders, [],
        '这些规则把牌缩小了却没设 --card-w、也没覆盖 rank/suit 字号 —— 电脑端字会撑爆牌面');
});

test('设置面板：每个区块都必须归属某个分页（除了刻意常驻的操作栏）', () => {
    // 2026-09-09 分页后新增的结构约束。风险是：以后加一个 .settings-sec 却忘了放进
    // 某个 .set-pane 里 —— 它会在【所有页】都显示，或者干脆哪页都不显示，
    // 而这两种都不会报错、只能靠肉眼发现。
    // ⚠️ 唯一允许在分页外的是 .set-actions（全屏/退出房间/解散/退出登录）——
    //    那是逃生出口，刻意常驻底部，埋进分页里等于藏起来。
    const box = INDEX.slice(INDEX.indexOf('<div id="settings-overlay"'), INDEX.indexOf('<script src="/js/00-state.js"'));

    const tabs = [...box.matchAll(/class="set-tab[^"]*"[^>]*data-pane="(\w+)"/g)].map(m => m[1]);
    const panes = [...box.matchAll(/class="set-pane[^"]*"[^>]*data-pane="(\w+)"/g)].map(m => m[1]);
    assert.ok(tabs.length >= 2, '至少要有两个分页，否则分页没意义');
    assert.deepEqual(tabs, panes, 'Tab 与内容页必须一一对应且顺序一致');

    // 用真正的「祖先判断」而不是「按标记切段」——第一版就是按标记切的，
    // 结果游离区块正好夹在最后一个 pane 和 set-actions 之间，被连着挖掉了，检查形同虚设。
    // （反向对照当场发现：塞了游离区块进去测试照样全绿。）
    const orphan = [];
    const stack = [];
    for (const m of box.matchAll(/<div\b([^>]*)>|<\/div>/g)) {
        if (m[0] === '</div>') { stack.pop(); continue; }
        const attrs = m[1] || '';
        const secCls = attrs.match(/class="(settings-sec[^"]*)"/);
        if (secCls && !stack.some(Boolean)) orphan.push(secCls[1]);   // 没有任何 set-pane 祖先
        stack.push(/class="set-pane/.test(attrs));
    }
    assert.deepEqual(orphan, ['settings-sec set-actions'],
        '这些设置区块没有归属任何分页（只有 set-actions 允许在分页外）：' + orphan.join(', '));

    // 每一页都不能是空的
    for (const p of panes) {
        const seg = box.slice(box.indexOf(`data-pane="${p}">`));
        assert.match(seg.slice(0, 4000), /class="settings-sec/, `分页 ${p} 里没有任何设置区块`);
    }
});

test('state module owns data only and does not manipulate the DOM', () => {
    const state = source('00-state.js');
    assert.doesNotMatch(state, /\bdocument\b/);
    assert.doesNotMatch(state, /\bquerySelector\b|\bgetElementById\b|\bclassList\b/);
});

test('current table net keeps unsettled bets and pending rebuys in player assets', () => {
    const { displayNet } = frontendContext();
    assert.equal(displayNet({ chips: 980, currentBet: 20, committed: 0, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 700, currentBet: 0, committed: 300, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 500, pendingRebuy: 500, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 650, currentBet: 10, committed: 40, buyIn: 1000 }), -300);
});

test('shared utilities and reassigned controls have one owner', () => {
    for (const symbol of [
        'escapeHtml',
        'hashHue',
        'AVATARS',
        'renderRoomList',
        'toggleFullscreen',
        'toggleReady',
        'startGame',
        'addTime',
        'rabbitDeal'
    ]) {
        assert.equal(declarationCount(symbol), 1, `${symbol} must have exactly one declaration`);
    }

    assert.match(source('05-utils.js'), /function escapeHtml\b/);
    assert.match(source('30-room.js'), /function renderRoomList\b/);
    assert.match(source('50-audio-settings.js'), /function toggleFullscreen\b/);
    assert.match(source('70-actions.js'), /function toggleReady\b/);
});

test('audio unlock supports iOS gestures and foreground recovery', () => {
    const audio = source('50-audio-settings.js');
    const bootstrap = source('99-bootstrap.js');
    assert.match(audio, /function resumeAudio\b/);
    assert.match(audio, /function unlockAudio\b/);
    assert.match(bootstrap, /'pointerdown', 'touchend', 'keydown', 'click'/);
    assert.match(bootstrap, /visibilitychange/);
    assert.match(bootstrap, /if \(!document\.hidden\) resumeAudio\(\)/);
});

test('room owner invitation presents one combined, copyable message', () => {
    assert.match(INDEX, /id="invite-message"/);
    assert.match(INDEX, /onclick="copyRoomInvite\(\)"/);
    assert.doesNotMatch(INDEX, /id="invite-code"|id="invite-url"/);
    assert.match(source('30-room.js'), /function formatRoomInvite\b/);
    // ⚠️ 别断言中文字面量：i18n(2026-09-02 part3) 之后这些标签是 L('房间名','Room') 这种运行时取值，
    // 写死中文会让这条测试在翻译时假失败。改成断言【结构】——三段信息齐全、且链接排在房间码之前。
    assert.match(source('30-room.js'), /\$\{invite\.roomName\}/);
    assert.match(source('30-room.js'), /\$\{invite\.inviteUrl\}[\s\S]*\$\{invite\.joinCode\}/);
});
