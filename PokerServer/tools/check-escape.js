#!/usr/bin/env node
'use strict';
// 关卡：拼进 HTML 的「别人能控制的数据」必须先转义（2026-11-14 加，接入 npm run check）。
//
// 🔴 为什么要有它：头像字段曾经能设成 `x" onerror="…"`，而客户端四处把它原样拼进
//    `<img src="${p.avatar}">` —— 同桌每个人的浏览器都会执行那段代码（2026-11-14 修复）。
//    那四处都是「顺手写的模板串」，code review 很难盯住。靠记性防不住第二次，所以变成关卡。
//
// 规则：前端 JS 里，内容像 HTML 的模板串（含 `<标签`）中，每一个 `${…}` 插值
//    只要用到了下面 RISKY 里的字段（名字 / 头像 / 备注 / 聊天文本 / 房间名 …），
//    这些字段就必须出现在 escapeHtml(…) 里面。
//    放行：在同一行（或上一行）写 `escape-ok: 原因`，例如「这是我们自己的常量表」。
//
// ⚠️ 这是启发式，不是证明：它按字段名判断「可能来自别人」。
//    加了新的用户输入字段（比如以后的「个性签名」），记得把名字补进 RISKY。

const fs = require('fs');
const path = require('path');
const { blankComments } = require('./check-i18n');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'js');

// 值可能来自其他玩家（或玩家自己可以随便填）的字段名
const RISKY = /(?:^|[^\w$])(username|displayName|display_name|avatar|note|contact|email|roomName|nick|text|msg|message|body|content|reason)\b|\.name\b|(?:^|[^\w$.])name\b/;

// 产出模板串里的每一个插值：{ at, expr, html }（html=这个模板串看起来是不是 HTML）
function* interpolations(src, base = 0) {
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {                     // 普通字符串：跳过
            let j = i + 1;
            while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            i = j + 1; continue;
        }
        if (c !== '`') { i++; continue; }
        let j = i + 1, text = '';
        const found = [];
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '$' && src[j + 1] === '{') {
                let depth = 1; j += 2; const from = j;
                while (j < src.length && depth) {
                    const ch = src[j];
                    if (ch === '`') {                      // 插值里嵌套的模板串整段跳过（下面递归扫）
                        j++;
                        while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
                    } else if (ch === '{') depth++;
                    else if (ch === '}') depth--;
                    j++;
                }
                // 记下插值前面的模板正文：用来判断它是不是落在 onclick="…" 这种内联事件里
                found.push({ at: base + from, expr: src.slice(from, j - 1), before: text });
                continue;
            }
            if (src[j] === '`') break;
            text += src[j++];
        }
        const html = /<[a-z!\/]/i.test(text);
        for (const f of found) {
            const inHandler = /\son[a-z]+\s*=\s*"[^"]*$/i.test(f.before);
            yield { at: f.at, expr: f.expr, html, inHandler };
            yield* interpolations(f.expr, f.at);          // 插值里面还可能有 HTML 模板串
        }
        i = j + 1;
    }
}

// 把 escapeHtml(…) 整段、嵌套模板串、字符串字面量从表达式里抠掉，剩下的才算「裸用」
function bareParts(expr) {
    let out = '', i = 0;
    while (i < expr.length) {
        if (expr.startsWith('escapeHtml(', i)) {
            let depth = 0, j = i + 'escapeHtml'.length;
            do { if (expr[j] === '(') depth++; else if (expr[j] === ')') depth--; j++; } while (j < expr.length && depth);
            out += ' '; i = j; continue;
        }
        const c = expr[i];
        if (c === '`' || c === '"' || c === "'") {
            let j = i + 1;
            while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
            out += ' '; i = j + 1; continue;
        }
        out += c; i++;
    }
    // 只拿来当三元条件的不算「拼进去」：`${email ? escapeHtml(email) : '…'}` 里的第一个 email
    return out.replace(/[\w$.]+\s*\?(?![.?])/g, ' ');
}

function check() {
    const problems = [];
    for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.js')).sort()) {
        const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
        const src = blankComments(raw);
        const rawLines = raw.split('\n');
        for (const it of interpolations(src)) {
            if (!it.html) continue;
            // 落在 onclick="…" 里的插值是 JS 代码上下文：浏览器会先把属性值里的 &#39; 解码回 '，
            // escapeHtml 在这里挡不住任何东西 —— 所以这种位置连「转义过的」名字也不许放，
            // 要改成 data-xxx="${escapeHtml(…)}" + this.dataset.xxx。
            const bare = it.inHandler ? bareParts(it.expr.replace(/escapeHtml\(/g, '(')) : bareParts(it.expr);
            if (!RISKY.test(bare)) continue;
            const line = src.slice(0, it.at).split('\n').length;
            if (/escape-ok/.test(rawLines[line - 1] || '') || /escape-ok/.test(rawLines[line - 2] || '')) continue;
            problems.push(`public/js/${f}:${line}  ${it.inHandler ? '[内联事件里] ' : ''}\${${it.expr.trim().replace(/\s+/g, ' ').slice(0, 100)}}`);
        }
    }
    return problems;
}

if (require.main === module) {
    const problems = check();
    if (problems.length) {
        console.error(`❌ 有 ${problems.length} 处把可能来自别人的数据直接拼进了 HTML（要包 escapeHtml，或注明 escape-ok: 原因）：`);
        problems.forEach(p => console.error('   ' + p));
        process.exit(1);
    }
    console.log('✅ 转义检查通过（前端模板串里的名字 / 头像 / 备注 / 文本类字段都已转义）');
} else {
    module.exports = { check, interpolations, bareParts, RISKY };
}
