#!/usr/bin/env node
'use strict';
/**
 * CSS 结构体检（部署前关卡的一环）。
 *
 * 缘由：2026-08-08 改注释时多打了一个注释结束符，注释提前闭合，后面两行中文说明变成游离文本，
 * 被 CSS 解析器连同下一条 `#ring-layer { ... }` 一起当成选择器吞掉 —— 座位环定位整个失效，
 * 表现为「座位挤在顶部、开始按钮飘到屏幕中间」。而当时的 jsdom 测试是用【正则】去读这个文件的，
 * 正则照样能匹配到规则里的数值，于是全绿通过、完全没发现文件其实是坏的。
 *
 * 所以这里做真正的结构检查（不依赖正则匹配内容）：
 *   ① 注释必须成对，且不得出现游离的 `*​/`
 *   ② 花括号必须配平
 *   ③ 注释之外不得出现「看起来像正文却不在任何规则里」的裸中文行（就是这次的形态）
 *
 * 用法：node tools/check-css.js   —— 有问题时非 0 退出并指出文件与行号
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'css');
let problems = [];

function checkFile(file) {
    const src = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    const lines = src.split('\n');

    // ① 注释配对 + 游离的 */
    let depth = 0, i = 0;
    const openLines = [];
    while (i < src.length - 1) {
        if (src[i] === '/' && src[i + 1] === '*') {
            depth++; openLines.push(src.slice(0, i).split('\n').length); i += 2; continue;
        }
        if (src[i] === '*' && src[i + 1] === '/') {
            depth--;
            if (depth < 0) {
                problems.push(`${name}:${src.slice(0, i).split('\n').length} 出现多余的 */（注释已提前闭合，后面的说明文字会被当成 CSS 解析）`);
                depth = 0;
            } else openLines.pop();
            i += 2; continue;
        }
        i++;
    }
    if (depth > 0) problems.push(`${name}:${openLines[0]} 注释未闭合（缺 */）`);

    // 去掉注释后再做结构检查
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

    // ② 花括号配平
    let brace = 0;
    for (const ch of stripped) { if (ch === '{') brace++; else if (ch === '}') brace--; }
    if (brace !== 0) problems.push(`${name} 花括号不配平（${brace > 0 ? '缺 }' : '多 }'}，差 ${Math.abs(brace)} 个）`);

    // ③ 规则之外的裸文本：不在任何 { } 内、又不是选择器行（下一处非空字符不是 { 或 ,）
    const sLines = stripped.split('\n');
    let inRule = 0;
    sLines.forEach((line, idx) => {
        const before = inRule;
        for (const ch of line) { if (ch === '{') inRule++; else if (ch === '}') inRule--; }
        if (before > 0 || inRule > 0) return;                 // 规则内部，跳过
        const t = line.trim();
        if (!t) return;
        // 规则外允许：选择器行（含 { 或以 , 结尾）、@ 规则、单独的 }
        if (t.includes('{') || t.endsWith(',') || t.startsWith('@') || t === '}') return;
        problems.push(`${name}:${idx + 1} 规则之外出现裸文本 → “${t.slice(0, 40)}${t.length > 40 ? '…' : ''}”（多半是注释写坏了）`);
    });
}

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.css')) : [];
files.forEach(f => checkFile(path.join(DIR, f)));

if (problems.length) {
    console.error(`❌ CSS 结构检查未通过（${problems.length} 处）：`);
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
}
console.log(`✅ CSS 结构检查通过（${files.length} 个文件：注释配对 / 花括号配平 / 无游离文本）`);
