'use strict';
// 部署前安全检查②：交叉核对每个 socket 事件文件从 tableService / config / runtime / bind
// 解构的名字，是否真实存在于对应来源上。抓「解构了不存在的名字 → undefined → 调用时崩全服」
// 这类 eslint no-undef 抓不到的隐患（eslint 抓的是"用了没声明"，这里抓的是"声明了但来源没有"）。
// 用法：node tools/check-destructures.js  （deploy 脚本会自动跑；不过就中止部署）
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..');

// 真实实例化 tableService，拿到它真正提供的 key（工厂只做装配、不调用处理器，桩依赖即可）
const config = require(path.join(P, 'src/config'));
const { createRuntime } = require(path.join(P, 'src/runtime'));
const { createTableService } = require(path.join(P, 'src/table/table-service'));
const db = require(path.join(P, 'database'));
const stats = require(path.join(P, 'stats'));
const equity = require(path.join(P, 'equity'));
const { Deck, HandEvaluator } = require(path.join(P, 'PokerLogic'));
const crypto = require('crypto');
const chain = () => { const o = {}; ['emit', 'to', 'in', 'on', 'use', 'join', 'leave'].forEach(m => o[m] = () => chain()); return o; };
const io = Object.assign(chain(), { sockets: { sockets: new Map(), adapter: { rooms: new Map() } } });
const runtime = createRuntime();
const ts = createTableService({ io, db, stats, equity, Deck, HandEvaluator, crypto, config, runtime });

const tsKeys = new Set(Object.keys(ts));
const cfgKeys = new Set(Object.keys(config));
const rtKeys = new Set(Object.keys(runtime));
const ctxExtra = new Set(['socket', 'user', 'io', 'db', 'stats', 'Deck', 'config', 'runtime', 'tableService', 'syncRecentVoices']);

// bind() 返回的 key（room-context.js）——bind 使用者的可用集合
const bindSrc = fs.readFileSync(path.join(P, 'src/socket/events/room-context.js'), 'utf8');
const bindRet = bindSrc.match(/return\s*\{([\s\S]*?)\};/);
const bindKeys = new Set((bindRet ? bindRet[1] : '').split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));

function destructures(code) {
    const out = [];
    const re = /const\s*\{([\s\S]*?)\}\s*=\s*([a-zA-Z_.()]+)\s*;/g;
    let m;
    while ((m = re.exec(code))) {
        if (/require|\bfunction\b/.test(m[1])) continue;   // 跳过跨块误匹配
        const names = m[1].split(',').map(s => s.trim().split(':')[0].trim().split('=')[0].trim())
            .filter(n => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
        out.push({ source: m[2].trim(), names });
    }
    return out;
}

let problems = 0;
const dir = path.join(P, 'src/socket/events');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const d of destructures(code)) {
        let avail = null;
        if (d.source === 'tableService') avail = tsKeys;
        else if (d.source === 'config') avail = cfgKeys;
        else if (d.source === 'runtime') avail = rtKeys;
        else if (d.source === 'context') avail = ctxExtra;
        else if (d.source === 'bind(context)') avail = bindKeys;
        else continue;
        const missing = d.names.filter(n => !avail.has(n));
        if (missing.length) { problems++; console.error(`  ⚠️  ${f}  从 ${d.source} 解构了不存在的: ${missing.join(', ')}`); }
    }
}
if (problems) {
    console.error(`\n❌ 解构交叉核对失败：发现 ${problems} 处"解构了不存在的名字"（会在运行到该处时崩溃）`);
    process.exit(1);
}
console.log(`✅ 解构交叉核对通过（tableService ${tsKeys.size} 个 key / bind ${bindKeys.size} 个，事件文件解构全部对得上）`);
