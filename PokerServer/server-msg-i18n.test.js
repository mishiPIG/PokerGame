'use strict';

// 服务端拒绝提示的结构化 i18n（2026-09-09）。
//
// 背景：服务端原本直接 emit 中文原文，英文用户切到 English 后界面是英文、
// 提示却是中文。改为服务端只发 { k, p }，翻译放客户端字典，各客户端按自己
// 的语言渲染。
// ⚠️ 之所以能这么改，是因为这 56 条【全部是 socket.emit 私发给单个玩家】的——
//    不存在「一条广播要同时满足两种语言」的问题。（普通动作播报确实是广播，
//    但客户端本来就只 console.log、不上桌面，不在本次范围内。）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const glob = (dir, re) => fs.readdirSync(dir).filter(f => re.test(f));

function loadI18n(lang) {
    const src = fs.readFileSync(path.join(__dirname, 'public/js/03-i18n.js'), 'utf8');
    const store = {};
    const ctx = {
        console,
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        navigator: { language: 'zh-CN' },
        document: { readyState: 'complete', documentElement: {}, addEventListener() {}, querySelectorAll: () => [] },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    vm.runInContext(`lang = '${lang}'`, ctx);
    return (expr) => vm.runInContext(expr, ctx);
}

test('结构化提示能按当前语言渲染，参数正确代入', () => {
    const zh = loadI18n('zh'), en = loadI18n('en');
    assert.equal(zh("renderServerMsg({k:'act.notYourTurn'})"), '⚠️ 不是你的回合');
    assert.equal(en("renderServerMsg({k:'act.notYourTurn'})"), '⚠️ It is not your turn');
    assert.equal(zh("renderServerMsg({k:'act.betMin',p:{min:200}})"), '⚠️ 下注最少 200');
    assert.equal(en("renderServerMsg({k:'act.betMin',p:{min:200}})"), '⚠️ Minimum bet is 200');
    // 多参数
    assert.match(zh("renderServerMsg({k:'gold.lowBuyin',p:{chips:5000,cost:550,gold:120}})"), /5000.*550.*120/);
    assert.match(en("renderServerMsg({k:'gold.lowBuyin',p:{chips:5000,cost:550,gold:120}})"), /5000.*550.*120/);
});

test('🔴 缺 key / 老格式字符串都不能显示成乱码', () => {
    const zh = loadI18n('zh');
    // 字典里没有这个 key（比如客户端缓存了旧版 JS，服务端已经发新 key）
    // → 宁可什么都不显示，也绝不能弹出 [object Object]
    assert.equal(zh("renderServerMsg({k:'not.a.real.key'})"), '');
    assert.equal(zh("renderServerMsg({})"), '');
    assert.equal(zh("renderServerMsg(null)"), '');
    // 老服务端 / 未迁移的调用点发的仍是字符串 → 原样返回
    assert.equal(zh("renderServerMsg('⚠️ 老格式')"), '⚠️ 老格式');
});

test('🔴 上不上屏幕必须由【消息形态】决定，不许再按 emoji 前缀判', () => {
    // 这条原来是「扫 src/ 里有没有 ⚠️ 开头的裸字符串」，用的正则是
    //     /emit\('server_msg',\s*['"`]⚠/
    // —— 和 check-i18n 里那条一模一样，也就继承了同一个盲区：它按【单行】匹配，
    // 而补码失败那两条是跨行三元，于是【两道网都没拦住】，英文界面上一直显示中文。
    //
    // 按前缀判这条路已经栽了两次（先是只认 ⚠️ 漏掉 ✅，后来字符类拆代理对
    // 把没翻译的广播全漏上屏幕）。所以现在守的是【契约】而不是字面量：
    //   结构化 { k, p } = 服务端明确要给玩家看 → 弹，且必然有中英两份文案
    //   裸字符串       = 只进 console → 在结构上就【不可能】漏到屏幕上
    // 逐条字面量的扫描交给 tools/check-i18n.js（它按整个 emit 调用取参数）。
    const socketSrc = fs.readFileSync(path.join(__dirname, 'public/js/20-socket.js'), 'utf8');
    const handler = socketSrc.slice(socketSrc.indexOf("socket.on('server_msg'"));
    const decide = handler.slice(0, handler.indexOf('});'));

    assert.match(decide, /typeof msg === 'object'/,
        'server_msg 的可见性必须按「是不是结构化」判');
    assert.doesNotMatch(decide, /startsWith\(|\.test\(text\)/,
        '不许再按 emoji 前缀 / 正则判可见性——那样写漏过两次');
});

test('🔴 服务端用到的每个 key 都必须在中英字典里都有', () => {
    // 漏一条的后果是「玩家点了没反应」——比显示中文更糟，因为完全没有反馈。
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
    const used = new Set();
    for (const f of walk(path.join(__dirname, 'src'))) {
        const t = fs.readFileSync(f, 'utf8');
        for (const m of t.matchAll(/emit\(\s*'server_msg'\s*,\s*\{\s*k:\s*'([^']+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 50, '只扫到 ' + used.size + ' 个 key，抓取逻辑可能失效了');
    const zh = loadI18n('zh');
    // ⚠️ 必须查字典成员，不能用 `t(key, null) == null` 判缺失——t() 找不到时返回 key 本身，
    //    那样写这条断言永远为真、一个缺失都抓不到（第一版就是这么写的）。
    const missZh = [...used].filter(k => !zh(`('srv.${k}' in I18N.zh)`));
    const missEn = [...used].filter(k => !zh(`('srv.${k}' in I18N.en)`));
    assert.deepEqual(missZh, [], '中文字典缺这些 key');
    assert.deepEqual(missEn, [], '英文字典缺这些 key');
});

test('🔴 字典里的每个 {占位符}，服务端都必须真的发出来', () => {
    // 2026-09-14 加。上一批把 19 条广播改成 { k, p } 时，服务端写 `p: { min: m }`、
    // 字典写 `{minutes}` 这种事一犯就是【静默】的：renderServerMsg 找不到参数就代入
    // 空串，玩家看到的是「⏱ 房主加时  分钟」—— 不报错、不乱码，只是少一截。
    // 反过来（服务端多发了没用上的参数）无害，所以只单向检查。
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

    // 取 `p: { ... }` 的顶层键名（支持简写 `{ chips, cost: f(x) }` 和嵌套调用）
    const paramNames = (src, from) => {
        const open = src.indexOf('{', from);
        if (open < 0) return [];
        let depth = 0, end = -1;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) return [];
        const body = src.slice(open + 1, end);
        const names = [];
        let d = 0, token = '';
        for (const c of body) {
            if ('{(['.includes(c)) d++;
            else if ('})]'.includes(c)) d--;
            if (d === 0 && (c === ',' || c === ':')) {
                const t = token.trim();
                if (/^[A-Za-z_$][\w$]*$/.test(t)) names.push(t);
                if (c === ':') { token = ''; d = -1; }   // 跳到这个值的末尾
                else token = '';
                continue;
            }
            if (d === -1) { if (c === ',') { d = 0; token = ''; } continue; }
            token += c;
        }
        const last = token.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(last)) names.push(last);
        return names;
    };

    const sent = new Map();   // key -> Set(参数名)
    for (const f of walk(path.join(__dirname, 'src'))) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/emit\(\s*'server_msg'\s*,\s*\{\s*k:\s*'([^']+)'\s*(,\s*p:\s*)?/g)) {
            const key = m[1];
            if (!sent.has(key)) sent.set(key, new Set());
            if (m[2]) for (const n of paramNames(src, m.index + m[0].length)) sent.get(key).add(n);
        }
    }
    assert.ok(sent.size >= 50, '只扫到 ' + sent.size + ' 个 key，抓取逻辑可能失效了');

    const zh = loadI18n('zh');
    const holes = [];
    for (const [key, params] of sent) {
        for (const dict of ['zh', 'en']) {
            const tpl = zh(`I18N.${dict}['srv.${key}'] || ''`);
            // {name} 和 {name|filter} 都要算
            for (const ph of tpl.matchAll(/\{(\w+)(?:\|\w+)?\}/g)) {
                if (!params.has(ph[1])) holes.push(`${dict} srv.${key} 用了 {${ph[1]}}，但服务端没发这个参数`);
            }
        }
    }
    assert.deepEqual(holes, [], '这些文案会渲染出一个空洞（没有任何报错）');
});

// ===== 切语言后的重渲染登记（2026-09-10）=====
// 玩家实拍：界面切成 English 后，设置里键盘快捷键那六行仍是中文。
// 那六行本来就写了 L(d.zh, d.en) —— 问题是【没人在切完语言后重画它】。
// 根因是 setLang 里维护着一张手写的重渲染清单，新面板永远会被漏掉。
// 现在改成各模块自己 onLangChange() 登记，下面两条守住这个机制。

test('setLang 会跑完所有登记的重渲染，且其中一个抛错不连累其余', () => {
    const src = fs.readFileSync(path.join(__dirname, 'public/js/03-i18n.js'), 'utf8');
    const store = {};
    const ctx = {
        console: { warn() {}, log() {} },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        navigator: { language: 'zh-CN' },
        document: { readyState: 'complete', documentElement: {}, addEventListener() {}, querySelectorAll: () => [] },
        hits: [],
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    vm.runInContext(`
        onLangChange(() => hits.push('a'));
        onLangChange(() => { throw new Error('这个面板画挂了'); });
        onLangChange(() => hits.push('c'));
        setLang('en');
    `, ctx);
    assert.deepEqual([...ctx.hits], ['a', 'c'], '抛错的那个之后的登记项必须照样执行');
    assert.equal(vm.runInContext('lang', ctx), 'en');
});

test('🔴 自己拼 HTML 的面板都必须登记 onLangChange', () => {
    // 只翻译不重渲染 = 玩家切了语言看不到变化。这几个文件都是 JS 拼 HTML 的大户，
    // 新增同类面板时把文件加进来（并在那个文件里 onLangChange 登记）。
    const OWNERS = [
        ['80-table-renderer.js', '牌桌（过牌/跟注按钮、状态气泡都是每帧写的）'],
        ['30-room.js', '大厅房间列表卡片'],
        ['50-audio-settings.js', '设置面板动态区'],
        ['60-chat.js', '快捷聊天梗（中英两套）'],
        ['71-hotkeys.js', '键盘快捷键绑定列表 —— 就是当初漏掉的那个'],
    ];
    const missing = OWNERS.filter(([f]) =>
        !/onLangChange\s*\(/.test(fs.readFileSync(path.join(__dirname, 'public/js', f), 'utf8')));
    assert.deepEqual(missing.map(m => m[0]), [],
        '这些文件自己拼 HTML 却没登记重渲染，切语言后它们会停在旧语言：\n  '
        + missing.map(([f, why]) => `${f}（${why}）`).join('\n  '));
});

test('🔴 setLang 里不许再手写重渲染清单', () => {
    // 手写清单正是漏掉快捷键面板的原因：加面板的人不会想到回来改这里。
    const src = fs.readFileSync(path.join(__dirname, 'public/js/03-i18n.js'), 'utf8');
    const body = src.slice(src.indexOf('function setLang'), src.indexOf('\n}', src.indexOf('function setLang')));
    assert.match(body, /LANG_RERENDER\.forEach/, 'setLang 必须遍历登记表');
    for (const fn of ['renderRoomList', 'buildSettingsPanel', 'buildChatBars', 'renderHotkeySettings']) {
        assert.doesNotMatch(body, new RegExp('\b' + fn + '\b'),
            `setLang 里不该直接点名 ${fn}()——该由 ${fn} 所在的文件自己 onLangChange 登记`);
    }
});
