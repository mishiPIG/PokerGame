'use strict';
// 2026-11-19 真人式浏览器测试（真点按钮、真拖滑条）抓到的界面问题，德州原来就有。每条守一下，别再退回去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

test('🔴 预操作撞上发牌的输入锁：等锁过了再发，不许悄悄吞掉（原来 35 次被吞、然后超时弃牌）', () => {
    const src = read('public/js/70-actions.js');
    const body = src.slice(src.indexOf('function runPreAction'), src.indexOf('function canCheckNow'));
    assert.match(body, /if \(inputLocked\(\)\) \{ setTimeout\(fire,/);
});

test('站起围观的人看得到「回到座位」（按钮在 #action-bar 里，显示条件原来漏了 amVacated）', () => {
    const line = read('public/js/80-table-renderer.js').split('\n').find(l => l.includes('const showAB = ('));
    assert.ok(line && line.includes('amVacated'), line);
});

test('常用语列表从顶上排：继承来的 center 会让溢出的部分往上漏、第一条点不着', () => {
    assert.match(read('public/css/42-chat-voice.css'), /\.chat-phrases \{ flex-direction: column;[^}]*justify-content: flex-start/);
});

test('无效加注（raiseClosed）时快捷下注球不出现', () => {
    const src = read('public/js/80-table-renderer.js');
    const body = src.slice(src.indexOf('function setupSizing'), src.indexOf('function setupSizing') + 1500);
    assert.match(body, /if \(state\.raiseClosed\) \{ quick\.style\.display = 'none';/);
});

test('电脑上在金额框里打完数字按回车 = 确认', () => {
    assert.match(read('index.html'), /id="raiseAmount"[^>]*onkeydown="if \(event\.key === 'Enter'\) \{ event\.preventDefault\(\); confirmBet\(\); \}"/);
});

test('🔴 带入审批不会被误拒：点外面关不掉；被别的确认框顶掉 = 放回队列，不算拒绝', () => {
    const u = read('public/js/05-utils.js'), r = read('public/js/30-room.js');
    assert.match(u, /if \(result === undefined && _confirmSticky\) return;/);
    assert.match(u, /prev\(null\)/);
    assert.match(r, /sticky: true \}\)\.then\(ok => \{\s*\/\/[^\n]*\n\s*if \(ok === null\) \{ buyinQueue\.unshift\(req\);/);
});
