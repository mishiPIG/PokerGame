'use strict';

// 牌桌视觉层级的守卫（2026-09-09，打磨 D）。
//
// 评审结论是「牌桌常驻 11 个元素 + 每座位 7 层，权重却是平的 —— 新手眼睛不知道往哪落」。
// 三档契约写在 public/css/20-table.css 开头。层级这种东西没法断言「好看」，
// 但它有几条【可机检的不变量】，这里守住的就是那几条：
//   ① 只有 T1（瞬时状态）允许常驻动效 —— 多一个永远在闪的东西，「轮到谁」就弱一分
//   ② 字号阶梯不许倒挂（底池 > 座位筹码 > 座位名字）
//   ③ 写了 CSS 就必须有人挂那个 class（防「规则永远不生效」的死代码）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

// 画在牌桌上的三个样式表（大厅/设置/回放不在此列）
const TABLE_CSS = ['public/css/00-shell.css', 'public/css/20-table.css', 'public/css/50-effects.css'];

// 允许常驻动效的选择器 —— 全部是【瞬时状态】：轮到你 / 只剩 5 秒 / 全押 / 赢了 /
// 跑马胜率 / 可以亮牌 / 高牌定庄赢家。它们出现的时候，本来就该看它们。
const ALLOWED_INFINITE = new Set([
    '.seat.acting .avatar-block',
    '.seat.lowtime .avatar-block',
    '.seat.allin .avatar-block',
    '.seat.winner .avatar-block',
    '.avatar-ring.low',
    '.equity-badge',
    '.show-hint',
    '.bd-card.win',
]);

// 找到某处声明所属的选择器：从它往回找最近的 '{'，再往回找上一条规则的结尾。
function selectorOf(text, idx) {
    const open = text.lastIndexOf('{', idx);
    if (open < 0) return '(顶层)';
    const prev = Math.max(text.lastIndexOf('}', open), text.lastIndexOf(';', open));
    return text.slice(prev + 1, open).replace(/\s+/g, ' ').trim();
}

test('🔴 只有「瞬时状态」允许常驻动效，背景元素一律不许 infinite', () => {
    const found = [];
    for (const f of TABLE_CSS) {
        const text = stripComments(read(f));
        const re = /animation[^;{}]*\binfinite\b/g;
        let m;
        while ((m = re.exec(text))) {
            const sel = selectorOf(text, m.index);
            if (sel.startsWith('@')) continue;                 // @keyframes 内部不算
            if (!ALLOWED_INFINITE.has(sel)) found.push(`${f}: ${sel}`);
        }
    }
    assert.deepEqual(found, [],
        '这些选择器在牌桌上永久播放动画，会和「轮到谁」抢注意力。\n' +
        '若确实是瞬时状态（只在某个短暂阶段出现），把它加进 ALLOWED_INFINITE 并说明理由；\n' +
        '若是常驻元素（横幅/水印/旗子/徽章），请改成有限次数：\n  ' + found.join('\n  '));
});

test('🔴 straddle 小旗不许再变回永久闪烁', () => {
    // 它是常驻的（有效期到下一手开始），原来 infinite 一直在闪。
    // 单独立一条是因为这面旗子就是当初把这条规矩逼出来的那个东西。
    const shell = stripComments(read('public/css/00-shell.css'));
    const i = shell.indexOf('#straddle-flag');
    assert.ok(i >= 0, '#straddle-flag 规则不见了');
    const block = shell.slice(i, shell.indexOf('}', i));
    assert.match(block, /animation:\s*strPulse[^;]*\s\d+\s*;/, 'strPulse 必须指定有限次数');
    assert.doesNotMatch(block, /infinite/);
});

test('字号阶梯不许倒挂：底池 > 座位筹码 > 座位名字', () => {
    const css = stripComments(read('public/css/20-table.css'));
    const sizeOf = (sel) => {
        const i = css.indexOf(sel + ' {');
        assert.ok(i >= 0, `找不到规则 ${sel}`);
        const m = /font-size:\s*([\d.]+)px/.exec(css.slice(i, css.indexOf('}', i)));
        assert.ok(m, `${sel} 没有 font-size`);
        return parseFloat(m[1]);
    };
    const pot = sizeOf('.pot-total'), chips = sizeOf('.seat .chips'), name = sizeOf('.seat .name');
    assert.ok(pot > chips, `底池总额(${pot}px) 必须大于座位筹码(${chips}px)`);
    assert.ok(chips > name, `座位筹码(${chips}px) 必须大于座位名字(${name}px)——名字是认人用的，不该和钱抢`);
});

test('🔴 has-actor 降权规则必须真的有人给它挂 class', () => {
    // 只写 CSS 不挂 class = 一条永远不生效的规则，而且看不出来。
    // （这个项目栽过一次：快捷键调了个拼错的函数名，测试还配合着把错名字 stub 了。）
    const css = stripComments(read('public/css/20-table.css'));
    assert.match(css, /#ring-layer\.has-actor\s/, 'CSS 里缺少 has-actor 的降权规则');
    const js = read('public/js/80-table-renderer.js');
    assert.match(js, /classList\.toggle\(\s*'has-actor'/, '渲染器没有挂 has-actor，CSS 那条规则永远不会生效');
    // 且必须由「当前行动者」驱动，不能挂个恒真的条件
    const i = js.indexOf("classList.toggle('has-actor'");
    assert.match(js.slice(i, i + 120), /actionOnUserId/, 'has-actor 必须跟着当前行动者走');
});
