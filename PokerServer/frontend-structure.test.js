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
