#!/usr/bin/env node
'use strict';
// 乱发消息测试（fuzz）—— 2026-11-14 加。
//
// 起一个【本地】服务器（临时数据库，跑完即删），摆一张真在打的牌桌，然后让三种身份
// 对每一个 socket 事件和 HTTP 接口狂发畸形数据：
//   · 局外人（test3）：不在这张桌上，拿别人的房间号、别人的 userId 乱发
//   · 观战者（test4）：在房里但没坐下
//   · 普通在座玩家（test2）：坐着，但不是房主 —— 专门试房主才能做的事
// 每一轮之后检查四件事：
//   ① 服务器还活着（/api/version 能答）
//   ② 牌桌没被卡住（没被暂停、还在出牌）、房间没被解散、房主还坐着
//   ③ 钱没变：桌上筹码总数不变；钱包账本全部首尾相接（tools/wallet-ledger.js）
//   ④ 没拿到不该拿的东西：局外人 / 观战者收不到任何底牌、房间码
//
// 用法：node tools/fuzz.js            （约 2～3 分钟）
//       node tools/fuzz.js --quick    （每个事件少发几种负载，约半分钟）
// 退出码：0 = 全部通过；1 = 发现问题（会逐条列出）

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioc } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const QUICK = process.argv.includes('--quick');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const problems = [];
const bad = (msg) => { problems.push(msg); console.log('   ❌ ' + msg); };

// ── 所有 socket 事件名：直接从源码里扫，加了新事件自动纳入 ──
function socketEvents() {
    const names = new Set();
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/socket\.on\('([a-z_]+)'/g)) names.add(m[1]);
    });
    walk(path.join(ROOT, 'src'));
    names.delete('disconnect');
    return [...names].sort();
}

function payloads(ctx) {
    const big = 'x'.repeat(20000);
    const all = [
        undefined, null, 0, -1, 1e15, 'abc', '', big, [], {}, true,
        { roomId: ctx.roomId }, { roomId: '000000' }, { roomId: { $gt: '' } },
        { targetUserId: ctx.ownerId }, { targetUserId: ['x'] }, { userId: ctx.ownerId },
        { seat: '0' }, { seat: -1 }, { seat: 99 }, { seat: 1.5 },
        { buyInChips: -5000 }, { buyInChips: 1e12 }, { amount: -100 }, { amount: 1e12 },
        { action: 'raise', amount: -1, roomId: ctx.roomId }, { action: 'fold', roomId: ctx.roomId }, { action: 'allin', roomId: ctx.roomId },
        { n: 99 }, { n: -3 }, { agree: true }, { minutes: -600 }, { minutes: 1e9 }, { endAt: 0 }, { endAt: 'soon' },
        { code: '0000' }, { code: ctx.joinCode }, { token: 'x' }, { enabled: 'yes' }, { locked: 1 },
        { avatar: 'x" onerror="alert(1)' }, { text: '<img src=x onerror=1>' }, { emote: '<b>x</b>' },
        { name: '<script>' }, { displayName: '"><svg onload=1>' }, { note: big }, { query: '%' },
        JSON.parse('{"__proto__":{"isAdmin":true,"paused":true}}'), { constructor: { prototype: { polluted: 1 } } },
        { idx: 0 }, { idx: -1 }, { idx: 99 }, { accept: true }, { cfg: {} },
        // 「毒对象」：自带 toString / valueOf 的对象 —— String(x)、x + ''、拿来当属性名都会直接抛错
        { text: { toString: 1 } }, { code: { toString: 1 } }, { roomId: { toString: 1 } }, { note: { valueOf: 1 } },
        { toString: 1 }, { emote: { toString: 1 } }, { targetUserId: 'x'.repeat(30000) }, { userId: { toString: 1 } },
    ];
    return QUICK ? all.filter((p, i) => i % 4 === 0 || JSON.stringify(p || {}).includes('toString') || JSON.stringify(p || {}).includes('valueOf')) : all;
}

// ── 小工具 ──
async function http(method, url, token, body) {
    const res = await fetch(BASE + url, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    }).catch(e => ({ status: 0, error: e }));
    let json = null; try { json = await res.json(); } catch { /* 不是 JSON */ }
    return { status: res.status, json };
}
async function login(u) {
    const r = await http('POST', '/api/login', null, { username: u, password: u });
    if (!r.json || !r.json.token) throw new Error('登录失败 ' + u + ' ' + JSON.stringify(r.json));
    return { token: r.json.token, id: r.json.user.id, name: u };
}
function connect(acc) {
    return new Promise((resolve, reject) => {
        const s = ioc(BASE, { auth: { token: acc.token }, transports: ['websocket'], reconnection: false });
        s.seen = { hole_cards: 0, my_hand: 0, room_invite_info: 0, holeInState: 0 };
        s.acc = acc;
        s.on('disconnect', (reason) => { s.dropReason = reason; });
        s.last = {};
        s.onAny((ev, data) => {
            s.last[ev] = data;
            if (ev === 'room_invite_info') { (s.codes = s.codes || []).push(data && data.joinCode); return; }   // 只算【这张桌】的码，见 check
            if (ev in s.seen) s.seen[ev]++;
            if (ev === 'game_state' && /"hole"\s*:|"holeCards"\s*:/.test(JSON.stringify(data))) s.seen.holeInState++;
        });
        s.on('connect', () => resolve(s));
        s.on('connect_error', reject);
    });
}
const once = (s, ev, ms = 4000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('等不到 ' + ev)), ms);
    s.once(ev, d => { clearTimeout(t); res(d); });
});

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-fuzz-'));
    const dbPath = path.join(dir, 'fuzz.sqlite');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, env: { ...process.env, LOCAL_DEV: '1', PORT: String(PORT), POKER_DB_PATH: dbPath, NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', d => { serverLog += d; });
    server.stderr.on('data', d => { serverLog += d; });
    let exited = false;
    const ctx = {};
    server.on('exit', () => { exited = true; });
    const cleanup = () => { try { server.kill(); } catch { } setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); };

    try {
        for (let i = 0; i < 50 && !(await http('GET', '/api/version')).json; i++) await sleep(200);
        console.log(`🧪 本地服务器 ${BASE}（临时库 ${dbPath}）`);

        // ── 摆一张真在打的牌桌 ──
        const [owner, seated, outsider, watcher] = await Promise.all(['test', 'test2', 'test3', 'test4'].map(login));
        const so = await connect(owner), ss = await connect(seated);
        so.emit('create_cash_room', { name: 'fuzz', bb: 40, sb: 20, minBuyIn: 2000, maxPlayers: 6, durationH: 2 });
        const invite = await once(so, 'room_invite_info');
        await sleep(300);
        const roomId = so.last.room_joined?.roomId || (await once(so, 'game_state')).roomId;
        so.emit('sit_down', { buyInChips: 2000, seat: 0 });
        ss.emit('join_by_code', { code: invite.joinCode }); await sleep(400);
        ss.emit('sit_down', { buyInChips: 2000, seat: 1 }); await sleep(400);
        so.emit('start_game'); await sleep(3500);
        const st0 = so.last.game_state;
        if (!st0 || st0.phase === 'waiting') throw new Error('牌局没开起来：' + JSON.stringify(st0 && st0.phase));
        let hands = 0; so.on('hole_cards', () => { hands++; });
        const chips0 = st0.players.reduce((a, p) => a + p.chips + p.currentBet, 0) + st0.pot;
        console.log(`🃏 房间 ${roomId}：两人在打，桌上筹码 ${chips0}`);

        // 让两位真玩家一直自动行动，牌局持续推进
        const autoplay = (s, acc) => s.on('game_state', st => {
            if (!st || st.actionOnUserId !== acc.id) return;
            const me = st.players.find(p => p.userId === acc.id);
            const toCall = st.currentBet - (me ? me.currentBet : 0);
            setTimeout(() => s.emit('player_action', { roomId, action: toCall > 0 ? 'call' : 'check' }), 150);
        });
        autoplay(so, owner); autoplay(ss, seated);

        let sx = await connect(outsider);
        let sw = await connect(watcher);
        sw.emit('join_room', { roomId }); await sleep(500);
        // 被服务器断开（限流 / 鉴权）就重连，计数延续，后面的事件照样要测
        const revive = async (s, rejoin) => {
            if (s.connected) return s;
            const n = await connect(s.acc);
            n.seen = s.seen;
            if (rejoin) { n.emit('join_room', { roomId }); await sleep(400); }
            return n;
        };

        Object.assign(ctx, { roomId, ownerId: owner.id, joinCode: invite.joinCode });
        const events = socketEvents();
        const P = payloads(ctx);
        console.log(`🔫 ${events.length} 个 socket 事件 × ${P.length} 种负载 × 3 个身份`);

        const handBefore = hands;
        const check = async (label) => {
            if (exited) { bad(`${label}：服务器进程退出了`); throw new Error('server died'); }
            const v = await http('GET', '/api/version');
            if (!v.json) bad(`${label}：/api/version 不应答`);
            const st = so.last.game_state;
            if (!st) bad(`${label}：房主收不到牌桌状态（房间被解散？）`);
            else {
                if (st.paused) bad(`${label}：牌桌被暂停了`);
                if (!st.players.some(p => p.userId === owner.id && !p.standing)) bad(`${label}：房主被移出了座位`);
                // 不变量：桌上所有筹码（座位上的 + 本街下注 + 待生效补码 + 底池 + 站起者）− 累计带入 = 0。
                // 补码是花金币买的，带入和筹码同时涨，不算「凭空」；凭空多出 / 消失的筹码会让它偏离 0。
                const vacNet = (st.vacated || []).reduce((a, v) => a + (v.net || 0), 0);
                const drift = st.players.reduce((a, p) => a + (p.chips || 0) + (p.currentBet || 0) + (p.pendingRebuy || 0) - (p.buyIn || 0), 0)
                    + (st.pot || 0) + vacNet;
                if (drift !== 0) bad(`${label}：桌上筹码与带入对不上，偏差 ${drift}`);
            }
            for (const [who, s] of [['局外人', sx], ['观战者', sw]]) {
                if (s.seen.hole_cards || s.seen.my_hand || s.seen.holeInState) bad(`${label}：${who}收到了底牌（hole_cards ${s.seen.hole_cards} / my_hand ${s.seen.my_hand} / 状态里 ${s.seen.holeInState}）`);
                if ((s.codes || []).includes(ctx.joinCode)) bad(`${label}：${who}拿到了这张桌的房间码`);
            }
            if ((ss.codes || []).includes(ctx.joinCode)) bad(`${label}：非房主的在座玩家拿到了这张桌的房间码`);
        };

        let actors = [['局外人', sx], ['观战者', sw], ['在座非房主', ss]];
        const drops = {};
        const SKIP = new Set(['leave_room', 'create_room', 'create_cash_room', 'enter_lobby']);   // 这几个会让身份离开牌桌，最后单独发
        for (const ev of events) {
            if (SKIP.has(ev)) continue;
            for (const p of P) {
                for (const [, s] of actors) {
                    if (!s.connected) continue;
                    s.emit(ev, p);
                }
                await sleep(80);   // 每条连接都有事件令牌桶（突发 40、每秒回 15），发太快会被服务器断开 —— 那是护栏在工作，不是被测对象
            }
            // 重复提交同一条（双击 / 重放）
            for (const [, s] of actors) if (s.connected) { s.emit(ev, { roomId }); s.emit(ev, { roomId }); }
            await sleep(120);
            await sleep(200);
            for (let i = 0; i < actors.length; i++) {
                const [who, s] = actors[i];
                if (s.connected) continue;
                (drops[s.dropReason || '?'] = drops[s.dropReason || '?'] || []).push(`${who}@${ev}`);
                actors[i] = [who, await revive(s, who === '观战者')];
            }
            [sx, sw] = [actors[0][1], actors[1][1]];
            await check(ev);
        }

        // 断开不算问题本身（可能是限流护栏），但列出来看一眼：真被踢掉的话这里会集中出现
        if (Object.keys(drops).length) console.log('   连接被断开过：' + Object.entries(drops).map(([r, l]) => `${r} ×${l.length}（${l.slice(0, 4).join('、')}${l.length > 4 ? '…' : ''}）`).join('；'));
        // ── HTTP ──
        console.log('🌐 HTTP 接口');
        const routes = [
            ['GET', '/api/admin/users'], ['GET', '/api/admin/rooms'], ['GET', '/api/admin/metrics'], ['GET', '/api/admin/feedback'],
            ['GET', '/api/admin/client-errors'], ['GET', '/api/admin/sources'], ['GET', '/api/admin/audit'],
            ['GET', `/api/admin/wallet/test`], ['GET', `/api/admin/hands/test`],
            ['POST', '/api/admin/set-gold', { username: 'test3', gold: 999999 }],
            ['POST', '/api/admin/adjust-gold', { username: 'test3', delta: 999999, reason: 'x' }],
            ['POST', '/api/admin/broadcast', { text: 'x' }], ['POST', '/api/admin/table-notice', { text: 'x' }],
        ];
        for (const [m, url, body] of routes) {
            const r = await http(m, url, outsider.token, body);
            if (r.status !== 403 && r.status !== 401) bad(`普通用户访问 ${m} ${url} 返回 ${r.status}（应当 401/403）`);
            const anon = await http(m, url, null, body);
            if (anon.status !== 401 && anon.status !== 403) bad(`未登录访问 ${m} ${url} 返回 ${anon.status}`);
        }
        const posts = ['/api/login', '/api/register/send-code', '/api/register/verify', '/api/forgot/send-code', '/api/forgot/reset',
            '/api/bind-email/send-code', '/api/bind-email/verify', '/api/checkin', '/api/feedback', '/api/messages/read',
            '/api/account/delete', '/api/client-error', '/api/csp-report', '/api/voice'];
        const gets = ['/api/me', '/api/my-hands?mode=%27&limit=-1&offset=1e9', '/api/my-stats?mode[]=x', '/api/my-messages',
            '/api/checkin/status', '/api/voice/..%2F..%2Fsecret.key', '/api/voice/x'];
        const bodies = ['{bad json', '[]', 'null', JSON.stringify({ username: { $ne: '' }, password: [] }), JSON.stringify({ email: 'x'.repeat(5000) }), JSON.stringify(JSON.parse('{"__proto__":{"isAdmin":true}}'))];
        for (const url of posts) for (const b of bodies) {
            const r = await http('POST', url, outsider.token, b);
            if (r.status >= 500 && r.status !== 503) bad(`POST ${url} 负载 ${b.slice(0, 30)} → ${r.status}`);
        }
        for (const url of gets) {
            const r = await http('GET', url, outsider.token);
            if (r.status >= 500) bad(`GET ${url} → ${r.status}`);
            if (r.json && JSON.stringify(r.json).includes('-----BEGIN') ) bad(`GET ${url} 泄露了文件内容`);
        }
        // 普通用户能不能把自己升成管理员（原型污染）
        const me = await http('GET', '/api/me', outsider.token);
        if (me.json && me.json.isAdmin) bad('普通用户变成了管理员');

        // ── 最后：离开类事件 + 收尾检查 ──
        for (const ev of SKIP) for (const [, s] of actors) if (s.connected) s.emit(ev, {});
        await sleep(800);
        await check('收尾');
        const handAfter = hands;
        if (!(handAfter > handBefore)) bad(`牌局没有往前走（fuzz 前第 ${handBefore} 手，之后第 ${handAfter} 手）—— 可能被卡住了`);
        else console.log(`   牌局照常推进：第 ${handBefore} 手 → 第 ${handAfter} 手`);

        // 钱包账本：所有人的流水首尾相接、等于余额
        const Database = require('better-sqlite3');
        const db = new Database(dbPath, { readonly: true });
        const ledger = require('./wallet-ledger').checkWalletLedger(db);
        db.close();
        if (ledger.problems.length) ledger.problems.forEach(p => bad(`钱包账本：${p.username} ${p.detail}`));
        else console.log(`   钱包账本：${ledger.users} 个账户全部对得上`);
        const errs = serverLog.split('\n').filter(l => /TypeError|ReferenceError|RangeError|\[socket-error\]|uncaught/i.test(l));
        if (errs.length) { console.log(`   ⚠️ 服务端日志里有 ${errs.length} 行异常（不一定是问题，下面是前几行）：`); errs.slice(0, 8).forEach(l => console.log('      ' + l.slice(0, 200))); }

        [so, ss, sx, sw].forEach(s => s.close());
    } catch (e) {
        bad('脚本中断：' + e.message);
        console.log(serverLog.split('\n').slice(-20).join('\n'));
    } finally {
        cleanup();
    }
    console.log(problems.length ? `\n❌ 发现 ${problems.length} 个问题` : '\n✅ 乱发消息测试全部通过');
    process.exitCode = problems.length ? 1 : 0;
}

main();
