#!/usr/bin/env node
'use strict';
// 挂在 game/player 上的定时器字段必须全部登记在 game-serializer 的 TRANSIENT_KEYS 里。
//
// 为什么要有这个检查：Node 的 Timeout 对象内部是循环引用（_idlePrev/_idleNext 互指），
// 快照用 JSON.stringify 序列化，漏掉一个就直接抛 "Converting circular structure to JSON" ——
// 整个活跃牌局快照写不进去，重启恢复时刷一片报错。
// 新加 timeUpGraceTimer 时就中过一次（靠发版后的错误日志自查才发现）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERIALIZER = path.join(ROOT, 'src/persistence/game-serializer.js');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const serializer = fs.readFileSync(SERIALIZER, 'utf8');
const block = serializer.match(/const TRANSIENT_KEYS = new Set\(\[([\s\S]*?)\]\);/);
if (!block) {
    console.log('❌ 读不到 game-serializer 的 TRANSIENT_KEYS（实现被改了？）');
    process.exit(1);
}
const registered = new Set([...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]));

// 找所有形如 xxx.someTimer = / clearTimeout(xxx.someTimer) 的字段名
const found = new Map();   // 字段名 -> 出现位置
for (const file of walk(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
        // 只认【真的存了 Timeout】的写法：赋值 setTimeout/setInterval，或被 clearTimeout/clearInterval 清掉。
        // 不能只按名字匹配 —— 那会把 startTableTimer / restoreActionTimer 这类【函数名】也算进来。
        // 取【属性链最后一段】才是真正存 Timeout 的字段名：
        // clearTimeout(game.straddleDecision.timer) 存的是 timer，不是 straddleDecision。
        const patterns = [
            /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*?\.([A-Za-z_$][\w$]*)\s*=\s*set(?:Timeout|Interval)\s*\(/g,
            /\bclear(?:Timeout|Interval)\s*\(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*?\.([A-Za-z_$][\w$]*)\s*[),]/g
        ];
        for (const re of patterns) {
            for (const m of line.matchAll(re)) {
                const name = m[1];
                if (!found.has(name)) found.set(name, `${path.relative(ROOT, file)}:${i + 1}`);
            }
        }
    });
}

const missing = [...found.entries()].filter(([name]) => !registered.has(name));
if (missing.length) {
    console.log('❌ 有定时器字段没登记进 game-serializer 的 TRANSIENT_KEYS：');
    for (const [name, where] of missing) console.log(`   ${name}  (${where})`);
    console.log('   → Timeout 对象是循环引用，漏掉它会让整个牌局快照序列化失败、重启恢复报错。');
    process.exit(1);
}
console.log(`✅ 定时器字段检查通过（${found.size} 个字段全部已在 TRANSIENT_KEYS 中排除）`);
