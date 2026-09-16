const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_DIR = path.join(ROOT, 'public', 'js');
const CSS_DIR = path.join(ROOT, 'public', 'css');

const EXPECTED_SCRIPTS = [
    '00-state.js',
    // i18n 必须排在 05-utils 之前：后面几乎每个文件都会用到 t() / L()（2026-08-28 加）
    '03-i18n.js',
    '05-utils.js',
    '10-auth.js',
    '20-socket.js',
    '30-room.js',
    '40-profile.js',
    '41-history.js',
    '42-replay.js',
    '43-friends.js',
    '50-audio-settings.js',
    '60-chat.js',
    '61-voice.js',
    '70-actions.js',
    '71-hotkeys.js',
    '80-table-renderer.js',
    '90-admin.js',
    '99-bootstrap.js'
];

const EXPECTED_STYLES = [
    '00-shell.css',
    '10-auth-user.css',
    '20-table.css',
    '30-lobby.css',
    '31-lobby-nav.css',   // 大厅三页导航（窄屏底部 / 宽屏左侧），必须排在 30-lobby 之后——它要覆盖大厅的基底布局
    '40-settings.css',
    '41-table-menu.css',
    '42-chat-voice.css',
    '43-modals.css',
    '44-replay.css',
    '45-profile.css',
    '46-history.css',
    '47-friends.css',
    '50-effects.css'
];

function loadedAssets(pattern) {
    return [...INDEX.matchAll(pattern)].map(match => match[1]);
}

function source(file) {
    return fs.readFileSync(path.join(JS_DIR, file), 'utf8');
}

function frontendContext() {
    const context = { localStorage: { getItem() { return null; } } };
    vm.createContext(context);
    vm.runInContext(source('05-utils.js'), context);
    return context;
}

function declarationCount(symbol) {
    const pattern = new RegExp(`(?:function|const|let|var)\\s+${symbol}\\b`, 'g');
    return EXPECTED_SCRIPTS.reduce((total, file) => total + (source(file).match(pattern) || []).length, 0);
}

test('index loads componentized scripts and styles in dependency order', () => {
    assert.deepEqual(loadedAssets(/<script src="\/js\/([^"]+)"><\/script>/g), EXPECTED_SCRIPTS);
    assert.deepEqual(loadedAssets(/<link rel="stylesheet" href="\/css\/([^"]+)">/g), EXPECTED_STYLES);
    for (const file of EXPECTED_SCRIPTS) assert.equal(fs.existsSync(path.join(JS_DIR, file)), true, file);
    for (const file of EXPECTED_STYLES) assert.equal(fs.existsSync(path.join(CSS_DIR, file)), true, file);
});

test('index contains no large inline style or application script', () => {
    // 唯一允许的内联样式 = 开场画面(#boot-splash)的首屏关键 CSS：外链样式表到达之前
    // 就必须是深绿底，否则会先闪一层白，比没有开场更难看（见 index.html 里的注释）。
    // 所以这里不再一刀切禁止 <style>，而是守住「只此一块、且必须小」——
    // 防的是大段样式表重新爬回 index.html，不是防这块刻意为之的关键 CSS。
    const inlineStyles = [...INDEX.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    assert.equal(inlineStyles.length, 1, 'index.html 只应保留开场画面那一块内联关键 CSS');
    assert.match(inlineStyles[0], /#boot-splash/, '唯一的内联样式必须是开场画面的关键 CSS');
    assert.ok(inlineStyles[0].length < 2500, `内联关键 CSS 过大（${inlineStyles[0].length} 字符）——样式该放 public/css/`);
    // 应用脚本一律外链：内联 <script> 一个都不该有
    const inlineScripts = [...INDEX.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(inlineScripts.length, 0, '应用脚本必须放 public/js/，不要内联进 index.html');
});

test('缩小牌面必须走 --card-w，或自己显式覆盖 rank/suit 字号', () => {
    // 🔴 2026-09-09 线上 bug：牌谱回放把牌缩到 24-26px 时只写了 width/height，
    //    但 rank/suit 字号是 calc(var(--card-w) * 0.62 / 0.6) 算出来的，
    //    --card-w 仍停留在 :root 的值 ——【电脑宽屏会顶到上限 40px】，
    //    于是 26px 的牌上顶着 24.8px 的数字，直接撑爆牌面。
    //    手机上 --card-w 本来就小，所以这个 bug 只在电脑端暴露、肉眼也难发现。
    // 合法写法只有两种：① 在容器上设 --card-w/--card-h（推荐，见 .hd-hole / .hi-cards）
    //                   ② 直接写 width，但【同时】显式覆盖 .rank / .suit 字号（见 .cs-preview）
    const files = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(path.join(CSS_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const selector = m[1].trim().split('\n').pop().trim();
            if (!/\.card\b/.test(selector)) continue;
            if (!/\bwidth:\s*\d+px/.test(m[2])) continue;
            const prefix = selector.split('.card')[0].trim();
            // 合法情形 ①：容器自己设了 --card-w（字号就会跟着对）
            const varAt = prefix ? text.indexOf(prefix + ' {') : -1;
            const containerSetsVar = varAt >= 0 && /--card-w/.test(text.slice(varAt, varAt + 200));
            // 合法情形 ②：显式覆盖了 rank 字号
            const marker = prefix ? prefix + ' .card .rank' : '.card .rank';
            const at = text.indexOf(marker);
            const declaresRank = at >= 0 && /font-size/.test(text.slice(at, at + 120));
            if (!containerSetsVar && !declaresRank) offenders.push(file + '  ' + selector);
        }
    }
    assert.deepEqual(offenders, [],
        '这些规则把牌缩小了却没设 --card-w、也没覆盖 rank/suit 字号 —— 电脑端字会撑爆牌面');
});

test('设置面板：每个区块都必须归属某个分页（除了刻意常驻的操作栏）', () => {
    // 2026-09-09 分页后新增的结构约束。风险是：以后加一个 .settings-sec 却忘了放进
    // 某个 .set-pane 里 —— 它会在【所有页】都显示，或者干脆哪页都不显示，
    // 而这两种都不会报错、只能靠肉眼发现。
    // ⚠️ 唯一允许在分页外的是 .set-actions（全屏/退出房间/解散/退出登录）——
    //    那是逃生出口，刻意常驻底部，埋进分页里等于藏起来。
    const box = INDEX.slice(INDEX.indexOf('<div id="settings-overlay"'), INDEX.indexOf('<script src="/js/00-state.js"'));

    const tabs = [...box.matchAll(/class="set-tab[^"]*"[^>]*data-pane="(\w+)"/g)].map(m => m[1]);
    const panes = [...box.matchAll(/class="set-pane[^"]*"[^>]*data-pane="(\w+)"/g)].map(m => m[1]);
    assert.ok(tabs.length >= 2, '至少要有两个分页，否则分页没意义');
    assert.deepEqual(tabs, panes, 'Tab 与内容页必须一一对应且顺序一致');

    // 用真正的「祖先判断」而不是「按标记切段」——第一版就是按标记切的，
    // 结果游离区块正好夹在最后一个 pane 和 set-actions 之间，被连着挖掉了，检查形同虚设。
    // （反向对照当场发现：塞了游离区块进去测试照样全绿。）
    const orphan = [];
    const stack = [];
    for (const m of box.matchAll(/<div\b([^>]*)>|<\/div>/g)) {
        if (m[0] === '</div>') { stack.pop(); continue; }
        const attrs = m[1] || '';
        const secCls = attrs.match(/class="(settings-sec[^"]*)"/);
        if (secCls && !stack.some(Boolean)) orphan.push(secCls[1]);   // 没有任何 set-pane 祖先
        stack.push(/class="set-pane/.test(attrs));
    }
    assert.deepEqual(orphan, ['settings-sec set-actions'],
        '这些设置区块没有归属任何分页（只有 set-actions 允许在分页外）：' + orphan.join(', '));

    // 每一页都不能是空的
    for (const p of panes) {
        const seg = box.slice(box.indexOf(`data-pane="${p}">`));
        assert.match(seg.slice(0, 4000), /class="settings-sec/, `分页 ${p} 里没有任何设置区块`);
    }
});

test('state module owns data only and does not manipulate the DOM', () => {
    const state = source('00-state.js');
    assert.doesNotMatch(state, /\bdocument\b/);
    assert.doesNotMatch(state, /\bquerySelector\b|\bgetElementById\b|\bclassList\b/);
});

test('current table net keeps unsettled bets and pending rebuys in player assets', () => {
    const { displayNet } = frontendContext();
    assert.equal(displayNet({ chips: 980, currentBet: 20, committed: 0, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 700, currentBet: 0, committed: 300, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 500, pendingRebuy: 500, buyIn: 1000 }), 0);
    assert.equal(displayNet({ chips: 650, currentBet: 10, committed: 40, buyIn: 1000 }), -300);
});

test('shared utilities and reassigned controls have one owner', () => {
    for (const symbol of [
        'escapeHtml',
        'hashHue',
        'AVATARS',
        'renderRoomList',
        'toggleFullscreen',
        'toggleReady',
        'startGame',
        'addTime',
        'rabbitDeal'
    ]) {
        assert.equal(declarationCount(symbol), 1, `${symbol} must have exactly one declaration`);
    }

    assert.match(source('05-utils.js'), /function escapeHtml\b/);
    assert.match(source('30-room.js'), /function renderRoomList\b/);
    assert.match(source('50-audio-settings.js'), /function toggleFullscreen\b/);
    assert.match(source('70-actions.js'), /function toggleReady\b/);
});

test('audio unlock supports iOS gestures and foreground recovery', () => {
    const audio = source('50-audio-settings.js');
    const bootstrap = source('99-bootstrap.js');
    assert.match(audio, /function resumeAudio\b/);
    assert.match(audio, /function unlockAudio\b/);
    assert.match(bootstrap, /'pointerdown', 'touchend', 'keydown', 'click'/);
    assert.match(bootstrap, /visibilitychange/);
    assert.match(bootstrap, /if \(!document\.hidden\) resumeAudio\(\)/);
});

test('room owner invitation presents one combined, copyable message', () => {
    assert.match(INDEX, /id="invite-message"/);
    assert.match(INDEX, /onclick="copyRoomInvite\(\)"/);
    assert.doesNotMatch(INDEX, /id="invite-code"|id="invite-url"/);
    assert.match(source('30-room.js'), /function formatRoomInvite\b/);
    // ⚠️ 别断言中文字面量：i18n(2026-09-02 part3) 之后这些标签是 L('房间名','Room') 这种运行时取值，
    // 写死中文会让这条测试在翻译时假失败。改成断言【结构】——三段信息齐全、且链接排在房间码之前。
    assert.match(source('30-room.js'), /\$\{invite\.roomName\}/);
    assert.match(source('30-room.js'), /\$\{invite\.inviteUrl\}[\s\S]*\$\{invite\.joinCode\}/);
});

test('🔴 前端构建号占位符不许被提交成固定 SHA', () => {
    // 2026-09-13：deploy.sh 原来是「先把 __BUILD__ 换成真实 SHA → 再 git add . / commit」，
    // 于是打包用的临时构建号被提交进了仓库（7ddcae6）。
    // 后果不是难看：下次部署 sed 匹配不到占位符会【静默不替换】，
    // 前端构建号从此冻死在旧 SHA —— 而它唯一的用途就是「判断玩家是不是缓存了旧前端」，
    // 冻住之后所有人都被永久标成「前端是旧的」，这个判断就废了。
    const src = fs.readFileSync(path.join(__dirname, 'public/js/00-state.js'), 'utf8');
    assert.match(src, /const CLIENT_BUILD = '__BUILD__';/,
        '00-state.js 里的构建号必须保持占位符；仓库里不该出现具体 SHA（部署时才临时替换）');

    // 并确认 deploy 脚本的顺序：git 提交必须在盖构建号之前
    for (const f of ['../deploy.sh', '../deploy-test.sh']) {
        const sh = fs.readFileSync(path.join(__dirname, f), 'utf8');
        const stamp = sh.indexOf("sed -i \"s/const CLIENT_BUILD");
        if (stamp < 0) continue;                       // deploy-test.sh 不提交，无此风险
        const commit = sh.indexOf('git commit -m');
        if (commit < 0) continue;
        assert.ok(commit < stamp, `${f}: git commit 必须排在盖构建号之前，否则临时 SHA 会被提交进仓库`);
    }
});



test('🔴 弹窗必须被视口限住并且能滚，长度不受控的列表必须自己封顶', () => {
    // 玩家提的：「牌友多了会不会把这个弹窗撑坏」。会——但根子不在列表。
    // .modal-mask 是 position:fixed + align-items:center：内容一旦超过视口，
    // 弹窗【上下各溢出一截而且滚不到】，连「关闭」都点不着。
    // 这条规则底下挂着买入 / 补码 / 备注 / 确认 / 邀请【所有】弹窗，
    // 而「在线牌友」这种长度完全不受控的内容随时会把它顶破。
    const css = f => fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
    const ruleBody = (src, sel) => {
        const m = src.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
        assert.ok(m, `CSS 里找不到 ${sel} —— 这条检查会变成永远为真`);
        return m[1];
    };

    const box = ruleBody(css('43-modals.css'), '.modal-box');
    assert.match(box, /max-height:/, '.modal-box 没有高度上限，内容一多就顶出视口');
    // \b 不能用：`100dvh` 里 0 和 d 都是词字符，中间根本没有边界（第一版就这么挂的）
    assert.match(box, /\d+dvh/,
        '.modal-box 的高度上限要用 dvh —— vh 在手机上地址栏收起前后是错的');
    assert.match(box, /overflow-y:\s*auto/, '.modal-box 不能滚 = 溢出的部分永远够不着');

    // 长度不受控、由 JS 填内容的列表容器：自己也得封顶 + 可滚，
    // 不能全指望外层弹窗（那样一打开就是满屏一条列表）。
    for (const [file, sel] of [['47-friends.css', '.inv-friends']]) {
        const body = ruleBody(css(file), sel);
        assert.match(body, /max-height:/, `${sel} 没有高度上限`);
        assert.match(body, /overflow-y:\s*auto/, `${sel} 不能滚`);
    }
});


test('🔴 确认框必须盖在所有全屏浮层之上', () => {
    // 玩家实拍：点「请出房间」后，要【先把头像弹层关掉】才看得见自己刚触发的确认框——
    // 因为 #avatar-popup 是 z-index 205，而 .modal-mask 当时是 200。
    // 确认框是「你刚点的那一下」的直接回应，被任何东西盖住都等于没弹。
    // toast（9990）留在它上面是对的：那是反馈，不该被遮。
    const rules = [];
    for (const f of EXPECTED_STYLES) {
        const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
        for (const m of css.matchAll(/([#.][\w-]+)\s*\{([^}]*)\}/g)) {
            const body = m[2];
            if (!/position:\s*fixed/.test(body) || !/inset:\s*0/.test(body)) continue;   // 只看全屏浮层
            const z = /z-index:\s*(\d+)/.exec(body);
            if (z) rules.push({ sel: m[1], z: +z[1], file: f });
        }
    }
    const mask = rules.find(r => r.sel === '.modal-mask');
    assert.ok(mask, '找不到 .modal-mask 的 z-index —— 这条检查会失效');
    const over = rules.filter(r => r.sel !== '.modal-mask' && r.z >= mask.z && r.z < 9000);
    assert.deepEqual(over.map(r => `${r.file} ${r.sel}(${r.z})`), [],
        `这些全屏浮层会盖住确认框（.modal-mask 是 ${mask.z}）`);
});

test('🔴 桌内确认框：名字要填得出来，且先关弹层再弹确认', () => {
    // 两个真 bug 各一条：
    //   ① 原来读 `p.name`，而 state 下发的是 username / displayName ——
    //      恒为 undefined，确认框成了「把「」请出房间？」（实拍）。
    //      和当年 sizeFor 一样：读一个服务端根本没发的字段，静默变成空，不报错。
    //   ② 原来在 .then 里才 closeAvatarPopup()，确认框弹在弹层下面。
    const src = source('60-chat.js');
    for (const fn of ['kickPlayer', 'blockFromTable']) {
        const body = src.slice(src.indexOf(`function ${fn}(`));
        const end = body.indexOf('\n}');
        const code = body.slice(0, end);
        assert.doesNotMatch(code, /\.name\b/,
            `${fn} 读了 p.name —— state 里没有这个字段，只会渲染成空`);
        const close = code.indexOf('closeAvatarPopup');
        const confirm = code.indexOf('uiConfirm');
        assert.ok(close >= 0 && confirm >= 0, `${fn} 少了 closeAvatarPopup / uiConfirm`);
        assert.ok(close < confirm,
            `${fn} 必须【先】关头像弹层再弹确认，否则确认框被盖在下面`);
    }
    // 名字得从真实存在的字段取
    assert.match(src, /displayName \|\| .*\.username/,
        '取名字要走 displayName || username —— 这两个才是 state 真发的');
});

// ===== 下面三条都是 2026-09-14 那批验收 bug 留下的关卡 =====

test('🔴 正则字符类里不许出现 emoji（除非带 u 标志）', () => {
    // 亲身踩的：`/^[⚠✅👥]/` 看着没问题，实际 👥 是【代理对】（两个码元）。
    // 字符类在没有 u 标志时按【码元】拆，于是这条正则等价于 `[⚠✅\uD83D\uDC65]`
    // —— 变成「只要以 \uD83D 开头就匹配」，把 💺🔄🛑 一大票【只写 console、从没翻译过】
    // 的服务端广播全弹到了屏幕上（玩家实拍：英文界面冒一堆中文）。
    // 这类错没有任何外在症状，只能靠机检。
    //
    // 注：想匹配一组 emoji 就别用字符类，用 startsWith / 显式数组；
    //     真要用就加 u 标志（那时字符类按码点处理，才是对的）。
    const RE_LITERAL =
        /(^|[=(,:[!&|?{};+\-*%\n]|\breturn\b|\btypeof\b)\s*\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+)\/([a-z]*)/g;
    const RE_CLASS = /\[(?:\\.|[^\]\\])*\]/g;
    const ASTRAL = /[\uD800-\uDFFF]/;                 // 代理码元 = 这个字符类是按码元拆的
    const bad = [];
    for (const f of EXPECTED_SCRIPTS) {
        const src = source(f);
        for (const m of src.matchAll(RE_LITERAL)) {
            const [, , body, flags] = m;
            if (flags.includes('u') || flags.includes('v')) continue;
            for (const cls of body.match(RE_CLASS) || []) {
                if (ASTRAL.test(cls)) bad.push(`${f}: /${body}/${flags}`);
            }
        }
    }
    assert.deepEqual(bad, [],
        '正则字符类里有 emoji 却没带 u 标志 —— 它会被拆成代理码元，匹配到一大堆你没想匹配的东西');
});

test('🔴 剪贴板只许走 copyText()（navigator.clipboard 在 http 下根本不存在）', () => {
    // 测试服是 http://10.76.x.x:3000，不是安全上下文 → navigator.clipboard === undefined。
    // 于是 `navigator.clipboard?.writeText(x)` 静默什么都不做：没复制上、不报错、没提示，
    // 玩家点了毫无反应（牌友号、版本号两个按钮都这么坏过）。
    // copyText() 里有 execCommand 降级，而且【成败都给一句 toast】。
    const owners = EXPECTED_SCRIPTS.filter(f => source(f).includes('navigator.clipboard'));
    assert.deepEqual(owners, ['05-utils.js'],
        '除了 05-utils.js 里的 copyText()，别处不许直接碰 navigator.clipboard —— 用 copyText()');
    assert.match(source('05-utils.js'), /execCommand\('copy'\)/,
        'copyText() 必须保留非安全上下文的降级路径');
});

test('🔴 会截断的那一行里只许放一样东西', () => {
    // 玩家实拍：牌友备注写长一点，整行变成「admin1 s⋯」—— 名字和备注都看不清。
    // 原因是备注被塞进了 .fr-name 里，而 .fr-name 是 nowrap + ellipsis 的截断行：
    // 【两个长度不受控的字符串共用一条截断行，必然互相吃掉对方】。
    // 所以规则是结构性的：CSS 标成截断的类，JS 模板里不许再往里套带 class 的元素。
    const truncating = new Set();
    for (const f of EXPECTED_STYLES) {
        const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
        for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
            const body = m[2];
            if (/text-overflow:\s*ellipsis/.test(body) && /white-space:\s*nowrap/.test(body)) truncating.add(m[1]);
        }
    }
    assert.ok(truncating.size >= 5, '没扫到截断类，说明 CSS 解析写错了（这条检查会变成永远为真）');

    const bad = [];
    for (const f of EXPECTED_SCRIPTS) {
        const src = source(f);
        for (const cls of truncating) {
            for (const m of src.matchAll(new RegExp(`class="${cls}"[^>]*>`, 'g'))) {
                // 取到这个元素的第一个闭合标签为止
                const rest = src.slice(m.index + m[0].length);
                const end = rest.search(/<\/(div|span)>/);
                const inner = end < 0 ? rest.slice(0, 200) : rest.slice(0, end);
                // 两种签名都算：套了带 class 的元素，或者塞了【不止一个】插值。
                // ⚠️ 后者是重点 —— 出问题那次写的是 `${escapeHtml(f.displayName)}${note}`，
                //    class= 藏在 note 变量里，只查字面 class= 的话【一个都抓不到】。
                const slots = (inner.match(/\$\{/g) || []).length;
                if (/class="/.test(inner) || slots > 1) {
                    bad.push(`${f}: .${cls} 里放了 ${slots} 段内容 → ${inner.trim().slice(0, 60)}`);
                }
            }
        }
    }
    assert.deepEqual(bad, [],
        '截断行（nowrap + ellipsis）里只许放一段内容 —— 两段变长文本会互相截没');
});
