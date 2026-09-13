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
    // 🔴 读目录，不手写清单。第一版是手写的，加了 43-friends.js 之后 closeFriends
    //    就「找不到」了 —— 和当初手写元素桩、手写重渲染清单是同一类毛病：
    //    清单不会自己跟着代码走，总有一天会报假错。
    const jsDir = path.join(__dirname, 'public/js');
    const allJs = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');

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

// ===== 入场动效（2026-09-13，玩家反馈「只有约局有动画，其他很生硬」）=====

test('🔴 入场动效必须是【三页通用】的，不能只给某一页', () => {
    // 原来只有「约局」的 .lobby-entry 自带 leIn，发现/我的硬切。
    // 同一个产品里一页有动效一页没有，比三页都没有更显廉价。
    const nav = read('public/css/31-lobby-nav.css');
    assert.match(nav, /\.lobby-pane\.active\s*>\s*\*\s*\{[^}]*animation:/,
        '入场动效要做在页容器的直接子项上，这样三页自动都有、以后加内容也不用补');
    // 旧的那套单页动效必须已经摘掉，否则「约局」会外层浮一次、内层再各浮一次
    const lobby = read('public/css/30-lobby.css');
    const entry = lobby.slice(lobby.indexOf('.lobby-entry {'), lobby.indexOf('}', lobby.indexOf('.lobby-entry {')));
    assert.doesNotMatch(entry, /animation:/, '.lobby-entry 不该再自带入场动效（已统一）');
});

test('🔴 房间卡片不许加入场动效 —— room_list 是事件驱动的，会反复闪', () => {
    // 有人进出【任何】房间都会重推 room_list → 整个列表 innerHTML 重建。
    // 卡片级动画会让列表隔三差五整体闪一下；容器级只在切页时动，不受数据推送影响。
    for (const f of ['public/css/30-lobby.css', 'public/css/31-lobby-nav.css']) {
        const css = read(f);
        for (const sel of ['.room-card', '.rc-main', '.rc-join']) {
            const at = css.indexOf(sel + ' {');
            if (at < 0) continue;
            const rule = css.slice(at, css.indexOf('}', at));
            assert.doesNotMatch(rule, /animation:/, `${f} 的 ${sel} 不该有 animation（列表会反复重渲染）`);
        }
    }
});

test('动效要尊重系统的「减少动态效果」设置', () => {
    const nav = read('public/css/31-lobby-nav.css');
    const at = nav.indexOf('prefers-reduced-motion');
    assert.ok(at >= 0, '缺少 prefers-reduced-motion 降级');
    assert.match(nav.slice(at, nav.indexOf('}', nav.indexOf('{', at))), /animation:\s*none/);
});

test('动效时长只能用 A3 定下的四档', () => {
    // A3 那轮把 33 种随手时长收敛成 0.15 / 0.3 / 0.5 / 0.8s。
    // 「说不上哪儿不对但不够精致」就是从 0.64s、0.44s 这种随手值来的。
    // ⚠️ 只看【时长】，不看 animation-delay：逐块错开的步进（0.05/0.10/…）本来就是
    //    细密的小数值，把它一起卡进四档会逼出「所有块同时浮现」这种更差的结果。
    const LADDER = new Set(['0.15', '0.3', '0.5', '0.8']);
    const nav = read('public/css/31-lobby-nav.css');
    const bad = [];
    for (const decl of nav.matchAll(/(?:animation|transition):([^;{}]*)/g)) {
        for (const d of decl[1].matchAll(/(\d*\.?\d+)s/g)) {
            if (!LADDER.has(d[1])) bad.push(d[1]);
        }
    }
    assert.deepEqual([...new Set(bad)], [], '这些时长不在四档里（0.15 / 0.3 / 0.5 / 0.8）');
});

test('🔴 版本行必须真的贴在页底（这条破过两次了）', () => {
    // 1.1.2 修过一次：房间列表为空时版本行浮在半空中，靠 .lobby-version{margin-top:auto}
    // + #lobby-view 的纵向 flex 解决。2026-09-13 我把它搬进「我的」页又破了——
    // 新父级是 display:block 的 section，auto 外边距没有可分配的剩余空间。
    // 机检这条链：margin-top:auto 还在，且它所在的页是【撑满高度的纵向 flex】。
    const set = read('public/css/40-settings.css');
    const at = set.indexOf('.lobby-version {');
    assert.ok(at >= 0, '.lobby-version 规则不见了');
    assert.match(set.slice(at, set.indexOf('}', at)), /margin-top:\s*auto/);

    const nav = read('public/css/31-lobby-nav.css');
    const pane = nav.slice(nav.indexOf('.lobby-pane.active {'),
                           nav.indexOf('}', nav.indexOf('.lobby-pane.active {')));
    assert.match(pane, /display:\s*flex/, '当前页必须是纵向 flex，否则 margin-top:auto 没有剩余空间可分配');
    assert.match(pane, /flex-direction:\s*column/);
    assert.match(pane, /flex:\s*1/, '当前页必须撑满可用高度，否则页面短时它只撑到内容高度');
    // 🔴 但【只长不缩】：上一版写的 flex:1 1 auto，手机不全屏时可用高度不够，
    //    整页连同里面的块一起被压矮，而 .me-group 带着 overflow:hidden → 直接把行裁掉
    //    （实拍：「每日签到」切一半、「资料与头像」和「管理面板」整行消失）。
    //    高度不够时正确的做法是让 #lobby-view 滚动，不是把内容振掉。
    assert.match(pane, /flex:\s*1\s+0\s/, '当前页必须只长不缩（flex: 1 0 auto）');
    assert.match(nav, /\.lobby-pane\.active\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/,
        '页内的块也不能被压缩，否则 overflow:hidden 的卡片会裁掉行');

    // 版本行必须是那一页的【最后一个】子元素，否则 auto 外边距把它顶到中间去
    const html = read('index.html');
    const me = html.slice(html.indexOf('id="pane-me"'), html.indexOf('</section>', html.indexOf('id="pane-me"')));
    const verAt = me.indexOf('id="version-box"');
    assert.ok(verAt >= 0, '版本行不在「我的」页里了');
    assert.doesNotMatch(me.slice(verAt), /<(?:button|div class="me-group")/,
        '版本行后面不该再有别的块，它必须是最后一项');
});

test('🔴 文本由 JS 写的元素不许挂 data-i18n', () => {
    // applyLang() 会 el.textContent = 字典值，把 JS 刚填的真实值覆盖回占位符。
    // 实拍：大厅底部永远显示「前端 …」。一个元素只能有一个文本所有者。
    const { execFileSync } = require('node:child_process');
    // 直接跑关卡本体，避免这里再抄一份判定逻辑（抄一份就会和它漂移）
    execFileSync(process.execPath, [path.join(__dirname, 'tools/check-i18n.js')], { stdio: 'pipe' });
});

test('🔴 侧边抽屉必须用 style.display = \'\' 打开，不能自己指定 display', () => {
    // .side-panel 没声明 display（默认 block）。写成 'flex' 就变成【横向】弹性容器，
    // 头部/标签/内容被并排挤成一条条竖字 —— 牌友面板第一版就是这么废掉的（玩家实拍）。
    const html = read('index.html');
    const panels = [...html.matchAll(/id="([a-z-]+)"[^>]*class="side-panel"/g)].map(m => m[1])
        .concat([...html.matchAll(/class="side-panel"[^>]*id="([a-z-]+)"/g)].map(m => m[1]));
    const jsDir = path.join(__dirname, 'public/js');
    const allJs = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
    // ⚠️ 不用动态正则：经 heredoc 写文件时反斜杠会被吃一层，`\(` 塌成分组，
    //    正则就再也匹配不到字面括号 —— 这条守卫第一版就是这样【永远通过】的。
    //    纯字符串扫描没有这个问题。
    const bad = [];
    for (const id of new Set(panels)) {
        const needle = `getElementById('${id}').style.display = '`;
        let i = allJs.indexOf(needle);
        while (i >= 0) {
            const rest = allJs.slice(i + needle.length);
            const value = rest.slice(0, rest.indexOf("'"));
            if (value !== '' && value !== 'none') bad.push(`#${id} → '${value}'`);
            i = allJs.indexOf(needle, i + 1);
        }
    }
    assert.deepEqual(bad, [], '侧边抽屉只能用 \'\'（打开，交给 CSS）或 \'none\'（关闭）');
});

test('🔴 服务端的成功提示也要能弹出来', () => {
    // 原来只 toast ⚠️ 开头的，于是「✅ 申请已发出」一条都看不到 ——
    // 玩家点完「加牌友」没有任何反应，只能以为功能坏了。
    const src = read('public/js/20-socket.js');
    const at = src.indexOf("socket.on('server_msg'");
    assert.ok(at >= 0);
    const body = src.slice(at, src.indexOf('});', at));
    assert.doesNotMatch(body, /startsWith\('⚠️'\)/, '不能只弹 ⚠️ 开头的');
    assert.match(body, /✅/, '成功提示（✅）也要弹');
});

// ===== 不许再用浏览器原生弹窗（2026-09-13，玩家反馈「太丑」）=====

test('🔴 不许再出现 alert / confirm / prompt', () => {
    // 原生弹窗顶着一行「10.76.x.x:3000 显示」，手机 WebView 里样式完全不受控、
    // 观感像钓鱼；而且它是【阻塞】的，弹着的时候整个页面连重绘都停了。
    // 信息类一律用 toast，需要抉择的用 uiConfirm，输入用自己的弹窗。
    const jsDir = path.join(__dirname, 'public/js');
    const bad = [];
    for (const f of fs.readdirSync(jsDir).filter(x => x.endsWith('.js'))) {
        if (f === '90-admin.js') continue;              // 管理面板不在这次范围内（用户定：不译也不改）
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        src.split('\n').forEach((ln, i) => {
            const code = ln.split('//')[0];              // 注释里提到没关系
            if (/\bwindow\.confirm\(/.test(code)) return;  // uiConfirm 的兜底分支
            if (/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(code)) bad.push(`${f}:${i + 1}`);
        });
    }
    assert.deepEqual(bad, [], '这些地方还在用浏览器原生弹窗');
});

test('🔴 uiConfirm 的返回值必须被接住', () => {
    // 它是异步的。写成 `uiConfirm(x); 干活();` 会变成【不管点什么都执行】——
    // 那比弹窗丑严重得多（点了取消照样解散房间）。
    const jsDir = path.join(__dirname, 'public/js');
    const bad = [];
    for (const f of fs.readdirSync(jsDir).filter(x => x.endsWith('.js'))) {
        if (f === '05-utils.js') continue;               // 定义处
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        let i = src.indexOf('uiConfirm(');
        while (i >= 0) {
            // 往后看一小段：必须出现 .then( 或 await
            const after = src.slice(i, i + 600);
            const before = src.slice(Math.max(0, i - 12), i);
            if (!/\.then\s*\(/.test(after) && !/await\s*$/.test(before)) {
                bad.push(`${f}@${src.slice(0, i).split('\n').length}`);
            }
            i = src.indexOf('uiConfirm(', i + 1);
        }
    }
    assert.deepEqual(bad, [], '这些 uiConfirm 没有 .then / await，点取消也会照样执行');
});
