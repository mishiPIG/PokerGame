'use strict';
// 美术第二轮 ④（2026-11-17）：手机上弹窗从底部升起、往下拉关闭；聊天开着也能按行动按钮；建房按钮钉在底部。
// 行为本身（往下拉 200px 关、拉 30px 弹回、从中间拉不关、聊天开着点跟注真的发出 player_action）
// 上线前用真浏览器触屏手势跑过；这里守的是「改一处忘一处」的结构契约。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const BOOT = read('public/js/99-bootstrap.js');
const MODALS = read('public/css/43-modals.css');

const SHELLS = ['.modal-box', '.settings-box', '.profile-box', '.c-box', '.ap-box', '.side-panel'];

test('🔴 每一种弹窗外壳在手机上都是底部抽屉，且都能往下拉关闭（样式和手势是同一张清单）', () => {
    const sheetBox = (BOOT.match(/const SHEET_BOX = '([^']+)'/) || [])[1];
    assert.ok(sheetBox, '找不到 SHEET_BOX');
    assert.deepEqual(sheetBox.split(',').map(s => s.trim()).sort(), [...SHELLS].sort(), '手势认的外壳 = 样式改成底部抽屉的外壳');
    for (const sel of SHELLS) {
        assert.ok(MODALS.includes(`body:not(.layout-landscape) ${sel},`) || MODALS.includes(`body:not(.layout-landscape) ${sel} {`),
            `${sel} 没有底部抽屉样式`);
        assert.ok(MODALS.includes(`body:not(.layout-landscape) ${sel}::before`), `${sel} 没有顶上的抓手小横条`);
    }
    // 新加了一种外壳却没进清单 → 手机上它还是居中弹窗、关闭 ✕ 还在右上角
    const used = new Set([...read('index.html').matchAll(/class="(modal-box|settings-box|profile-box|c-box|ap-box|side-panel)\b/g)].map(m => '.' + m[1]));
    for (const u of used) assert.ok(SHELLS.includes(u), `${u} 不在清单里`);
});

test('往下拉关闭：只在竖屏、只从抽屉顶部起手、抽屉没滚动时才算；关闭走登记表里同一个函数', () => {
    const start = BOOT.slice(BOOT.indexOf("document.addEventListener('touchstart'"), BOOT.indexOf("document.addEventListener('touchmove'"));
    assert.match(start, /layout-landscape/);
    assert.match(start, /> 56/, '只认顶部 56px 起手 —— 中间有滑条和列表');
    assert.match(start, /scrollTop > 0/, '抽屉里滚过了就不抢（那是在往回滚）');
    assert.match(BOOT, /window\[d\.owner\.close\]/, '关闭用 DISMISSIBLE 登记的函数，和点外面关闭同一条路径');
});

test('🔴 聊天开着时点行动按钮不被吞（原来这一下被当成「关掉聊天」，按钮没按下去）', () => {
    const chat = (BOOT.match(/\{ id: 'chat-panel',[^}]*\}/) || [''])[0];
    assert.match(chat, /passThrough: '[^']*#action-bar/);
    assert.match(chat, /passThrough: '[^']*#preaction-bar/);
    assert.match(BOOT, /if \(p\.passThrough && e\.target\.closest && e\.target\.closest\(p\.passThrough\)\) continue;/);
});

test('聊天面板挪开：手机在牌桌上方、电脑靠右 —— 都不再贴着底栏盖住按钮和手牌', () => {
    const css = read('public/css/42-chat-voice.css');
    assert.match(css, /body:not\(\.layout-landscape\) #chat-panel \{ top: \d+px; bottom: auto;/);
    assert.match(css, /body\.layout-landscape #chat-panel \{ left: auto; right: \d+px;/);
});

test('建房「确定创建」钉在可视区底部；建房 / 买入的滑条不再是浏览器自带的蓝白样式', () => {
    const lobby = read('public/css/30-lobby.css');
    assert.match(lobby, /\.create-actions \{[^}]*position: sticky;/);
    assert.doesNotMatch(lobby, /#create-form input\[type=range\] \{[^}]*accent-color: #3a86ff/);
    assert.match(lobby, /#create-form input\[type=range\]::-webkit-slider-thumb/);
});
