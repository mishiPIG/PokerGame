'use strict';

// 牌桌美术与动效（2026-09-29）的守卫。
//
// 美术本身没法断言「好看」，但这一批有几条【坏了不会有任何报错、只会悄悄变丑/变哑】的地方：
//   ① 采样音效 / 字体文件缺了 —— 前端静默退回合成音、系统字体，没人会发现
//   ② 第三方素材的许可文件没随包发出去 —— 仓库是公开的
//   ③ 只给一帧的 Web Animations 关键帧，方向默认是反的（截图当场抓到过：牌一上来就是亮的）
//   ④ 时间线动效必须在每次整体重建座位 DOM 之后重新挂上，否则一次重绘就把发牌动画掐断
//   ⑤ 写了 CSS 就必须有人挂那个 class（同 table-hierarchy 里 has-actor 那条的理由）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, 'public');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

function sfxTable() {
    const js = read('public/js/50-audio-settings.js');
    const i = js.indexOf('const SFX_FILES = {');
    assert.ok(i >= 0, '找不到 SFX_FILES');
    const block = js.slice(i, js.indexOf('};', i));
    return [...block.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
}

test('采样音效：引用到的文件都在、没有多余的、许可随包', () => {
    const names = sfxTable();
    assert.ok(names.length >= 8, '采样表里的文件数不对劲：' + names.length);
    const dir = path.join(PUB, 'sfx');
    const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).map(f => f.replace(/\.mp3$/, ''));
    const missing = names.filter(n => !onDisk.includes(n));
    assert.deepEqual(missing, [], '这些采样被引用了但文件不在（前端会静默退回合成音，没人会发现）');
    const orphan = onDisk.filter(n => !names.includes(n));
    assert.deepEqual(orphan, [], '这些文件没人用，别让每个玩家白下载');
    const total = onDisk.reduce((s, n) => s + fs.statSync(path.join(dir, n + '.mp3')).size, 0);
    assert.ok(total < 200 * 1024, `采样总大小 ${total} 字节，超过 200KB —— 它是懒加载的，但也不该越长越大`);
    assert.ok(fs.existsSync(path.join(dir, 'Kenney-Casino-Audio-License.txt')), '第三方素材的许可文件必须随包发出');
});

test('点数字体：文件在、许可在、preload 与 @font-face 指向同一个文件', () => {
    const css = read('public/css/20-table.css');
    const m = /@font-face\s*\{[^}]*font-family:\s*'DojoRank'[^}]*url\('([^']+)'\)/.exec(css);
    assert.ok(m, '找不到 DojoRank 的 @font-face');
    const url = m[1];
    assert.ok(fs.existsSync(path.join(PUB, url)), `字体文件不存在：${url}`);
    assert.ok(fs.existsSync(path.join(PUB, 'fonts/Jost-OFL.txt')), 'SIL OFL 要求许可文本随字体一起分发');
    // 两处写的不是同一个文件 → 浏览器会下载两次，而且 preload 那份白下
    assert.ok(read('index.html').includes(`<link rel="preload" href="${url}" as="font"`),
        'index.html 的 preload 必须和 @font-face 指向同一个文件');
    assert.match(stripComments(css), /\.card \.rank \{[^}]*font-family:\s*'DojoRank'/, '点数没用上这个字体');
});

test('🔴 只给一帧的 Web Animations 关键帧必须写 offset: 0', () => {
    // 规范：只有一帧时它被当作【终点】（offset 1），起点取元素当前样式 —— 动画方向整个反了。
    // flipFrom 想要的是「从隐藏翻到正常」，写成默认就成了「从正常翻到隐藏」，
    // 而 fill:backwards 在开始前显示的正是「正常」→ 发牌时牌一上来就是亮的。
    const offenders = [];
    for (const f of fs.readdirSync(path.join(PUB, 'js'))) {
        const src = fs.readFileSync(path.join(PUB, 'js', f), 'utf8');
        for (const m of src.matchAll(/\.animate\(\[\s*(\{[^{}\]]*\})\s*\]/g)) {
            if (!/offset:\s*0\b/.test(m[1])) offenders.push(`${f}: ${m[1]}`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('🔴 时间线动效在每次重建座位 DOM 之后都要重新挂上', () => {
    const js = read('public/js/80-table-renderer.js');
    const i = js.indexOf('function renderSeats(');
    const body = js.slice(i, js.indexOf('\n}\n', i));
    const rebuild = body.indexOf('ring.innerHTML = html');
    const reapply = body.indexOf('applyTimelineFx()');
    assert.ok(rebuild >= 0, 'renderSeats 不再整体重建？那这条守卫要跟着改');
    assert.ok(reapply > rebuild, 'renderSeats 重建 DOM 之后必须调用 applyTimelineFx()，否则一次重绘就掐断发牌/亮牌动画');
});

test('全押聚光：CSS 写了就必须有人挂，而且新一手必须撤掉', () => {
    const css = stripComments(read('public/css/20-table.css'));
    assert.match(css, /#table-area\.allin-spot\s/);
    assert.match(css, /\.seat:not\(\.revealed\)/);
    const r = read('public/js/80-table-renderer.js');
    assert.match(r, /classList\.toggle\('allin-spot', allinSpot/, '渲染器没有挂 allin-spot');
    assert.match(r, /revealedCards\[p\.userId\] \? 'revealed'/, '座位没有挂 revealed，聚光会把全押的人也压暗');
    // 聚光要是撤不掉，下一手整桌都是暗的
    const s = read('public/js/20-socket.js');
    const h = s.indexOf("socket.on('hole_cards'");
    assert.match(s.slice(h, s.indexOf('});', h)), /allinSpot = false/, '新一手发牌时必须撤掉全押聚光');
});

test('系统「减少动效」被尊重：CSS 与 JS 两边都查', () => {
    assert.match(read('public/css/50-effects.css'), /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*#table-view/);
    const r = read('public/js/80-table-renderer.js');
    assert.match(r, /function timelineFxOk\(\)[^}]*reducedMotion\(\)/, '发牌/亮牌时间线要查 reducedMotion');
    assert.match(read('public/js/50-audio-settings.js'), /function flyCoins[^\n]*\n[^\n]*reducedMotion\(\)/, '飞筹码要查 reducedMotion');
});
