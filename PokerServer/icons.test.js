'use strict';
// 统一图标（2026-11-17，玩家视角复盘 P2）。
// 牌面、筹码、桌布、头像都是自己画的，按钮却全是系统 emoji —— 每台手机长得不一样，也和道场风格不搭。
// 现在按钮 / 导航 / 菜单一律用 index.html 开头的图标集（#ic-sprite）。这里守三件事：
//   ① 按钮上不许再出现 emoji（包括按钮里 data-i18n 指向的字典文案）
//   ② 引用到的每个图标名，图标集里都真有（拼错了不会报错，只会显示一块空白）
//   ③ 图标集里每个图标都有人用（没人用的白占页面体积）
// 例外：管理面板（只有管理员看，和不翻译是同一个理由）。聊天表情、提示消息、奖牌这些 emoji 是【内容】，不在此列。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const JS_DIR = path.join(__dirname, 'public/js');
const JS = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).map(f => ({ f, src: fs.readFileSync(path.join(JS_DIR, f), 'utf8') }));
const EMOJI = /\p{Extended_Pictographic}/u;

const adminStart = HTML.indexOf('<div id="admin-panel"');
const adminEnd = HTML.indexOf('<!-- ===== 大厅 ===== -->');
const PLAYER_HTML = HTML.slice(0, adminStart) + HTML.slice(adminEnd);

function i18n() {
    const ctx = { document: { readyState: 'complete', querySelectorAll: () => [], documentElement: {} },
        localStorage: { getItem() {}, setItem() {} }, navigator: { language: 'zh' }, console };
    vm.createContext(ctx);
    vm.runInContext(JS.find(j => j.f === '03-i18n.js').src + '\nthis.__I = I18N;', ctx);
    return ctx.__I;
}

const SYMBOLS = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map(m => m[1]));

// 代码里所有被当作图标名用到的字符串：HTML 的 #i-xxx + 脚本里 ic(...) / setIconLabel(..., ...) 参数中的小写字面量
function usedIcons() {
    const used = new Map();   // name → 出处
    for (const m of HTML.matchAll(/href="#i-([a-z-]+)"/g)) used.set(m[1], 'index.html');
    for (const { f, src } of JS) {
        for (const m of src.matchAll(/\b(?:ic|setIconLabel)\(([^;\n]*)/g)) {
            // 只看参数里的「全小写 + 连字符」字面量；L('中文', 'English') 那类文案带大写或中文，不会被当成图标名
            for (const s of m[1].matchAll(/'([a-z][a-z-]*)'/g)) {
                if (s[1] === 'gold' || s[1].startsWith('c-')) continue;   // ic(name, 'c-gold')：第二个参数是颜色类
                // 比较对象（m.type === 'result'）和元素 id（getElementById('rp-play')）不是图标名
                const before = m[1].slice(0, s.index);
                if (/===\s*$|getElementById\($/.test(before)) continue;
                used.set(s[1], f);
            }
        }
    }
    return used;
}

test('图标集在页面里，且只有一份', () => {
    assert.equal((HTML.match(/id="ic-sprite"/g) || []).length, 1);
    assert.ok(SYMBOLS.size >= 40, `图标数 ${SYMBOLS.size}`);
});

test('🔴 玩家看得到的按钮上不许再有 emoji', () => {
    const bad = [];
    for (const m of PLAYER_HTML.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
        const text = m[1].replace(/<[^>]+>/g, '');
        if (EMOJI.test(text)) bad.push(m[0].slice(0, 100));
    }
    // 「我的」页每一行、底部导航、大厅两个入口的标题
    for (const m of PLAYER_HTML.matchAll(/class="(?:mr-ico|ni-ico|le-title)"[^>]*>([\s\S]*?)<\/(?:span|div)>/g)) {
        if (EMOJI.test(m[1].replace(/<[^>]+>/g, ''))) bad.push(m[0].slice(0, 100));
    }
    assert.deepEqual(bad, []);
});

test('🔴 按钮里 data-i18n 指向的文案也不许带 emoji（中英都查）', () => {
    const I = i18n();
    const bad = [];
    for (const m of PLAYER_HTML.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
        const keys = [...m[0].matchAll(/data-i18n="([^"]+)"/g)].map(k => k[1]);
        for (const k of keys) for (const l of ['zh', 'en']) if (EMOJI.test(I[l][k] || '')) bad.push(`${l}.${k} = ${I[l][k]}`);
    }
    assert.deepEqual(bad, []);
});

// 把 \u{1F0CF} / 🃏 这类转义还原成字符 —— 写成转义的 emoji 照样会显示出来（第一版就漏了三处）
const unescape = (s) => s
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/g, (m, a, b) => String.fromCharCode(parseInt(a, 16), parseInt(b, 16)));

test('🔴 脚本里生成的按钮、图标位、金币位也不许带 emoji（含 \\u 转义写法）', () => {
    const bad = [];
    for (const { f, src } of JS) {
        if (f === '90-admin.js' || f === '03-i18n.js') continue;
        src.split('\n').forEach((line, i) => {
            if (/^\s*\/\//.test(line)) return;   // 注释里讲历史的那几行不算
            if (/<button\b|class="[\w-]*-(?:ico|gold)\b/.test(line) && EMOJI.test(unescape(line))) bad.push(`${f}:${i + 1}`);
        });
    }
    assert.deepEqual(bad, []);
});

test('🔴 用到的每个图标名，图标集里都真有', () => {
    const missing = [...usedIcons()].filter(([n]) => !SYMBOLS.has(n)).map(([n, f]) => `${n}（${f}）`);
    assert.deepEqual(missing, [], '拼错的图标名不会报错，只会显示一块空白');
});

test('图标集里每个图标都有人用', () => {
    const used = usedIcons();
    const orphans = [...SYMBOLS].filter(n => !used.has(n));
    assert.deepEqual(orphans, []);
});

test('图标跟着文字走：大小用 em、颜色用 currentColor，不在按钮里各配一份', () => {
    const css = fs.readFileSync(path.join(__dirname, 'public/css/00-shell.css'), 'utf8');
    const rule = (css.match(/\.ic \{[^}]+\}/) || [''])[0];
    assert.match(rule, /width:\s*[\d.]+em/);
    assert.match(rule, /stroke:\s*currentColor/);
});

// ───────────── 上色（2026-11-17，美术第二轮 ①）─────────────
// 统一成线条图标后整站只剩灰白，按含义给图标上色。颜色只许用定义好的那一组：
// 写了一个没定义的 c-xxx / t-xxx 不会报错，只会默默变回灰白 —— 正是这一轮要解决的问题。
test('用到的图标颜色类（c-*）和「我的」页色块（t-*）都在样式里定义过', () => {
    const shell = fs.readFileSync(path.join(__dirname, 'public/css/00-shell.css'), 'utf8');
    const nav = fs.readFileSync(path.join(__dirname, 'public/css/31-lobby-nav.css'), 'utf8');
    const all = HTML + JS.map(j => j.src).join('\n');
    const usedC = new Set([...all.matchAll(/(?:class="ic |')(c-[a-z]+)\b/g)].map(m => m[1]));
    const usedT = new Set([...HTML.matchAll(/class="mr-ico (t-[a-z]+)"/g)].map(m => m[1]));
    assert.ok(usedC.size >= 6, '上色的地方不该这么少：' + [...usedC]);
    assert.ok(usedT.size >= 8, '「我的」页每行都该有色块：' + [...usedT]);
    const defined = (css, sel) => new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{').test(css);
    for (const c of usedC) assert.ok(defined(shell, '.ic.' + c), `${c} 没在 00-shell.css 里定义`);
    for (const t of usedT) assert.ok(defined(nav, '.mr-ico.' + t), `${t} 没在 31-lobby-nav.css 里定义`);
});

test('「我的」页每一行都有色块（退出登录除外）', () => {
    const rows = [...PLAYER_HTML.matchAll(/<span class="mr-ico([^"]*)">/g)].map(m => m[1]);
    const bare = rows.filter(c => !/\bt-[a-z]+/.test(c));
    assert.equal(bare.length, 1, '只有「退出登录」那一行不带色块：' + JSON.stringify(rows));
});

test('新号默认头像：随机给出的每一个路径都在头像白名单里', () => {
    const { randomAvatar, safeAvatar, AVATAR_COUNT } = require('./src/account/avatar');
    for (let i = 0; i < AVATAR_COUNT; i++) {
        const a = randomAvatar(() => i / AVATAR_COUNT);
        assert.equal(safeAvatar(a), a, a);
    }
    assert.equal(randomAvatar(() => 0.999999), '/avatars/b27.svg');
    assert.equal(randomAvatar(() => 0), '/avatars/b1.svg');
    // 两个建号接口都要带上（游客、注册）
    const routes = fs.readFileSync(path.join(__dirname, 'src/http/register-auth-routes.js'), 'utf8');
    assert.match(routes, /createGuest\(name, \{ avatar: randomAvatar\(\) \}\)/);
    assert.match(routes, /createUser\([^)]*\{ avatar: randomAvatar\(\) \}\)/);
});
