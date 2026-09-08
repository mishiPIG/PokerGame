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
        sendSize(v) { clicked.push('sendSize:' + v); },
        sizeFor(kind) { return kind === 'allin' ? 5000 : 100; },
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
    assert.deepEqual(ok.clicked, ['sendSize:5000']);
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

test('恢复默认能把绑定还原', () => {
    const env = makeEnv({ buttons: { btnFold: {} } });
    env.evalIn("hotkeyBindings.fold = 'z'");
    env.evalIn('resetHotkeys()');
    assert.equal(env.evalIn('hotkeyBindings.fold'), 'f');
});
