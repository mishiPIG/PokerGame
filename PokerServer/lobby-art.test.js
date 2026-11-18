'use strict';
// 大厅美术第一批（2026-11-18，美术第二轮 §12.6 ①–④）：电脑放宽单栏、背景质感、入口卡插画、空状态。
// 真实效果手机 / 电脑 / 英文小屏截图看过；这里守住几处改坏了不报错、只会悄悄变回「素」的地方。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('入口卡带插画：创建 = 金币摞，加入 = 门票；插画不挡点击，加入卡给插画让出宽度', () => {
    const html = read('index.html');
    const create = html.slice(html.indexOf('class="lobby-entry create"'), html.indexOf('class="lobby-entry join"'));
    const join = html.slice(html.indexOf('class="lobby-entry join"'), html.indexOf('id="joinCodeBoxes"'));
    assert.match(create, /class="le-art" aria-hidden="true"><svg/);
    assert.match(create, /leChipGold/);
    assert.match(join, /class="le-art" aria-hidden="true"><svg/);
    const css = read('public/css/30-lobby.css');
    assert.match(css, /\.le-art \{[^}]*pointer-events: none/);
    assert.match(css, /\.lobby-entry\.join \.le-title, \.lobby-entry\.join \.le-sub \{ padding-right: \d+px; \}/);
    assert.match(css, /\.lobby-entry\.create \{[^}]*color: #/, '创建卡是 <button>：不写字色就是浏览器默认黑字，在深金底上看不清');
});

test('电脑上大厅放宽到 1080、牌局列表两列；手机不受影响', () => {
    const css = read('public/css/30-lobby.css');
    assert.match(css, /#lobby-view \{ width: 100%; max-width: 720px;/, '手机 / 竖屏仍是 720');
    assert.match(css, /body\.layout-landscape #lobby-view \{ max-width: 1080px; \}/);
    assert.match(css, /body\.layout-landscape #my-room-list, body\.layout-landscape #room-list \{ display: grid; grid-template-columns: repeat\(2/);
    assert.match(css, /> \.pane-empty \{ grid-column: 1 \/ -1; \}/, '空状态在两列网格里要占满一整行');
});

test('大厅背景有质感（细噪点 + 淡鸟居），和牌桌是一套', () => {
    const css = read('public/css/30-lobby.css');
    const rule = (css.match(/body:not\(\.in-room\) \{ background:[\s\S]*?\}/) || [''])[0];
    assert.match(rule, /feTurbulence/);
    assert.match(rule, /M6 12 Q50 21 94 12/, '鸟居');
    assert.match(rule, /radial-gradient/);
});

test('空状态：有插画，还有能直接点的下一步（约局：创建一局 / 看一手示例；发现：创建一局 / 看全部）', () => {
    const js = read('public/js/30-room.js');
    assert.match(js, /const EMPTY_TABLE_ART = '<svg class="pe-art"/);
    const list = js.slice(js.indexOf('function renderRoomList'), js.indexOf('function roomCards'));
    assert.match(list, /emptyPane\([\s\S]*?onclick="showCreateForm\(\)"[\s\S]*?onclick="openDemoHand\(\)"/);
    assert.match(list, /onclick="setDiscoverFilter\('all'\)"/);
    assert.match(list, /onclick="setLobbyTab\('play'\);showCreateForm\(\)"/);
    assert.doesNotMatch(list, /<span class="pe-ico">/, '不再是只有一个灰图标的空状态');
});

// ───────────── ⑥ 导航指示条滑动 + 切页方向、⑦ 金币滚动（2026-11-18）─────────────
test('切页有方向：往右边的页切内容从右边进来、往左切从左边进来；第一次进大厅不带方向', () => {
    const js = read('public/js/30-room.js');
    const fn = js.slice(js.indexOf('function setLobbyTab'), js.indexOf('function positionNavSlider'));
    assert.match(fn, /viewEl\.dataset\.dir = \(from < 0 \|\| from === to\) \? '' : \(to > from \? 'r' : 'l'\)/);
    assert.match(fn, /positionNavSlider\(\)/);
    const css = read('public/css/31-lobby-nav.css');
    assert.match(css, /#lobby-view\[data-dir="r"\] \.lobby-pane\.active > \* \{ animation-name: paneInR; \}/);
    assert.match(css, /#lobby-view\[data-dir="l"\] \.lobby-pane\.active > \* \{ animation-name: paneInL; \}/);
});

test('导航指示条是一根会滑的条：用 transform 过渡；有了它就不再画每项自己那根；第一次不从角落滑过来', () => {
    const css = read('public/css/31-lobby-nav.css');
    assert.match(css, /#nav-slider \{[^}]*transform: translate\(var\(--nx, 0px\), var\(--ny, 0px\)\)[^}]*transition: transform/);
    assert.match(css, /#lobby-nav\.has-slider \.nav-item\.active::before \{ display: none; \}/);
    const js = read('public/js/30-room.js');
    assert.match(js, /if \(!bar\.classList\.contains\('ready'\)\) requestAnimationFrame\(\(\) => bar\.classList\.add\('ready'\)\)/);
});

test('顶栏金币变化时滚动 + 闪一下；第一次显示不滚；所有更新都走同一个入口', () => {
    const r = read('public/js/80-table-renderer.js');
    assert.match(r, /function updateUserBar\(\) \{[\s\S]*?showGold\(myGold \|\| 0\);/);
    const fn = r.slice(r.indexOf('function showGold'), r.indexOf('function updateUserBar'));
    assert.match(fn, /if \(from == null \|\| from === to/, '第一次显示 / 没变化：直接写数字');
    assert.match(fn, /to > from \? 'gold-up' : 'gold-down'/);
    assert.match(fn, /cancelAnimationFrame\(_goldRaf\)/, '连着两次变化：上一次的滚动要停掉，不然两段动画抢着写数字');
    // 别处不许绕过它直接写金币文字（否则就没动画了）
    for (const f of fs.readdirSync(path.join(__dirname, 'public/js'))) {
        if (f === '80-table-renderer.js') continue;
        assert.doesNotMatch(read('public/js/' + f), /getElementById\('display-gold'\)\.textContent\s*=/, f);
    }
});

// ───────────── ⑧ 房间码格子动效、⑨ 游客提示条、⑩ 设置底部按钮（2026-11-18）─────────────
test('房间码：输进一位那格跳一下；房间码不对整排抖一下（只在手输时抖，链接失败不抖）', () => {
    const room = read('public/js/30-room.js');
    assert.match(room, /if \(el\.value\) \{ el\.classList\.remove\('pop'\); void el\.offsetWidth; el\.classList\.add\('pop'\); \}/);
    assert.match(room, /function shakeJoinCode\(\)/);
    assert.match(read('public/js/20-socket.js'), /resetJoinCode\(source !== 'link'\);[^\n]*\n\s*if \(source !== 'link'\) shakeJoinCode\(\);/);
    const css = read('public/css/30-lobby.css');
    assert.match(css, /\.code-boxes\.shake \{ animation: codeShake/);
    assert.match(css, /\.code-boxes \.code-box\.pop \{ animation: codePop/);
});

test('游客提示条不再用 emoji：图标和文字分开放（切语言只改文字那段）；设置底部按钮不再是灰蓝', () => {
    const html = read('index.html');
    assert.match(html, /<div class="gb-text"><svg class="ic c-gold"[^>]*><use href="#i-save"\/><\/svg><span data-i18n="guest\.banner">/);
    const dict = read('public/js/03-i18n.js');
    assert.doesNotMatch(dict, /'guest\.banner': '👋/);
    const shell = read('public/css/00-shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(shell, /\.sa-btn \{[^}]*#3a4a60/);
});
