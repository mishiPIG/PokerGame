'use strict';
// check-i18n 扫描器本身的反向对照。
// 2026-09-29：它扫模板串时把 ${...} 整段跳过，注释却写着「插值里的会被单独扫到」—— 其实没有。
// 于是 `${isMe ? '<span>你</span>' : ''}` 一直漏检，英文界面牌谱详情里挂着「你」「弃牌」，
// 是最终验收的英文截图才看出来的。关卡有盲区时它不会报错，只会一直说「通过」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { literals } = require('./tools/check-i18n');

const texts = (src) => [...literals(src)].map(l => l.text);

test('🔴 模板串插值里的字符串也要被扫到', () => {
    const src = "const h = `<div>${isMe ? '<span>你</span>' : ''}${x}</div>`;";
    assert.ok(texts(src).includes('<span>你</span>'), '插值里的中文没被扫到 —— 盲区又回来了');
});

test('插值嵌套模板串、多层插值都能扫到', () => {
    const src = "const h = `a${ok ? `<b>${L('弃牌', 'Fold')}</b>` : `<i>未准备</i>`}z`;";
    const t = texts(src);
    assert.ok(t.includes('<i>未准备</i>'), '嵌套模板串里的中文没被扫到');
    assert.ok(t.includes('弃牌'), '多层插值里的字面量没被扫到');
});

test('位置要对：递归扫出来的字面量报的是它在原文件里的偏移', () => {
    const src = "x;\nconst h = `${a ? '你' : ''}`;";
    const hit = [...literals(src)].find(l => l.text === '你');
    assert.equal(src.slice(0, hit.at).split('\n').length, 2, '行号报错了');
    assert.equal(src[hit.at], "'");
});
