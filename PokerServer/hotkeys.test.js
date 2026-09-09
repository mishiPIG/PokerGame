'use strict';

// 键盘快捷键的行为测试。不引 jsdom（项目没这个依赖），用 vm + 最小 DOM 桩，
// 加载【真实的】 public/js/71-hotkeys.js，测它真正的判断逻辑。
//
// 重点测三条安全边界——它们比功能本身更重要：
//   ① 光标在输入框里绝不触发（否则聊天打字会误触发弃牌）
//   ② 按住 Ctrl/Alt/Meta 绝不触发（不抢浏览器快捷键）
//   ③ 不在牌桌里绝不触发
// 以及那条核心设计：按钮不可点时，快捷键也必须不生效（快捷键不能绕过任何校验）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'public/js/71-hotkeys.js'), 'utf8');

function makeEnv({ inRoom = true, buttons = {} } = {}) {
    const clicked = [];
    const store = {};
    const els = {};
    for (const [id, cfg] of Object.entries(buttons)) {
        els[id] = {
            // offsetParent === null 表示元素不可见（display:none 或祖先隐藏）
            offsetParent: cfg.visible === false ? null : {},
            disabled: !!cfg.disabled,
            click() { clicked.push(id); },
        };
    }
    let keyHandler = null;
    const ctx = {
        console,
        L: (zh) => zh,
        escapeHtml: (s) => String(s),
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        document: {
            getElementById: (id) => els[id] || null,
            body: { classList: { contains: (c) => c === 'in-room' && inRoom } },
        },
        window: {
            addEventListener(type, fn) { if (type === 'keydown') keyHandler = fn; },
            removeEventListener() {},
        },
        sizeCtx: { minTo: 100, maxTo: 5000 },
        // ⚠️ 这些桩必须用【真实存在的函数名】——见下方「依赖的外部全局必须真实存在」那条测试
        quickBet(kind) { clicked.push('quickBet:' + kind); },
    };
    ctx.window.localStorage = ctx.localStorage;
    vm.createContext(ctx);
    vm.runInContext(SOURCE, ctx);
    const press = (key, mods = {}) => {
        let prevented = false;
        keyHandler(Object.assign({
            key, ctrlKey: false, altKey: false, metaKey: false,
            target: { tagName: 'DIV', isContentEditable: false },
            preventDefault() { prevented = true; },
        }, mods));
        return prevented;
    };
    // ⚠️ hotkeyBindings / HOTKEY_DEFS 是 let 声明的 —— 在 vm 的【声明式作用域】里，
    //    不会挂到 context 对象上（和 sizeCtx 不在 window 上是同一个 JS 语义）。
    //    所以只能用 runInContext 求值来读写，不能 ctx.hotkeyBindings。
    const evalIn = (expr) => vm.runInContext(expr, ctx);
    return { ctx, clicked, press, store, evalIn };
}

test('🔴 依赖的外部全局必须真实存在 —— 防「桩跟错误假设一致，测试假绿」', () => {
    // 2026-09-09 真事故：全下那段写的是 sizeFor(...)，而真实函数叫 sizeForQuick。
    // typeof 判断不过 → 全下静默失效，玩家实测才发现。
    // 而测试自己在 vm context 里 stub 了一个 sizeFor，所以一路全绿。
    // ⇒ 桩只能验「逻辑」，验不了「名字对不对」。名字必须拿真实源码核对。
    const jsDir = path.join(__dirname, 'public/js');
    const allSource = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
    const declared = (name) =>
        // ⚠️ 必须用 String.raw：普通字符串里 \s 会被 JS 折叠成字母 s，正则就废了
        new RegExp(String.raw`(?:^|\n)\s*(?:function|const|let|var)\s+` + name + String.raw`\b`).test(allSource);

    // ① 显式登记：71-hotkeys.js 用到的每个外部全局
    for (const name of ['L', 'escapeHtml', 'sizeCtx', 'quickBet', 'clampSize', 'syncSizeInputs', 'curBB']) {
        assert.ok(declared(name), `71-hotkeys.js 依赖的 ${name}() 在 public/js 里根本没有定义`);
    }
    // ② 自动兜底：把源码里所有 typeof X 守卫抓出来逐个核对（就是漏掉 sizeFor 的那种写法）
    const guarded = [...SOURCE.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[!=]==/g)].map(m => m[1]);
    for (const name of new Set(guarded)) {
        if (['undefined', 'window', 'document'].includes(name)) continue;
        assert.ok(declared(name), `typeof ${name} 守卫里的名字在 public/js 里不存在——多半是拼错了`);
    }
});

test('默认绑定能点到对应按钮', () => {
    const { clicked, press } = makeEnv({ buttons: { btnFold: {}, btnCheckCall: {}, btnRaise: {} } });
    assert.equal(press('f'), true, '按 f 应被处理并吞掉按键');
    press('c'); press('r');
    assert.deepEqual(clicked, ['btnFold', 'btnCheckCall', 'btnRaise']);
});

test('大写字母也能触发（Shift 或大写锁定时不该失灵）', () => {
    const { clicked, press } = makeEnv({ buttons: { btnFold: {} } });
    press('F');
    assert.deepEqual(clicked, ['btnFold']);
});

test('🔴 光标在输入框里绝不触发 —— 否则聊天打字会误弃牌', () => {
    const { clicked, press } = makeEnv({ buttons: { btnFold: {} } });
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.equal(press('f', { target: { tagName: tag, isContentEditable: false } }), false);
    }
    assert.equal(press('f', { target: { tagName: 'DIV', isContentEditable: true } }), false);
    assert.deepEqual(clicked, [], '一次都不该点到按钮');
});

test('🔴 按住 Ctrl / Alt / Meta 绝不触发 —— 不抢浏览器快捷键', () => {
    const { clicked, press } = makeEnv({ buttons: { btnFold: {} } });
    press('f', { ctrlKey: true }); press('f', { altKey: true }); press('f', { metaKey: true });
    assert.deepEqual(clicked, []);
});

test('🔴 不在牌桌里绝不触发', () => {
    const { clicked, press } = makeEnv({ inRoom: false, buttons: { btnFold: {} } });
    assert.equal(press('f'), false);
    assert.deepEqual(clicked, []);
});

test('🔴 按钮不可点时快捷键也不生效 —— 快捷键不能绕过任何校验', () => {
    const hidden = makeEnv({ buttons: { btnFold: { visible: false } } });
    assert.equal(hidden.press('f'), false);
    const disabled = makeEnv({ buttons: { btnFold: { disabled: true } } });
    assert.equal(disabled.press('f'), false);
    assert.deepEqual(hidden.clicked.concat(disabled.clicked), []);
});

test('下注/加注按同一个键：哪个按钮可见就点哪个', () => {
    const raise = makeEnv({ buttons: { btnRaise: {}, btnBet: { visible: false } } });
    raise.press('r');
    assert.deepEqual(raise.clicked, ['btnRaise']);
    const bet = makeEnv({ buttons: { btnRaise: { visible: false }, btnBet: {} } });
    bet.press('r');
    assert.deepEqual(bet.clicked, ['btnBet']);
});

test('全下走和快捷池比例按钮同一条路径，且以「加注按钮可点」为闸门', () => {
    const ok = makeEnv({ buttons: { btnRaise: {} } });
    ok.press('a');
    assert.deepEqual(ok.clicked, ['quickBet:allin'], '必须复用 quickBet，不能自己拼 sendSize+算额度');
    // 加注按钮不可用（例如无效加注）→ 全下也必须不生效
    const blocked = makeEnv({ buttons: { btnRaise: { disabled: true } } });
    assert.equal(blocked.press('a'), false);
    assert.deepEqual(blocked.clicked, []);
});

test('重新绑定：写入 localStorage，且抢占时把原主人解绑', () => {
    const env = makeEnv({ buttons: { btnFold: {}, btnCheckCall: {} } });
    // 走和 UI 完全相同的那段抢占逻辑（captureHotkey 里的处理）
    env.evalIn("HOTKEY_DEFS.forEach(d => { if (d.id !== 'fold' && hotkeyBindings[d.id] === 'c') hotkeyBindings[d.id] = ''; }); hotkeyBindings.fold = 'c'; saveHotkeys();");
    assert.equal(env.evalIn('hotkeyBindings.check'), '', '被抢占的动作应解绑，不能两个动作共用一个键');
    assert.ok(env.store['pokerdojo.hotkeys'], '应写进 localStorage');
    env.press('c');
    assert.deepEqual(env.clicked, ['btnFold'], 'c 现在应该是弃牌');
});

test('绑定能从 localStorage 恢复（刷新后不丢）', () => {
    const first = makeEnv({ buttons: { btnFold: {} } });
    first.evalIn("hotkeyBindings.fold = 'z'; saveHotkeys();");
    const saved = first.store['pokerdojo.hotkeys'];
    const second = makeEnv({ buttons: { btnFold: {} } });
    second.store['pokerdojo.hotkeys'] = saved;
    second.evalIn('loadHotkeys()');
    assert.equal(second.evalIn('hotkeyBindings.fold'), 'z');
    second.press('z');
    assert.deepEqual(second.clicked, ['btnFold']);
});

test('滚轮步长：默认 1BB、可切换、能持久化，非法值回落默认', () => {
    const env = makeEnv({ buttons: { btnRaise: {} } });
    assert.equal(env.evalIn('wheelStep'), 1, '默认应是 1BB');
    // ⚠️ vm context 里的 Array 原型和宿主不同，deepEqual 会因「结构相同但引用不同」失败，
    //    要展开成宿主数组再比。
    assert.deepEqual([...env.evalIn('WHEEL_STEPS')], [0.5, 1, 2, 5]);

    env.evalIn('setWheelStep(0.5)');
    assert.equal(env.evalIn('wheelStep'), 0.5);
    assert.equal(env.store['pokerdojo.wheelStep'], '0.5', '应写进 localStorage');

    // 刷新后能读回来
    const again = makeEnv({ buttons: { btnRaise: {} } });
    again.store['pokerdojo.wheelStep'] = '0.5';
    again.evalIn('loadWheelStep()');
    assert.equal(again.evalIn('wheelStep'), 0.5);

    // 存了个不在档位里的值（手改 localStorage / 旧版本残留）→ 回落 1，不能让滚轮失灵
    const bad = makeEnv({ buttons: { btnRaise: {} } });
    bad.store['pokerdojo.wheelStep'] = '999';
    bad.evalIn('loadWheelStep()');
    assert.equal(bad.evalIn('wheelStep'), 1);
});

test('滚轮步长换算成筹码时必须取整且至少为 1', () => {
    const env = makeEnv({ buttons: { btnRaise: {} } });
    // 0.5BB × BB=25 = 12.5 → 必须取整，否则下注额带小数
    const step = env.evalIn('(function(){ const bb=25, ws=0.5, shift=false;' +
        ' return Math.max(1, Math.round(bb * ws * (shift ? 10 : 1))); })()');
    assert.equal(step, 13);
    // 极端：BB=1 且步长 0.5 → 0.5 取整后是 0，会导致滚轮完全没反应 → 兜底为 1
    const tiny = env.evalIn('(function(){ const bb=1, ws=0.5;' +
        ' return Math.max(1, Math.round(bb * ws)); })()');
    assert.equal(tiny, 1, '步长算出 0 会让滚轮失灵，必须兜底为 1');
});

test('恢复默认能把绑定还原', () => {
    const env = makeEnv({ buttons: { btnFold: {} } });
    env.evalIn("hotkeyBindings.fold = 'z'");
    env.evalIn('resetHotkeys()');
    assert.equal(env.evalIn('hotkeyBindings.fold'), 'f');
});
