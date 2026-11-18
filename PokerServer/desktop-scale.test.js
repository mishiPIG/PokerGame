'use strict';
// 电脑端整体放大（2026-11-17，美术第二轮 ②）。
// 原来座位、行动按钮、底栏在手机和 1920 屏上一样大（按钮 40px、对手头像 43px），大屏上对手缩成贴边的小点。
// 现在横屏按窗口算一个倍数（UI_SCALE / --ui-scale），样式那头 zoom，座位定位那头乘同一个数。
// 这里守的是「两头必须对得上」这类改一处忘一处就会出事、却不会报错的地方。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const RENDER = read('public/js/80-table-renderer.js');
const AUDIO = read('public/js/50-audio-settings.js');
const TABLE_CSS = read('public/css/20-table.css');
const SHELL_CSS = read('public/css/00-shell.css');
// 只看代码、不看注释（注释里正是在解释为什么不能这么写）
const codeOnly = (src) => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

function fnBody(src, name) {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i >= 0, `找不到 ${name}`);
    let depth = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) return src.slice(j, k + 1);
    }
    return '';
}

test('🔴 座位放大了，座位定位也得按放大后的尺寸算：ringPos / communityCardW 只许用 seatBox()', () => {
    for (const fn of ['ringPos', 'communityCardW']) {
        const body = fnBody(RENDER, fn);
        assert.match(body, /seatBox\(\)/, `${fn} 要用 seatBox()`);
        assert.doesNotMatch(body, /SEAT_BOX\./, `${fn} 里直接用 SEAT_BOX 就是没放大的尺寸 → 放大的座位会被挤出牌桌边`);
    }
    assert.match(fnBody(RENDER, 'seatBox'), /UI_SCALE/);
    // 样式那头：座位块确实被 zoom 了（两头必须是同一个倍数）
    assert.match(TABLE_CSS, /body\.layout-landscape \.ring-seat,[\s\S]*?zoom: var\(--ui-scale, 1\)/);
});

test('放大倍数：只在横屏算，手机竖屏恒为 1；窗口一变就重算', () => {
    const body = fnBody(AUDIO, 'applyLayoutMode');
    assert.match(body, /landscape \? Math\.max\(1, Math\.min\(1\.75,/);
    assert.match(body, /setProperty\('--ui-scale'/);
    assert.match(AUDIO, /addEventListener\('resize', \(\) => applyLayoutMode\(\)\)/, '不论哪种布局模式都要跟着窗口重算倍数');
});

test('🔴 --card-w 必须量出来，不能读自定义属性的文本（读到的是 clamp(…) 字符串，原来一直退到兜底的 32）', () => {
    assert.doesNotMatch(codeOnly(RENDER), /getPropertyValue\('--card-w'\)/);
    assert.match(fnBody(RENDER, 'syncCommunityWidth'), /cardWidthPx\(\)/);
});

test('牌放大了字也跟着放大：公共牌、自己的牌都把 --card-w 设成自己的宽度', () => {
    assert.match(TABLE_CSS, /#community \.card, #community \.empty-slot \{[^}]*--card-w: var\(--comm-w\)/);
    assert.match(TABLE_CSS, /\.self-cards \.card, \.ring-seat\.bottom \.self-cards \.empty-slot \{[^}]*--card-w: var\(--self-w\)/);
    assert.match(read('public/css/50-effects.css'), /#runit-boards \.rib-slots \.card \{[^}]*--card-w: var\(--comm-w\)/);
});

test('底池和公共牌的位置：JS 里的百分比和样式里的 top 对得上', () => {
    const pct = (name) => Number((RENDER.match(new RegExp(`const ${name} = (\\d+)`)) || [])[1]);
    assert.match(SHELL_CSS, new RegExp(`#board \\{[^}]*top: ${pct('BOARD_TOP_PCT')}%`, 'm'));
    assert.match(TABLE_CSS, new RegExp(`body\\.layout-landscape #board \\{ top: ${pct('BOARD_TOP_PCT_LANDSCAPE')}%`));
    assert.match(TABLE_CSS, new RegExp(`max-height: 800px\\) \\{ body\\.layout-landscape #board \\{ top: ${pct('BOARD_TOP_PCT_LANDSCAPE_SHORT')}%`));
});

test('🔴 宽屏两侧常驻栏：钉住的栏不算「开着的浮层」（否则点牌桌会被吞、快捷键全失灵）', () => {
    const rd = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 点外面关闭：钉住的栏必须被排除
    assert.match(rd('public/js/99-bootstrap.js'), /function panelIsOpen\(el\) \{ return !!el && !isDockedRail\(el\)/);
    // 快捷键的「有浮层开着就不响应」：同样排除
    assert.match(rd('public/js/71-hotkeys.js'), /isDockedRail\(el\)\) continue;/);
    // 钉住只在电脑横屏、够宽时
    const st = rd('public/js/50-audio-settings.js');
    assert.match(st, /const rails = landscape && window\.innerWidth >= 1400;/);
    const css = rd('public/css/46-history.css');
    assert.match(css, /body\.wide-rails\.in-room #stats-panel, body\.wide-rails\.in-room #history-panel \{\s*display: block !important;/);
    assert.match(css, /body\.wide-rails\.in-room #table-view \{ margin-left: var\(--rail-w\); margin-right: var\(--rail-w\); \}/, '牌桌让出两栏的宽度，座位不被盖住');
    assert.match(css, /body\.wide-rails\.in-room \.edge-arrow \{ display: none !important; \}/, '常驻了就不要再显示边缘箭头');
    // 战绩栏随状态刷新、牌谱栏每手刷新
    const sock = rd('public/js/20-socket.js');
    assert.match(sock, /isDockedRail\(sp\)\) renderStats\(state\)/);
    assert.match(sock, /refreshRails\(600\)/);
});
