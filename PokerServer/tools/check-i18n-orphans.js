#!/usr/bin/env node
'use strict';
// 关卡：字典里有、却没有任何地方用到的翻译条目（2026-11-14 加，接入 npm run check）。
//
// 为什么要有：全量排查时一次清出 24 条「中英文都写了、但没人用」的条目 ——
// 功能改掉了、按钮删掉了，翻译还留着。它们不会报错，只会让字典越来越难维护：
// 改一句文案时根本分不清哪条是活的。
//
// 「用到」的判定（任一即可）：
//   · 前端 / index.html 里出现了这个 key 的字面量（'k' "k" `k` 或 data-i18n="k"）
//   · srv.xxx / err.xxx：服务端发了 { k: 'xxx' }（客户端按 'srv.' + k / 'err.' + k 拼出来查）
//   · 落在一个「动态拼接」的前缀下（如 'notice.wantSee.' + street），且后半截也确实出现过
// 放行：字典里该行写 `// i18n-orphan-ok: 原因`。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DICT = path.join(ROOT, 'public/js/03-i18n.js');

function walk(dir, ext, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, ext, out); }
        else if (ext.some(x => e.name.endsWith(x))) out.push(p);
    }
    return out;
}

function dictKeys(src) {
    const keys = new Map();   // key -> { line, exempt }
    src.split('\n').forEach((ln, i) => {
        const m = /^\s*'([\w.]+)'\s*:/.exec(ln);
        if (m && !keys.has(m[1])) keys.set(m[1], { line: i + 1, exempt: /i18n-orphan-ok/.test(ln) });
    });
    return keys;
}

function check() {
    const dictSrc = fs.readFileSync(DICT, 'utf8');
    const keys = dictKeys(dictSrc);
    const client = [path.join(ROOT, 'index.html'), ...walk(path.join(ROOT, 'public/js'), ['.js'])]
        .filter(f => f !== DICT).map(f => fs.readFileSync(f, 'utf8')).join('\n')
        // 03-i18n.js 里除字典以外的代码（t() / renderServerMsg 等）也算「用到」的来源
        + '\n' + dictSrc.slice(dictSrc.lastIndexOf('\n};'));
    const server = walk(path.join(ROOT, 'src'), ['.js']).map(f => fs.readFileSync(f, 'utf8')).join('\n');
    // 服务端的 key 不一定写成 k: 'xxx'：也有三元（k: ok ? 'a' : 'b'）和先存进变量再发的（如建房上限）。
    // 所以凡是服务端代码里出现过的、长得像 key 的字符串字面量都算。
    // （err.xxx 的 key 没有点号，如 k: 'nameLen'；srv.xxx 的有，如 'friend.self'。两种都收。）
    const serverK = new Set([...server.matchAll(/['"`]([a-zA-Z][\w.]*)['"`]/g)].map(m => m[1]));
    // 服务端也会动态拼 k：'notice.wantSee.' + street 这种
    const serverPrefixes = [...server.matchAll(/\bk:\s*['"`]([\w.]+\.)['"`]\s*\+/g)].map(m => m[1]);
    const clientPrefixes = [...client.matchAll(/['"`]([a-zA-Z][\w]*\.(?:[\w]+\.)*)['"`]\s*\+/g)].map(m => m[1])
        .concat([...client.matchAll(/`([a-zA-Z][\w]*\.(?:[\w]+\.)*)\$\{/g)].map(m => m[1]));

    const lit = (k) => new RegExp(`['"\`]${k.replace(/\./g, '\\.')}['"\`]`).test(client);
    const orphans = [];
    for (const [k, info] of keys) {
        if (info.exempt || lit(k)) continue;
        if (k.startsWith('srv.') || k.startsWith('err.')) {
            const rest = k.slice(4);
            if (serverK.has(rest) || serverPrefixes.some(p => rest.startsWith(p))) continue;
        }
        if (clientPrefixes.some(p => k.startsWith(p) && k.length > p.length && p !== 'srv.' && p !== 'err.')) continue;
        orphans.push(`public/js/03-i18n.js:${info.line}  '${k}'`);
    }
    return orphans;
}

if (require.main === module) {
    const orphans = check();
    if (orphans.length) {
        console.error(`❌ 字典里有 ${orphans.length} 条没有任何地方用到的翻译（删掉，或在该行注明 i18n-orphan-ok: 原因）：`);
        orphans.forEach(o => console.error('   ' + o));
        process.exit(1);
    }
    console.log('✅ 翻译条目检查通过（字典里每一条都有地方用到）');
} else {
    module.exports = { check };
}
