'use strict';

// 大厅三页信息架构（2026-09-13，第 1 步：只搬家，不动后端）。
//
// 原来整个大厅摊在一页：创建/加入/房间列表全平铺，个人向功能被压成顶栏上
// 一排猜不出含义的 emoji。现在拆成 约局 / 发现 / 我的。
//
// 这里既验行为（分页切换、房间列表按 isMember 分流、角标），
// 也守几条结构不变量——因为分页最容易出的问题不是写错样式，
// 而是「切视图时漏切了某个容器」这种看不见的错。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

// ---------- 最小 DOM 桩（jsdom 没装，沿用 hotkeys.test.js 那套做法）----------
function makeEl(id) {
    const cls = new Set();
    return {
        id,
        textContent: '', innerHTML: '', scrollTop: 0,
        style: {}, dataset: {},
        classList: {
            add: c => cls.add(c),
            remove: c => cls.delete(c),
            contains: c => cls.has(c),
            toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); return cls.has(c); },
        },
        _cls: cls,
    };
}

// 🔴 元素桩【从真实 index.html 里读】，不手写清单。
//    第一版是手写的，里面包括一个已经被我删掉的 #room-count，
//    于是 renderRoomList 里那行 getElementById('room-count').textContent 在测试里一切正常、
//    到了浏览器里直接 TypeError，「发现」页永远空白。
//    桩迸合了我的假设，而不是照着真实 DOM —— 和当初 sizeFor 那次是同一类错。
const HTML_IDS = new Set(
    [...fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(m => m[1]));

function loadLobby() {
    const els = {};
    for (const id of HTML_IDS) els[id] = makeEl(id);
    const navItems = ['play', 'discover', 'me'].map(t => { const e = makeEl('nav-' + t); e.dataset.tab = t; return e; });
    const panes = ['play', 'discover', 'me'].map(t => makeEl('pane-' + t));
    const chips = ['all', 'cash', 'sng'].map(f => { const e = makeEl('chip-' + f); e.dataset.df = f; return e; });

    const store = {};
    const ctx = {
        console,
        L: (zh) => zh,                                   // 测试里固定取中文，断言好写
        escapeHtml: s => String(s),
        onLangChange() {},                               // 真实定义在 03-i18n.js
        openProfile() {}, profileTab() {},
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
        window: {},
        myDisplayName: '张三', myUsername: 'zhangsan', myGold: 3848, myAvatar: null,
        document: {
            getElementById: id => els[id] || null,
            querySelectorAll: sel => {
                if (sel === '#lobby-nav .nav-item') return navItems;
                if (sel === '#lobby-view .lobby-pane') return panes;
                if (sel === '#disc-filters .disc-chip') return chips;
                return [];
            },
        },
    };
    ctx.window.localStorage = ctx.localStorage;
    vm.createContext(ctx);
    vm.runInContext(read('public/js/30-room.js'), ctx);
    return { ctx, els, navItems, panes, chips, store, run: expr => vm.runInContext(expr, ctx) };
}

const room = (o) => Object.assign({
    roomId: '1234', roomType: 'sng', name: '局', ownerName: '房主', maxPlayers: 6,
    playerCount: 2, status: 'waiting', levelMinutes: 5, buyIn: 110,
    sb: 10, bb: 20, ante: 0, minBuyIn: 2000, isMember: false,
}, o);

// ================= 行为 =================

test('切页：同一时刻只有一页显示、只有一个导航项高亮，并记住选择', () => {
    const t = loadLobby();
    t.run("setLobbyTab('discover')");
    assert.deepEqual(t.panes.filter(p => p._cls.has('active')).map(p => p.id), ['pane-discover']);
    assert.deepEqual(t.navItems.filter(n => n._cls.has('active')).map(n => n.dataset.tab), ['discover']);
    assert.equal(t.store.lobbyTab, 'discover');
    // 切页要回到顶部，否则从长列表切过去会停在半空
    t.els['lobby-view'].scrollTop = 500;
    t.run("setLobbyTab('me')");
    assert.equal(t.els['lobby-view'].scrollTop, 0);
});

test('非法页名回落到「约局」，不会切出一个空白界面', () => {
    const t = loadLobby();
    t.run("setLobbyTab('not-a-tab')");
    assert.deepEqual(t.panes.filter(p => p._cls.has('active')).map(p => p.id), ['pane-play']);
});

test('🔴 房间列表按 isMember 分流：我的局进「约局」，其余进「发现」', () => {
    const t = loadLobby();
    t.run(`renderRoomList([
        ${JSON.stringify(room({ roomId: 'A', name: '我的局', isMember: true }))},
        ${JSON.stringify(room({ roomId: 'B', name: '别人甲' }))},
        ${JSON.stringify(room({ roomId: 'C', name: '别人乙' }))}
    ])`);
    const mine = t.els['my-room-list'].innerHTML;
    const disc = t.els['room-list'].innerHTML;
    assert.match(mine, /我的局/);
    assert.doesNotMatch(mine, /别人甲|别人乙/, '别人的局绝不能出现在「约局」页');
    assert.match(disc, /别人甲/);
    assert.match(disc, /别人乙/);
    assert.doesNotMatch(disc, /我的局/, '我自己的局不该再出现在「发现」页（会重复显示）');
    assert.equal(t.els['my-room-count'].textContent, '(1)');
});

test('发现页角标 = 别人的局总数，且【不受当前筛选影响】', () => {
    // 角标回答的是「这里有没有人」，不是「筛完还剩几个」——
    // 筛选是一种看法，把角标跟着筛选变会让人以为房间消失了。
    const t = loadLobby();
    const rooms = `[
        ${JSON.stringify(room({ roomId: 'A', isMember: true }))},
        ${JSON.stringify(room({ roomId: 'B', roomType: 'cash', name: '现金局' }))},
        ${JSON.stringify(room({ roomId: 'C', roomType: 'sng', name: 'SNG局' }))}
    ]`;
    t.run(`renderRoomList(${rooms})`);
    assert.equal(t.els['nav-discover-badge'].textContent, 2);
    assert.equal(t.els['nav-discover-badge'].style.display, '');

    t.run("setDiscoverFilter('cash')");
    assert.match(t.els['room-list'].innerHTML, /现金局/);
    assert.doesNotMatch(t.els['room-list'].innerHTML, /SNG局/);
    assert.equal(t.els['nav-discover-badge'].textContent, 2, '筛选不该改变角标');
    assert.deepEqual(t.chips.filter(c => c._cls.has('sel')).map(c => c.dataset.df), ['cash']);
});

test('没有任何房间时，角标收起、两页各自给出【不同】的空态', () => {
    const t = loadLobby();
    t.run('renderRoomList([])');
    assert.equal(t.els['nav-discover-badge'].style.display, 'none');
    // 「约局」空是正常的（本来就只有你自己的局）→ 引导去创建 / 输码
    assert.match(t.els['my-room-list'].innerHTML, /创建一局|四位房间码/);
    // 「发现」空说明真没人 → 说清楚怎么办，别只写「暂无房间」
    assert.match(t.els['room-list'].innerHTML, /没有别人的牌局/);
});

// ================= 结构不变量 =================

test('🔴 切换大厅/牌桌必须切【外壳】，否则导航会留在牌桌上', () => {
    // 导航是 #lobby-shell 的子元素而不是 #lobby-view 的，
    // 所以 showLobby/showTable 只切 #lobby-view 的话，底部那条会一直挂在牌桌上——
    // 而牌桌的垂直空间是一寸寸抠出来的（#ring-layer 顶部内边距 118px→28px）。
    const src = read('public/js/30-room.js');
    for (const fn of ['showLobby', 'showTable']) {
        // ⚠️ 带上左括号：不然 'function showTable' 会先匹配到 showTableNotice
        const at = src.indexOf('function ' + fn + '(');
        assert.ok(at >= 0, fn + ' 不见了');
        const body = src.slice(at, src.indexOf('\n}', at));
        assert.match(body, /getElementById\('lobby-shell'\)\.style\.display/, `${fn} 必须切 #lobby-shell`);
        assert.doesNotMatch(body, /getElementById\('lobby-view'\)\.style\.display/, `${fn} 不该再直接切 #lobby-view`);
    }
    const css = read('public/css/31-lobby-nav.css');
    assert.match(css, /body\.in-room\s+#lobby-shell\s*\{[^}]*display:\s*none/, '牌桌内必须整条隐藏导航');
});

test('🔴 每个导航项都要有对应的页面，反之亦然', () => {
    const html = read('index.html');
    const tabs = [...html.matchAll(/class="nav-item[^"]*"\s+data-tab="([^"]+)"/g)].map(m => m[1]);
    const panes = [...html.matchAll(/class="lobby-pane[^"]*"\s+id="pane-([^"]+)"/g)].map(m => m[1]);
    assert.ok(tabs.length >= 3, '导航项没抓到，选择器可能失效了：' + tabs.length);
    assert.deepEqual([...tabs].sort(), [...panes].sort(), '导航项与页面对不上（点了会切出空白）');
    // 首屏必须有且只有一页是 active，否则落地是空白
    const active = [...html.matchAll(/class="lobby-pane active"/g)].length;
    assert.equal(active, 1);
});

test('🔴 个人向入口不许再回到顶栏', () => {
    // 顶栏在牌桌内整条隐藏，所以它其实只是「大厅专用条」——
    // 把个人功能塞成一排纯 emoji，既猜不出含义又挤，这正是这次要解决的问题。
    const html = read('index.html');
    const bar = html.slice(html.indexOf('<div id="user-bar">'), html.indexOf('</div>', html.indexOf('<div id="user-bar">')));
    for (const fn of ['openProfile', 'openInbox', 'openCheckin', 'doLogout', 'toggleAdminPanel']) {
        assert.doesNotMatch(bar, new RegExp(fn + '\\('), `${fn} 应该在「我的」页里，不该放回顶栏`);
    }
    // 余额要留着：它是随时要看的数字，藏进二级页面等于看不见
    assert.match(bar, /id="display-gold"/);
});

// ===== 浮层统一关闭（2026-09-13，玩家反馈「战绩关不掉」）=====
// 原来是各写各的：4 个面板写了内联 onclick 判 event.target===this，其余只能点 ✕。
// 改成一处登记 + 文档级监听。下面守住登记表和真实代码不脱节。

test('🔴 登记表里的每个面板 id 和关闭函数都必须真实存在', () => {
    // 这一条是针对本次踩的坑加的：写一个不存在的名字，浏览器里静默失效，
    // 而测试桩如果迎合了那个假设就永远发现不了（sizeFor / room-count 都是这么漏的）。
    const boot = read('public/js/99-bootstrap.js');
    const block = boot.slice(boot.indexOf('const DISMISSIBLE'), boot.indexOf('];', boot.indexOf('const DISMISSIBLE')));
    const entries = [...block.matchAll(/id:\s*'([^']+)'\s*,\s*close:\s*'([^']+)'/g)].map(m => ({ id: m[1], fn: m[2] }));
    assert.ok(entries.length >= 10, '登记表没抓到，正则可能失效了：' + entries.length);

    const html = read('index.html');
    const allJs = ['00-state', '03-i18n', '05-utils', '10-auth', '20-socket', '30-room', '40-profile',
                   '41-history', '42-replay', '50-audio-settings', '60-chat', '61-voice', '70-actions',
                   '71-hotkeys', '80-table-renderer', '90-admin', '99-bootstrap']
        .map(n => read(`public/js/${n}.js`)).join('\n');

    const badId = entries.filter(e => !html.includes(`id="${e.id}"`));
    assert.deepEqual(badId.map(e => e.id), [], 'index.html 里没有这些元素');
    // 必须是【顶层 function 声明】才会挂到 window 上（let/const 定义的不会）——
    // 而关闭是 window[p.close]() 调的。
    // ⚠️ 这里用 includes 而不是 new RegExp(`…\(`)：模板字符串里的 `\(` 会被 JS 先解析成 `(`，
    //    拼出来的正则就变成「未闭合的分组」直接抛错。能不用动态正则就别用。
    const badFn = entries.filter(e => !allJs.includes('\nfunction ' + e.fn + '('));
    assert.deepEqual(badFn.map(e => e.fn), [], '这些关闭函数不是顶层 function 声明，window[...] 取不到');
});

test('🔴 每个能打开的浮层都要登记，别漏掉（漏了就只能点 ✕）', () => {
    const boot = read('public/js/99-bootstrap.js');
    const registered = new Set([...boot.matchAll(/id:\s*'([^']+)'\s*,\s*close:\s*'/g)].map(m => m[1]));
    // 刻意不登记的：聊天抽屉是打牌时一直开着看的，点一下牌桌就收掉会很烦
    const EXEMPT = new Set(['chat-panel']);
    const html = read('index.html');
    const panels = [...html.matchAll(/id="([a-z-]+)"[^>]*class="(?:modal-mask|side-panel|c-overlay)"/g)].map(m => m[1])
        .concat([...html.matchAll(/class="(?:modal-mask|side-panel|c-overlay)"[^>]*id="([a-z-]+)"/g)].map(m => m[1]));
    const missing = [...new Set(panels)].filter(id => !registered.has(id) && !EXEMPT.has(id));
    assert.deepEqual(missing, [], '这些浮层没登记到 DISMISSIBLE 里，点空白处关不掉');
});

test('🔴 不许再走回「每个面板各写一句内联 onclick」的老路', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /onclick="if\(event\.target===this\)/,
        '关闭逻辑统一在 99-bootstrap.js 的 DISMISSIBLE 里，别再往 HTML 里写内联判断（加新面板必漏）');
});

test('🔴 打开面板的那一下点击不能把它自己关掉', () => {
    // 打开面板的 click 会冒泡到 document。必须用「按下时哪些面板开着」来判断，
    // 否则点一下菜单 → 开 → 同一个事件立刻把它关了，表现为「点了没反应」。
    const boot = read('public/js/99-bootstrap.js');
    assert.match(boot, /addEventListener\('pointerdown'/, '必须在 pointerdown 时记录开着的面板');
    // ⚠️ 从登记表往后找：文件前面还有开场画面的两个 click 监听，
    //    直接 indexOf 会切到那一段去（第一版就切错了，报的是个假失败）。
    const clickAt = boot.indexOf("addEventListener('click'", boot.indexOf('const DISMISSIBLE'));
    const body = boot.slice(clickAt, clickAt + 700);
    assert.match(body, /_openAtPress\.has/, 'click 处理里必须先看这个面板在按下时是否已经开着');
});

test('🔴 「我的」页不许被收缩包裹成窄条', () => {
    // #lobby-view 是纵向 flex 的子项 + margin:0 auto。flexbox 规则：交叉轴上只要有一侧
    // margin 是 auto，stretch 就不生效 → 退化成 shrink-to-fit（按内容最宽处算）。
    // 「约局」页有两张 min-width:200px 的大卡撑着看不出来，「我的」页只剩几行短文字，
    // 整页就缩成窄窄一条，宽度还随文案长度（语言）变化——玩家实拍报的就是这个。
    const css = read('public/css/30-lobby.css');
    const at = css.indexOf('#lobby-view {');
    assert.ok(at >= 0);
    const rule = css.slice(at, css.indexOf('}', at));
    assert.match(rule, /margin:\s*0 auto/);
    assert.match(rule, /width:\s*100%/, 'margin:0 auto 会关掉 flex stretch，必须显式给 width:100%');
});
