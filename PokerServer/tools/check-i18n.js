#!/usr/bin/env node
'use strict';
/**
 * 双语体检（部署前关卡的一环）。
 *
 * 缘由：2026-09-10 玩家实拍——界面已切成 English，可键盘快捷键那六行、
 * 牌桌上「XX 想看河牌」那行提示、登录报错、语音提示…还是中文。
 * 逐个修完之后发现真正的问题不是「漏翻了几条」，而是【没有任何东西拦着漏翻】：
 * 加新功能时顺手写一句中文，谁也不会发现，直到某天有人截图。
 *
 * 所以这里守住一条规矩：**玩家能看到的文案必须是双语的**。
 *   ① public/js/*.js 里的中文字符串，必须包在 L(zh, en) / t(key, zh) / apiErr(data, zh, en) 里
 *   ② index.html 里的中文文本 / placeholder / title，必须挂 data-i18n / -ph / -title
 *   ③ 服务端【发给玩家】的中文必须带结构化 key（广播一条写死的文案满足不了同桌两种语言）
 *
 * 放行的几种情况（都要求写清楚原因）：
 *   · console.* —— 服务器/浏览器日志，玩家看不到，本来就该保持中文
 *   · 同行有 `lang === 'en'` 的三元 —— 本来就是按语言取的两套
 *   · 显式标注 `i18n-ok: 理由`（JS 注释 / HTML 注释都行）—— 如成对的 zh/en 数据表、产品名
 *
 * 用法：node tools/check-i18n.js   —— 有问题时非 0 退出并指出文件与行号
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CJK = /[一-鿿]/;
const problems = [];

// 管理面板用户明确说不译（2026-09-06 定），整份跳过
const SKIP_JS = new Set(['03-i18n.js', '90-admin.js']);

// ---------- 工具：把注释挖掉，但保留行号 ----------
function blankComments(src) {
    let out = '', i = 0, mode = null, quote = '';
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (mode === null) {
            if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; }
            out += c; i++; continue;
        }
        if (mode === 'line') { if (c === '\n') { mode = null; out += c; } else out += ' '; i++; continue; }
        if (mode === 'block') {
            if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; }
            out += (c === '\n' ? '\n' : ' '); i++; continue;
        }
        if (c === '\\') { out += c + (n || ''); i += 2; continue; }   // 字符串里的转义
        if (c === quote) mode = null;
        out += c; i++;
    }
    return out;
}

// 产出字符串字面量；模板串已剔除 ${...} 插值（插值里的 L(...) 会被单独扫到）
function* literals(src) {
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            let j = i + 1, buf = '';
            while (j < src.length && src[j] !== c) {
                if (src[j] === '\\') { buf += src[j + 1] || ''; j += 2; continue; }
                if (src[j] === '\n') break;
                buf += src[j++];
            }
            yield { at: i, text: buf }; i = j + 1; continue;
        }
        if (c === '`') {
            let j = i + 1, buf = '';
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '$' && src[j + 1] === '{') {              // 跳过整段插值
                    let depth = 1; j += 2;
                    while (j < src.length && depth) {
                        if (src[j] === '{') depth++;
                        else if (src[j] === '}') depth--;
                        j++;
                    }
                    continue;
                }
                if (src[j] === '`') break;
                buf += src[j++];
            }
            yield { at: i, text: buf }; i = j + 1; continue;
        }
        i++;
    }
}

// ---------- ① 客户端 JS ----------
// `i18n-ok` 标记的作用范围：从标记那行起，一直到它所标注的那个块结束
// （`];` / `};` / 空行）。成对的 zh/en 数据表动辄十几行，只放行上下三行是不够的。
function exemptLines(rawLines) {
    const exempt = new Set();
    rawLines.forEach((ln, i) => {
        if (!/i18n-ok/.test(ln)) return;
        for (let j = i; j < Math.min(rawLines.length, i + 40); j++) {
            exempt.add(j + 1);
            const t = rawLines[j].trim();
            if (j > i && (t === '' || /^[\]}]\s*;?$/.test(t))) break;
        }
    });
    return exempt;
}

function checkClientJs(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const src = blankComments(raw);
    const rawLines = raw.split('\n');
    const exempt = exemptLines(rawLines);
    const name = path.relative(ROOT, file).replace(/\\/g, '/');

    for (const lit of literals(src)) {
        if (!CJK.test(lit.text)) continue;
        const line = src.slice(0, lit.at).split('\n').length;
        const before = src.slice(Math.max(0, lit.at - 90), lit.at);
        // 已经是 L(中文, English) / t('key', 中文) / apiErr(data, 中文, English) 的参数
        if (/\bL\(\s*$/.test(before)) continue;
        if (/\bt\(\s*'[^']*'\s*,\s*$/.test(before)) continue;
        if (/\bapiErr\([^,]*,\s*$/.test(before)) continue;
        // 拼接进 L(...) 的后半截，如 L('前缀' + x + '后缀', '…')
        if (/\bL\([^;]*\+\s*$/.test(before)) continue;
        if (exempt.has(line)) continue;
        if (/lang\s*===\s*'en'/.test(rawLines[line - 1] || '')) continue;
        if (/console\.(log|warn|error|info|debug)\s*\(/.test(rawLines[line - 1] || '')) continue;
        problems.push(`${name}:${line} 中文文案没有英文版 → “${lit.text.trim().slice(0, 34)}”`);
    }
}

// ---------- ② index.html ----------
function checkHtml(file, owned) {
    let html = fs.readFileSync(file, 'utf8');
    const name = path.basename(file);
    // <!-- i18n-ok: 理由 --> … <!-- /i18n-ok --> 之间整段放行（管理面板、产品名等）
    html = html.replace(/<!--\s*i18n-ok[\s\S]*?<!--\s*\/i18n-ok\s*-->/g, m => m.replace(/[^\n]/g, ' '));
    html = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
        m => m.replace(/[^\n]/g, ' '));
    const lineAt = idx => html.slice(0, idx).split('\n').length;

    for (const m of html.matchAll(/>([^<>]*)</g)) {                 // 文本节点
        const text = m[1].trim();
        if (!text || !CJK.test(text)) continue;
        const tag = html.slice(html.lastIndexOf('<', m.index), m.index + 1);
        if (/data-i18n(=|\s|>)/.test(tag)) continue;
        // 一个元素只有一个文本所有者：JS 会写它 → HTML 里那串中文只是占位，永远不会被看到
        const idm = /id="([^"]+)"/.exec(tag);
        if (idm && owned.has(idm[1])) continue;
        problems.push(`${name}:${lineAt(m.index)} 文本没挂 data-i18n → “${text.slice(0, 34)}”`);
    }
    for (const attr of ['placeholder', 'title']) {                  // 属性
        const re = new RegExp(attr + '="([^"]*)"', 'g');
        for (const m of html.matchAll(re)) {
            if (!CJK.test(m[1])) continue;
            const tagStart = html.lastIndexOf('<', m.index);
            const tag = html.slice(tagStart, html.indexOf('>', m.index) + 1);
            const marker = attr === 'placeholder' ? 'data-i18n-ph' : 'data-i18n-title';
            if (tag.includes(marker)) continue;
            problems.push(`${name}:${lineAt(m.index)} ${attr} 没挂 ${marker} → “${m[1].slice(0, 30)}”`);
        }
    }
}

// ---------- ③ 服务端发给玩家的文案 ----------
function checkServer(dir) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const file of walk(dir).filter(f => f.endsWith('.js'))) {
        const name = path.relative(ROOT, file).replace(/\\/g, '/');
        // 管理接口不译（用户定），跳过
        if (name.includes('register-admin-routes')) continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((ln, i) => {
            const line = i + 1;
            if (/i18n-ok/.test(ln)) return;
            // (a) HTTP 错误响应必须带 k，否则英文界面上会冒出一句中文
            const err = /error:\s*(?:'([^']*)'|`([^`]*)`)/.exec(ln);
            if (err && CJK.test(err[1] || err[2]) && !/\bk:\s*'/.test(ln)) {
                problems.push(`${name}:${line} HTTP 错误没带结构化 k → “${(err[1] || err[2]).slice(0, 28)}”`);
            }
            // (b) 直接发给玩家看的事件不得写死中文（广播满足不了同桌两种语言）
            if (/emit\(\s*'(table_notice|invite_error)'/.test(ln) && CJK.test(ln)) {
                problems.push(`${name}:${line} 玩家可见事件写死了中文，应改发 { k, p }`);
            }
        });
        // server_msg 必须整条调用一起看，不能按行 —— 见 scanServerMsg 的注释
        scanServerMsg(name, fs.readFileSync(file, 'utf8'));
    }
}


// ---------- ③b server_msg：本该给玩家看的东西，不许写成裸字符串 ----------
// 🔴 两个教训都刻在这里，别再退回去：
//   ① 必须按【整个 emit 调用】取参数，不能按行。补码失败那两条是【跨行三元】：
//        socket.emit('server_msg', cond
//            ? `⚠️ 金币不足…`
//            : `⚠️ 补码失败…`);
//      按行匹配 `emit('server_msg', '⚠` 对它完全视而不见 —— 而那是玩家补码失败时
//      必定看到的提示，英文界面上一直显示中文，没有任何东西报过警。
//   ② 前缀清单【不在这里写第二份】。当初把客户端 toast 过滤从「只弹 ⚠️」扩到
//      ⚠️/✅/👥 时忘了同步扩这条规则，`✅ 已解散房间` 就这么一直漏着。
//      现在改成：先确认客户端仍然按【形态】判可见性（结构化才上屏幕），
//      前缀只用来识别「作者本来就想让玩家看到」的意图。
const VISIBLE_PREFIX = ['\u26a0', '\u2705', '\ud83d\udc65'];   // ⚠️ 拒绝 / ✅ 成功 / 👥 牌友

function assertVisibilityContract() {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/20-socket.js'), 'utf8');
    if (!/typeof msg === 'object'/.test(src)) {
        problems.push('public/js/20-socket.js server_msg 的可见性判定不再是「结构化才上屏幕」'
            + ' —— 按 emoji 前缀判已经漏过两次（只认 ⚠️ / 字符类拆代理对），别退回去');
    }
}

// 取 emit('server_msg', <参数>) 的参数文本；括号配平，所以跨行三元也能整条拿到
function emitArgs(src, from) {
    const open = src.indexOf('(', from);
    if (open < 0) return '';
    let depth = 0;
    for (let j = open; j < src.length && j < open + 4000; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(open + 1, j); }
    }
    return '';
}

function scanServerMsg(name, src) {
    const re = /emit\(\s*'server_msg'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const args = emitArgs(src, m.index);
        if (/\{\s*k:/.test(args) || /i18n-ok/.test(args)) continue;      // 已结构化 / 明确放行
        for (const lit of args.match(/(['"`])(?:\\.|(?!\1)[\s\S]){0,200}?\1/g) || []) {
            const body = lit.slice(1, -1);
            if (VISIBLE_PREFIX.some(px => body.startsWith(px)) && CJK.test(body)) {
                const line = src.slice(0, m.index).split('\n').length;
                problems.push(`${name}:${line} 这条本该给玩家看（${body.slice(0, 8)}…），`
                    + '写成裸字符串就永远弹不出来，必须发 { k, p }');
                break;
            }
        }
    }
}

// ---------- ④ data-i18n 不能挂在「文本由 JS 写」的元素上 ----------
// 2026-09-13 实拍：大厅底部一直显示「前端 …」这个占位符。
// 原因是我给 #ver-client 挂了 data-i18n，而它的文本是 loadVersion() 填的 ——
// applyLang() 会 el.textContent = 字典值，把 JS 刚写进去的真实版本号覆盖回占位符。
// 这类 bug 的表现是「某个值永远停在占位符上」，很难联想到是翻译干的。
function collectJsOwned() {
    const jsDir2 = path.join(ROOT, 'public', 'js');
    const owned = new Map();                       // id -> 哪个文件在写它

    for (const f of fs.readdirSync(jsDir2).filter(x => x.endsWith('.js'))) {
        const src = blankComments(fs.readFileSync(path.join(jsDir2, f), 'utf8'));
        // (a) 直接写：getElementById('x').textContent = …
        for (const m of src.matchAll(/getElementById\('([^']+)'\)\s*\.\s*(?:textContent|innerHTML)\s*=/g)) {
            owned.set(m[1], f);
        }
        // (b) 先存变量再写：const el = document.getElementById('x'); … el.textContent = …
        // ⚠️ 只在【紧随其后的一小段】里找，不要全文件搜：el / b / cc 这种通用名满文件都是，
        //    全文件搜会把「只读不写」的元素也算成 JS 拥有（第一版就误报了 btnReady）。
        const SCOPE = 1500;
        // 不要要求 const/let/var 开头：`const cEl = …, sEl = …` 这种逗号声明
        // 只会匹配到第一个（#ver-server 当初就是这么漏的）。
        for (const m of src.matchAll(/(\w+)\s*=\s*document\.getElementById\('([^']+)'\)/g)) {
            const near = src.slice(m.index, m.index + SCOPE);
            const re = new RegExp('\\b' + m[1] + '\\s*\\.\\s*(?:textContent|innerHTML)\\s*=');
            if (re.test(near)) owned.set(m[2], f);
        }
    }

    return owned;
}

function checkJsOwned(owned) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const [id, file] of owned) {
        // 找到 index.html 里这个元素的开标签
        const at = html.indexOf(`id="${id}"`);
        if (at < 0) continue;
        const tagStart = html.lastIndexOf('<', at);
        const tag = html.slice(tagStart, html.indexOf('>', at) + 1);
        if (/i18n-ok/.test(html.slice(Math.max(0, tagStart - 120), tagStart))) continue;
        const m = /data-i18n="([^"]+)"/.exec(tag);
        if (m) {
            problems.push(`index.html: #${id} 的文本由 ${file} 写，却挂着 data-i18n="${m[1]}" `
                + `→ 切语言/首次 applyLang 会把它覆盖回占位符。改成在 JS 里用 t()/L()，并 onLangChange 重渲染。`);
        }
    }
}

const jsDir = path.join(ROOT, 'public', 'js');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js') && !SKIP_JS.has(f));
jsFiles.forEach(f => checkClientJs(path.join(jsDir, f)));
const jsOwned = collectJsOwned();
checkHtml(path.join(ROOT, 'index.html'), jsOwned);
assertVisibilityContract();
checkServer(path.join(ROOT, 'src'));
checkJsOwned(jsOwned);

if (problems.length) {
    console.error(`❌ 双语检查未通过（${problems.length} 处）——英文界面上这些地方会显示中文：`);
    problems.forEach(p => console.error('   ' + p));
    console.error('   修法：客户端包 L(中文, English)；HTML 挂 data-i18n；服务端发 { k, p } 并在 03-i18n.js 里补中英两条。');
    console.error('   确实不需要翻译的（日志、产品名、成对的 zh/en 数据表），就地写一句 i18n-ok: 原因。');
    process.exit(1);
}
console.log(`✅ 双语检查通过（${jsFiles.length} 个客户端脚本 + index.html + 服务端外发文案）`);
