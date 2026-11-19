'use strict';
// 三种玩法各一个图标 + 一个颜色（2026-11-19，用户：「建房和大厅里能快速区分」）。
// 这几条守的是「写了但不生效」的那类：图标名拼错只会显示空白、颜色没定义只会变回灰白，都不报错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { VARIANTS } = require('./src/games/poker/variants');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const room = read('public/js/30-room.js');
const html = read('index.html');
const css = read('public/css/30-lobby.css');

function loadHelpers() {
    const start = room.indexOf('const VARIANT_KEY = ');
    const end = room.indexOf('function setThinkTime');
    const ctx = { t: (k) => k, ic: (name, cls) => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`, Object };
    vm.createContext(ctx);
    vm.runInContext(room.slice(start, end) + '\nthis.VARIANT_ICON = VARIANT_ICON; this.variantKey = variantKey; this.variantIcon = variantIcon;', ctx);
    return ctx;
}

test('服务端有几种玩法，客户端就有几个图标；每个图标都真的在图标集里', () => {
    const { VARIANT_ICON } = loadHelpers();
    assert.deepEqual(Object.keys(VARIANT_ICON).sort(), Object.keys(VARIANTS).sort());
    for (const name of Object.values(VARIANT_ICON)) assert.ok(html.includes(`<symbol id="i-${name}"`), name);
});

test('每种玩法的颜色都定义了（--vc / --vc-rgb），三种颜色互不相同', () => {
    const colors = Object.keys(VARIANTS).map(v => {
        const m = css.match(new RegExp(`\\.v-${v}\\s*\\{\\s*--vc:\\s*(#[0-9a-f]{6});\\s*--vc-rgb:\\s*[\\d,]+;`));
        assert.ok(m, v);
        return m[1];
    });
    assert.equal(new Set(colors).size, colors.length);
});

test('乱填的玩法（含 constructor 这类原型上的名字）一律按德州画，不会拼出空图标', () => {
    const { variantKey, variantIcon } = loadHelpers();
    for (const v of [undefined, null, '', 'stud', 'constructor', '__proto__', 'toString']) {
        assert.equal(variantKey(v), 'nlhe', String(v));
    }
    assert.match(variantIcon('plo'), /#i-v-plo/);
    assert.match(variantIcon('constructor'), /#i-v-nlhe/);
});

test('大厅卡片：三种玩法都有左边的玩法色块（德州也有），色块排在卡片最前面', () => {
    const body = room.slice(room.indexOf('function roomCards'), room.indexOf('// ===== 比赛设置'));
    assert.match(body, /const vk = variantKey\(r\.variant\);/);
    assert.match(body, /<div class="rc-vtile"[^>]*>\$\{ic\(VARIANT_ICON\[vk\]\)\}<b>\$\{L\(variantName\(vk\), VARIANT_CODE\[vk\]\)\}<\/b><\/div>/);
    assert.match(body, /<div class="room-card v-\$\{vk\}">\s*\$\{vtile\}\s*<div class="rc-main">/);
    // 色块用的渐变（白字压在上面）三种都要有
    for (const v of Object.keys(VARIANTS)) assert.match(css, new RegExp(`\\.v-${v}\\s*\\{[^}]*--vg1:\\s*#[0-9a-f]{6};\\s*--vg2:\\s*#[0-9a-f]{6};`), v);
    assert.match(css, /\.rc-vtile \{[^}]*background: linear-gradient\(160deg, var\(--vg1\), var\(--vg2\)\)/);
});

test('行话缩写每种玩法都有', () => {
    const start = room.indexOf('const VARIANT_CODE = ');
    const code = vm.runInNewContext('(' + room.slice(room.indexOf('{', start), room.indexOf('};', start) + 1) + ')');
    assert.deepEqual(Object.keys(code).sort(), Object.keys(VARIANTS).sort());
});

test('建房的玩法按钮：图标 + 名字分开放（名字挂 data-i18n，切语言不会冲掉图标）', () => {
    for (const [v, icon] of [['nlhe', 'v-nlhe'], ['shortdeck', 'v-short'], ['plo', 'v-plo']]) {
        assert.match(html, new RegExp(`class="tier-btn var-btn v-${v}[^"]*" data-variant="${v}"[^>]*><svg class="ic"><use href="#i-${icon}"/></svg><span data-i18n="variant\\.${v}">`), v);
    }
});
