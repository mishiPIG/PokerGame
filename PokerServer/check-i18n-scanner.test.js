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

// ── 翻译条目的反方向：页面用到了、字典里却没有（2026-11-17）──
// 1.11.0 清理孤儿条目时整行删除，把同一行里 18 条还在用的 key 一起删了；
// 玩家看到的是按钮上的 `act.call`、`result.back`。孤儿检查只查一个方向，正好放过了它自己造成的问题。
const { missing, checkMissing } = require('./tools/check-i18n-orphans');
const DICT = "const I18N = {\n    zh: {\n        'a.one': '一', 'a.two': '二',\n    },\n    en: {\n        'a.one': 'one',\n    },\n};";

test('🔴 页面用到、字典里没有的 key 会被报出来（中英分别查）', () => {
    const client = '<b data-i18n="a.one"></b> t(\'a.two\') <i data-i18n-title="a.three"></i>';
    assert.deepEqual(new Set(missing(DICT, client)), new Set(["zh  'a.three'", "en  'a.three'", "en  'a.two'"]));
});

test('仓库里现在没有缺失的翻译', () => {
    assert.deepEqual(checkMissing(), []);
});
