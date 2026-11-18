'use strict';
// 人头牌画法（2026-11-17，美术第二轮 ⑤）：书法印章 / 道服武者 / 经典字母，玩家在设置里自己选。
// 真实渲染（30px 回经典字母、46px 混合版、72/90px 完整牌面，手机 + 电脑）上线前用真浏览器量过；
// 这里守的是两类改坏了不报错、只会让牌变空白或变丑的地方。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const ART = read('public/js/45-card-art.js');
const CSS = read('public/css/20-table.css');

function artCtx() {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(ART + '\n;this.faceArtSvg = faceArtSvg; this.FACE_ARTS = FACE_ARTS;', ctx);
    return ctx;
}

test('只有 J/Q/K、且选了书法印章 / 道服武者才加图案；经典字母和数字牌原样', () => {
    const { faceArtSvg, FACE_ARTS } = artCtx();
    assert.deepEqual([...FACE_ARTS], ['brush', 'warrior', 'classic']);
    for (const art of ['brush', 'warrior']) for (const r of ['J', 'Q', 'K']) {
        const svg = faceArtSvg(r, '♠', art);
        assert.match(svg, /<g class="fa-full">/, `${art} ${r} 有完整牌面`);
        assert.match(svg, /<g class="fa-mix">/, `${art} ${r} 有混合版`);
        assert.match(svg, /currentColor/, '图案跟着牌的颜色走（四色 / 两色 / 黑面才都对）');
        assert.doesNotMatch(svg, /<script|on\w+=|href=/i, '图案里没有脚本、事件、外链');
    }
    assert.equal(faceArtSvg('K', '♠', 'classic'), '');
    assert.equal(faceArtSvg('A', '♠', 'brush'), '', '数字牌不加图案');
    assert.equal(faceArtSvg('T', '♥', 'warrior'), '');
    assert.equal(faceArtSvg('K', '♠', 'unknown'), '', '不认识的画法当经典字母');
    assert.match(faceArtSvg('J', '♠', 'brush'), /侠/);
    assert.match(faceArtSvg('Q', '♠', 'brush'), /后/);
    assert.match(faceArtSvg('K', '♠', 'brush'), /王/);
});

test('画牌函数把图案层接上；设置默认书法印章，存了不认识的值也回到默认', () => {
    const render = read('public/js/80-table-renderer.js');
    assert.match(render, /faceArtSvg\(c\.rank, sym, settings\.faceArt\)/);
    assert.match(render, /cls\.push\('face-art', 'fa-' \+ settings\.faceArt\)/);
    const audio = read('public/js/50-audio-settings.js');
    assert.match(audio, /faceArt:\s*\(FACE_ARTS\.includes\(localStorage\.getItem\('s_faceArt'\)\) \? localStorage\.getItem\('s_faceArt'\) : 'brush'\)/);
    assert.match(audio, /localStorage\.setItem\('s_faceArt', settings\.faceArt\)/);
    const html = read('index.html');
    for (const fa of ['brush', 'warrior', 'classic']) assert.match(html, new RegExp(`data-fa="${fa}" onclick="setFaceArt\\('${fa}'\\)"`));
});

test('🔴 按牌宽切换的容器查询：阈值按「去掉内边距后的宽度」算，选择器要压得过默认规则', () => {
    // 2026-11-17 第一版：手机上的人头牌整张空白 —— 46px 的牌内容宽只有 34px，被当成小牌藏了图案，
    // 而「把字母显示回来」那条规则写成 .rank 被 .card.face-art > .rank 压住，两样都没了。
    assert.match(CSS, /\.card\.face-art \{[^}]*container: card \/ inline-size/);
    assert.match(CSS, /@container card \(min-width: 49px\) \{ \.card\.face-art \.fa-full \{ display: inline; \} \.card\.face-art \.fa-mix \{ display: none; \} \}/);
    assert.match(CSS, /@container card \(max-width: 26px\) \{ \.card\.face-art > \.fa \{ display: none; \}\s*\.card\.face-art > \.rank, \.card\.face-art > \.suit \{ visibility: visible; \} \}/);
    // 内边距一变，上面两个阈值就得重算（内容宽 ≈ 牌宽 × 0.78 − 2）
    assert.match(CSS, /\.card \{[^}]*padding: calc\(var\(--card-w\) \* 0\.09\) calc\(var\(--card-w\) \* 0\.11\)/);
});

test('毛笔字体：只截了「侠后王」、几 KB、带许可、预加载和 @font-face 是同一个文件', () => {
    const font = path.join(__dirname, 'public/fonts/dojo-brush.woff2');
    assert.ok(fs.existsSync(font));
    assert.ok(fs.statSync(font).size < 4096, `字体 ${fs.statSync(font).size} 字节，截字可能失败了`);
    assert.match(read('public/fonts/MaShanZheng-OFL.txt'), /SIL Open Font License/);
    assert.match(CSS, /font-family: 'DojoBrush'; src: url\('\/fonts\/dojo-brush\.woff2'\)[^}]*unicode-range: U\+4FA0, U\+540E, U\+738B;/);
    assert.deepEqual(['侠', '后', '王'].map(c => c.codePointAt(0).toString(16).toUpperCase()), ['4FA0', '540E', '738B']);
    assert.match(read('index.html'), /<link rel="preload" href="\/fonts\/dojo-brush\.woff2" as="font"/);
});

test('黑面是「漆黑金边」（2026-11-18 用户定）：不再是偏蓝的灰黑；牌背不吃黑面的金色内描边', () => {
    const rule = (CSS.match(/body\.cs-dark \.card:not\(\.back\) \{[^}]*\}/) || [''])[0];
    assert.ok(rule, '黑面规则要排除牌背（牌背也带 .card 类）');
    assert.match(rule, /border-color: #8a6d2a/);
    assert.match(rule, /inset 0 0 0 2px rgba\(201,162,39/);
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里写着旧颜色（说明改了什么），只查规则本身
    assert.doesNotMatch(code, /#252a33|#39404d/, '旧的灰蓝黑面不许回来');
});
