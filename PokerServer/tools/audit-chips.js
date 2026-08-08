#!/usr/bin/env node
'use strict';
/**
 * 筹码守恒审计（经济安全网）
 *
 * 原理：扑克是零和的——一手牌里筹码只在玩家之间流动，总量不可能改变。所以必须满足
 *       单手内  Σ(结束筹码) == Σ(开始筹码)
 * 一旦不等，就说明这一手有钱「凭空出现 / 凭空消失」，不管起因是什么（边池、退还、
 * 多次发牌、离场处理、或将来某个新功能引入的洞）都会被这张网捞出来。
 * 好处是**不需要预先知道 bug 长什么样**。
 *
 * 唯一的合法例外是「手中补码」（rebuy）：玩家在这一手进行中补充筹码，chips 与带入同步增加，
 * 账其实是平的，只是牌谱里 startChips 快照早于补码。脚本会把它识别出来单独归类（不告警）。
 *
 * 用法：
 *   node tools/audit-chips.js                    审计全部牌谱
 *   node tools/audit-chips.js --room 130674      只审某房间
 *   node tools/audit-chips.js --yesterday        只审昨天（cron 每日巡检用）
 *   node tools/audit-chips.js --days 7           最近 7 天
 *   node tools/audit-chips.js --room 130674 --settle   额外打印该房间最终结算表（含修正）
 *   node tools/audit-chips.js --yesterday --mail       发现异常时发邮件告警
 *   node tools/audit-chips.js --json             机器可读输出
 *
 * 退出码：0 = 干净；1 = 发现可疑异常（cron 可据此告警）；2 = 运行错误
 */
const fs = require('fs');
const path = require('path');

const HANDS = path.join(__dirname, '..', 'hands.jsonl');
// SQLite 上线后牌谱写入数据库、hands.jsonl 不再更新——审计必须跟着换数据源，
// 否则会一直读那个冻结的旧文件、永远报「干净」（比没有告警更危险：给出虚假的安心）。
function defaultDbPath() {
    return process.env.POKER_DB_PATH || path.join(__dirname, '..', '.local', 'pokerdojo.sqlite');
}
// 补码识别容差：未被跟注的退还会让「按动作推算的应得」与实际差一点点（通常几十~几百）
const REBUY_TOLERANCE = 1000;

function parseArgs(argv) {
    const a = { room: null, days: null, yesterday: false, settle: false, mail: false, json: false, file: null, db: null };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--room') a.room = String(argv[++i]);
        else if (k === '--days') a.days = parseInt(argv[++i], 10);
        else if (k === '--yesterday') a.yesterday = true;
        else if (k === '--settle') a.settle = true;
        else if (k === '--mail') a.mail = true;
        else if (k === '--json') a.json = true;
        else if (k === '--file') a.file = argv[++i];     // 强制读旧 JSONL
        else if (k === '--db') a.db = argv[++i];         // 强制读指定 SQLite
    }
    return a;
}

// 时间窗口（--yesterday / --days N）
function timeRange(opt) {
    if (opt.yesterday) {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        return { lo: d.getTime() - 86400000, hi: d.getTime() };
    }
    if (opt.days > 0) return { lo: Date.now() - opt.days * 86400000, hi: Infinity };
    return { lo: -Infinity, hi: Infinity };
}

// 数据源选择：显式 --file / --db 优先；否则 SQLite 存在就用 SQLite，退回 hands.jsonl。
function resolveSource(opt) {
    if (opt.file) return { kind: 'jsonl', pathname: opt.file };
    if (opt.db) return { kind: 'sqlite', pathname: opt.db };
    const dbPath = defaultDbPath();
    if (fs.existsSync(dbPath)) return { kind: 'sqlite', pathname: dbPath };
    if (fs.existsSync(HANDS)) return { kind: 'jsonl', pathname: HANDS };
    return { kind: 'none', pathname: dbPath };
}

// SQLite 里 hands.payload_json 存的就是原始牌谱记录原文，
// 取出来即可复用全部既有审计逻辑（无需改判定代码）。
function loadFromSqlite(pathname, opt, range) {
    let Database;
    try { Database = require('better-sqlite3'); }
    catch (e) { console.error('缺少 better-sqlite3，无法读取 SQLite 牌谱：', e.message); process.exit(2); }
    const db = new Database(pathname, { readonly: true, fileMustExist: true });
    try {
        const where = [], params = [];
        if (range.lo > -Infinity) { where.push('started_at_ms >= ?'); params.push(range.lo); }
        if (range.hi < Infinity) { where.push('started_at_ms < ?'); params.push(range.hi); }
        if (opt.room) { where.push('room_code = ?'); params.push(String(opt.room)); }
        const sql = 'SELECT payload_json FROM hands'
            + (where.length ? ' WHERE ' + where.join(' AND ') : '')
            + ' ORDER BY started_at_ms ASC';
        const out = [];
        for (const row of db.prepare(sql).all(...params)) {
            try { out.push(JSON.parse(row.payload_json)); } catch (e) { /* 跳过坏行 */ }
        }
        return out;
    } finally { db.close(); }
}

function loadFromJsonl(pathname, opt, range) {
    const out = [];
    for (const line of fs.readFileSync(pathname, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let h; try { h = JSON.parse(line); } catch (e) { continue; }
        const room = String(h.roomId || h.room || '');
        if (opt.room && room !== opt.room) continue;
        if (h.ts < range.lo || h.ts >= range.hi) continue;
        out.push(h);
    }
    return out;
}

function loadHands(opt) {
    const src = resolveSource(opt);
    if (src.kind === 'none') { console.error(`找不到牌谱数据源（SQLite 与 hands.jsonl 都不存在）：${src.pathname}`); process.exit(2); }
    if (!fs.existsSync(src.pathname)) { console.error(`找不到牌谱数据源：${src.pathname}`); process.exit(2); }
    const range = timeRange(opt);
    const out = src.kind === 'sqlite' ? loadFromSqlite(src.pathname, opt, range) : loadFromJsonl(src.pathname, opt, range);
    out.sort((x, y) => x.ts - y.ts);
    out.source = src;
    return out;
}

// 某玩家本手总投入 = 各街「该街最终下注额」之和（牌谱里 amount = 该街行动后的 currentBet）
function contributions(hand) {
    const perStreet = {}, total = {};
    for (const a of hand.actions || []) {
        const k = a.userId + '|' + (a.street || '-');
        perStreet[k] = Math.max(perStreet[k] || 0, a.amount || 0);
    }
    for (const k of Object.keys(perStreet)) {
        const u = k.slice(0, k.lastIndexOf('|'));
        total[u] = (total[u] || 0) + perStreet[k];
    }
    return total;
}

// 非法行动特征：同一玩家在【同一条街】内连续行动两次（中间没有别人行动），且第二次是弃牌。
// 正常牌局里你行动完必须等别人行动才轮得到你，所以这种连续行动=有人在非行动时机被改判弃牌。
// 全押被跟后离场被误判弃牌就是这个签名（2026-08 线上事故 room130674 seq53）。
// ⚠️ 必须限定「同一条街」：某街跟注、下一街才弃牌是完全合法的（否则会大量误报）。
function illegalActionSignature(hand, nameOf) {
    const A = hand.actions || [];
    const hits = [];
    for (let i = 1; i < A.length; i++) {
        const cur = A[i], prev = A[i - 1];
        if (cur.action !== 'fold') continue;
        if (cur.userId !== prev.userId) continue;
        if (prev.action === 'fold') continue;
        if ((cur.street || '-') !== (prev.street || '-')) continue;   // 跨街=合法
        hits.push(`${nameOf(cur.userId)} 同街 ${prev.action}(${prev.amount}) 后立刻弃牌`);
    }
    return hits;
}

function auditHand(hand) {
    const nameOf = id => (hand.seats.find(s => s.userId === id) || {}).username || String(id).slice(0, 8);
    const start = new Map(hand.seats.map(s => [s.userId, s.startChips]));
    const results = hand.results || [];
    if (!results.length) return null;

    let sumStart = 0, sumEnd = 0;
    for (const r of results) { sumStart += start.get(r.userId) || 0; sumEnd += r.endChips; }
    const delta = sumEnd - sumStart;
    const illegal = illegalActionSignature(hand, nameOf);
    if (delta === 0 && !illegal.length) return null;

    // 归因：谁的实际变化与「按动作应得」对不上
    const contrib = contributions(hand);
    const wonBy = new Map(results.map(r => [r.userId, r.won]));
    const endBy = new Map(results.map(r => [r.userId, r.endChips]));
    const suspects = [];
    for (const s of hand.seats) {
        const u = s.userId;
        const actual = (endBy.has(u) ? endBy.get(u) : s.startChips) - s.startChips;
        const expect = (wonBy.get(u) || 0) - (contrib[u] || 0);
        const diff = actual - expect;
        if (Math.abs(diff) > 1) suspects.push({ userId: u, username: nameOf(u), diff });
    }
    suspects.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // 分类：能否用「若干笔整百的正向差额」正好凑出整手差额 → 判为手中补码（合法）。
    // 一手里可能有两人同时补码（如 15,000 = 10,000 + 5,000），所以用子集和而不是只看单人；
    // 其余玩家的零星差额是「未跟注退还」造成的，不影响守恒，不参与凑数。
    // 有非法行动特征时一律告警，不走补码豁免。
    const rebuySet = illegal.length ? null : matchRebuySubset(delta, suspects);

    return {
        handSeq: hand.handSeq, ts: hand.ts, roomId: String(hand.roomId || hand.room || ''),
        delta, suspects, illegal,
        kind: rebuySet ? 'rebuy' : 'ALARM',
        rebuys: rebuySet || [],
        // 真实凭空金额：整手差额（补码时该额度是合法带入，不算凭空）
        phantom: rebuySet ? 0 : delta
    };
}

// 子集和：能否从「正向且为整百」的差额里选出若干笔，正好等于整手差额
function matchRebuySubset(delta, suspects) {
    if (delta <= 0 || delta % 100 !== 0) return null;
    const cand = suspects.filter(s => s.diff > 0 && s.diff % 100 === 0).slice(0, 14);
    if (!cand.length) return null;
    const n = cand.length;
    for (let mask = 1; mask < (1 << n); mask++) {
        let sum = 0;
        for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += cand[i].diff;
        if (sum !== delta) continue;
        const picked = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) picked.push({ userId: cand[i].userId, username: cand[i].username, amount: cand[i].diff });
        return picked;
    }
    return null;
}

// 最终结算表：带入 = 首次入座 + 手间补码 + 手中补码；净盈亏 = 最终筹码 − 带入
function settle(hands, findings) {
    const midRebuy = {};   // ts -> [{userId, amount}]（一手可能多人同时补码）
    const phantomBy = {};  // userId -> 凭空多得
    for (const f of findings) {
        if (f.kind === 'rebuy') midRebuy[f.ts] = f.rebuys;
        else if (f.phantom > 0 && f.suspects.length) {
            const t = f.suspects[0];
            phantomBy[t.userId] = (phantomBy[t.userId] || 0) + f.phantom;
        }
    }
    const P = {};
    for (const h of hands) {
        const end = new Map((h.results || []).map(r => [r.userId, r.endChips]));
        for (const s of h.seats) {
            const p = P[s.userId] || (P[s.userId] = { name: s.username, buyIn: 0, chips: null, hands: 0 });
            if (p.chips === null) p.buyIn += s.startChips;                 // 首次入座
            else if (s.startChips > p.chips) p.buyIn += s.startChips - p.chips;  // 手间补码
            p.chips = end.has(s.userId) ? end.get(s.userId) : s.startChips;
            p.hands++;
        }
        for (const mr of midRebuy[h.ts] || []) {                          // 手中补码（可能多人）
            if (P[mr.userId]) P[mr.userId].buyIn += mr.amount;
        }
    }
    return Object.entries(P).map(([userId, p]) => {
        const raw = p.chips - p.buyIn;
        const phantom = phantomBy[userId] || 0;
        return { userId, ...p, raw, phantom, fixed: raw - phantom };
    }).sort((a, b) => b.fixed - a.fixed);
}

const fmt = n => (n > 0 ? '+' : '') + n.toLocaleString();
const when = ts => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

async function main() {
    const opt = parseArgs(process.argv);
    const hands = loadHands(opt);
    const findings = [];
    for (const h of hands) { const f = auditHand(h); if (f) findings.push(f); }
    const alarms = findings.filter(f => f.kind === 'ALARM');
    const rebuys = findings.filter(f => f.kind === 'rebuy');
    const phantomTotal = alarms.reduce((s, f) => s + f.phantom, 0);

    if (opt.json) {
        console.log(JSON.stringify({ source: hands.source, scanned: hands.length, alarms, rebuys: rebuys.length, phantomTotal }, null, 2));
        process.exit(alarms.length ? 1 : 0);
    }

    const scope = opt.room ? `房间 ${opt.room}` : (opt.yesterday ? '昨天' : (opt.days ? `最近 ${opt.days} 天` : '全部'));
    const src = hands.source || {};
    console.log(`\n🔍 筹码守恒审计 · ${scope} · 共扫描 ${hands.length} 手`);
    console.log(`   数据源：${src.kind === 'sqlite' ? 'SQLite' : 'hands.jsonl'} ${src.pathname || ''}`);
    if (!hands.length) { console.log('（无牌谱数据）\n'); process.exit(0); }

    if (rebuys.length) {
        console.log(`\n✅ 合法的手中补码 ${rebuys.length} 处（chips 与带入同步增加，账是平的）：`);
        for (const f of rebuys) {
            const who = f.rebuys.map(r => `${r.username} 补码 ${r.amount.toLocaleString()}`).join('、');
            console.log(`   房间${f.roomId} seq${String(f.handSeq ?? '-').padStart(4)}  ${who}`);
        }
    }

    if (!alarms.length) {
        console.log('\n🟢 未发现异常：所有牌局筹码守恒。\n');
    } else {
        console.log(`\n🔴 发现 ${alarms.length} 处异常，凭空合计 ${fmt(phantomTotal)} 筹码：`);
        for (const f of alarms) {
            console.log(`\n   ── 房间 ${f.roomId}  seq ${f.handSeq}  ${when(f.ts)}`);
            console.log(`      整手筹码差额：${fmt(f.delta)}`);
            for (const s of f.suspects) console.log(`      归因：${s.username} ${fmt(s.diff)}`);
            for (const x of f.illegal) console.log(`      ⚠️ 非法行动特征：${x}`);
        }
        console.log('');
    }

    if (opt.settle) {
        const rows = settle(hands, findings);
        console.log(`\n💰 最终结算${opt.room ? `（房间 ${opt.room}）` : ''}`);
        console.log('玩家'.padEnd(16) + '总带入'.padStart(12) + '手数'.padStart(8) + '最终筹码'.padStart(13) + '账面盈亏'.padStart(14) + '应得盈亏'.padStart(14));
        let tb = 0, tc = 0, tr = 0, tf = 0;
        for (const r of rows) {
            tb += r.buyIn; tc += r.chips; tr += r.raw; tf += r.fixed;
            console.log(r.name.padEnd(16) + r.buyIn.toLocaleString().padStart(12) + String(r.hands).padStart(8)
                + r.chips.toLocaleString().padStart(13) + fmt(r.raw).padStart(14) + fmt(r.fixed).padStart(14)
                + (r.phantom ? `   ← 应扣回 ${r.phantom.toLocaleString()}` : ''));
        }
        console.log('-'.repeat(77));
        console.log('合计'.padEnd(16) + tb.toLocaleString().padStart(12) + ''.padStart(8)
            + tc.toLocaleString().padStart(13) + fmt(tr).padStart(14) + fmt(tf).padStart(14));
        console.log(tf === 0 ? '\n✅ 修正后合计为 0，账平了。\n' : `\n⚠️ 修正后合计 ${fmt(tf)}（非 0，可能还有未识别的异常）\n`);
    }

    if (opt.mail && alarms.length) {
        const body = `筹码守恒审计发现 ${alarms.length} 处异常（扫描范围：${scope}，共 ${hands.length} 手）\n`
            + `凭空合计：${fmt(phantomTotal)} 筹码\n\n`
            + alarms.map(f => `房间 ${f.roomId} seq ${f.handSeq} ${when(f.ts)}\n`
                + `  差额 ${fmt(f.delta)}\n`
                + f.suspects.map(s => `  归因 ${s.username} ${fmt(s.diff)}`).join('\n')
                + (f.illegal.length ? '\n  非法行动：' + f.illegal.join('；') : '')).join('\n\n')
            + `\n\n排查建议：node tools/audit-chips.js --room <房间号> --settle`;
        // 必须 await：否则 process.exit 会在邮件发出前就把进程结束掉（告警就哑了）
        try {
            const r = await require('../mailer.js').sendAlert('⚠️ 筹码守恒审计告警', body);
            console.log(r.sent ? '📧 告警邮件已发送' : '📧 未配置发信，告警已打印到日志');
        } catch (e) {
            console.error('告警邮件发送失败：', e.message);
        }
    }

    process.exit(alarms.length ? 1 : 0);
}

main().catch(e => { console.error('审计运行出错：', e); process.exit(2); });
