'use strict';
// 下注信息条「占底池 %」（玩家实拍 2026-09-29：翻前 1.5BB 的池子全下 50.5BB，显示「占底池 98%」）。
// 原来分母里含了自己这注 → 永远到不了 100%。现在它必须是快捷按钮 sizeForQuick 的反函数。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'public/js/70-actions.js'), 'utf8');
function load(ctxObj) {
    const pick = (name) => {
        const i = SRC.indexOf(`function ${name}(`);
        assert.ok(i >= 0, `找不到 ${name}`);
        let depth = 0, j = SRC.indexOf('{', i);
        for (; j < SRC.length; j++) { if (SRC[j] === '{') depth++; else if (SRC[j] === '}' && --depth === 0) break; }
        return SRC.slice(i, j + 1);
    };
    const ctx = { sizeCtx: ctxObj, curBB: () => 40, Math };
    vm.createContext(ctx);
    // clampSize 夹在 [minTo, maxTo]，这里放开测纯公式
    vm.runInContext(`function clampSize(v) { return v; }\nvar sizeCtx = this.sizeCtx;\n${pick('sizeForQuick')}\n${pick('potPctOf')}`, ctx);
    return ctx;
}

test('🔴 截图里那一手：翻前全下 50.5BB 进 1.5BB 的池子，远远超池，不能显示 98%', () => {
    // SB=20 已下、BB=40；底池（含两家下注）60；我是小盲，全下到 2020
    const c = { currentBet: 40, myBet: 20, totalPot: 60, minTo: 80, maxTo: 2020 };
    const ctx = load(c);
    const pct = ctx.potPctOf(2020, c);
    assert.ok(pct > 100, `超池下注应当 > 100%，实际 ${pct}%`);
    assert.equal(pct, Math.round((2020 - 40) / 80 * 100));   // (加注到 − 当前注) ÷ 跟注后的池子
});

test('和快捷按钮互为反函数：点 ½ / ¾ / 1 / 1.5 池，下面就显示 50 / 75 / 100 / 150%', () => {
    for (const c of [
        { currentBet: 0, myBet: 0, totalPot: 400 },          // 翻后首注
        { currentBet: 200, myBet: 0, totalPot: 800 },        // 面对下注再加
        { currentBet: 300, myBet: 100, totalPot: 1000 },     // 我已下过一部分
    ]) {
        const ctx = load(c);
        for (const v of [0.5, 0.75, 1, 1.5]) {
            const amt = ctx.sizeForQuick('pot', v);
            assert.equal(ctx.potPctOf(amt, c), Math.round(v * 100), `${JSON.stringify(c)} 点 ${v} 池`);
        }
    }
});
