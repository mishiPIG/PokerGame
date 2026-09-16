#!/usr/bin/env node
'use strict';

// 存活探针（2026-09-16）。
//
// 🔴 缺口：**服务器半夜挂了，没有任何人会知道**，直到有玩家来抱怨。
//    pm2 会自动重启，但如果是起不来（端口占用 / 依赖装坏 / 磁盘满），它就一直躺着。
//    这是「坏了没人知道」里最直白的一条。
//
// 为什么探【两个】地址：
//   · 域名 `https://pokerdojo.space/...` 走的是玩家真实链路：DNS → Caddy → TLS → 应用。
//     Caddy 挂了或 Let's Encrypt 续期失败，应用再健康玩家也进不来 —— 只探应用看不出来。
//   · 直连 `http://<IP>:3000/...` 只测应用。
//   两个一起报，就能区分「应用挂了」和「应用好好的、是证书/反代/中间网络的问题」——
//   这个区分决定了你半夜爬起来先看哪儿。
//
// ⚠️ 探针跑在【另一台机器】上才有意义：进程自己探自己，它挂了就没人探了。
//    现在挂在测试服，探生产。
//
// 两条防吵设计（吵的告警等于没有告警）：
//   ① 连续失败 N 次才报，单次网络抖动不报；
//   ② 只在【状态翻转】时报：down→up 也要报，否则你只知道它挂了、不知道它回来了。
//
// 用法：node tools/check-alive.js --url <URL> [--url <URL2>] [--name 生产]
//                                [--fails 2] [--timeout-ms 10000]
//                                [--state <文件>] [--mail]
// 退出码：0 全部可达；1 有目标处于「已确认挂了」状态

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const all = (name) => args.reduce((acc, a, i) => (a === '--' + name && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

const urls = all('url');
const NAME = opt('name', '生产');
const FAILS = Number(opt('fails', 2));
const TIMEOUT = Number(opt('timeout-ms', 10000));
const STATE = opt('state', path.join(require('os').tmpdir(), 'poker-alive-state.json'));
const WANT_MAIL = args.includes('--mail');

if (!urls.length) {
    console.error('用法: node tools/check-alive.js --url <URL> [--url <URL2>] [--name 生产] [--fails 2] [--mail]');
    process.exit(2);
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
    try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch (e) { console.error('[alive] 状态文件写不了：', e.message); }
}

async function probe(url) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'pokerdojo-alive-probe' } });
        const body = await res.text();
        const ms = Date.now() - t0;
        if (!res.ok) return { ok: false, ms, detail: `HTTP ${res.status}` };
        // 200 还不够：要确认返回的确实是本服务（反代把请求打到别处也会 200）
        let label = '';
        try { label = JSON.parse(body).label || ''; } catch { /* 不是 JSON 也算异常 */ }
        if (!label) return { ok: false, ms, detail: `200 但不是本服务的响应：${body.slice(0, 80)}` };
        return { ok: true, ms, detail: label };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, detail: e.name === 'AbortError' ? `超时 >${TIMEOUT}ms` : e.message };
    } finally {
        clearTimeout(timer);
    }
}

(async () => {
    const state = readState();
    const results = [];
    for (const url of urls) results.push({ url, ...(await probe(url)) });

    const transitions = [];
    let anyDown = false;

    for (const r of results) {
        const prev = state[r.url] || { consecutiveFails: 0, down: false };
        const consecutiveFails = r.ok ? 0 : prev.consecutiveFails + 1;
        const down = r.ok ? false : (consecutiveFails >= FAILS);

        if (down) anyDown = true;
        // 只在翻转时记一笔：持续挂着不重复报，恢复了必须报
        if (down && !prev.down) transitions.push(`❌ 挂了：${r.url}\n   ${r.detail}（连续失败 ${consecutiveFails} 次）`);
        if (!down && prev.down) transitions.push(`✅ 恢复：${r.url}\n   ${r.detail}（${r.ms}ms）`);

        state[r.url] = { consecutiveFails, down, at: Date.now() };
        console.log(`${r.ok ? '✅' : '❌'} ${r.url} ${r.ms}ms ${r.detail}`
            + (r.ok ? '' : ` [连续失败 ${consecutiveFails}/${FAILS}${down ? '，已确认挂了' : '，还在观察'}]`));
    }
    writeState(state);

    if (transitions.length && WANT_MAIL) {
        const appUp = results.some(r => r.ok);
        const body = [
            `${NAME} 存活状态有变化：`, '', ...transitions, '',
            '--- 本次全部探测 ---',
            ...results.map(r => `${r.ok ? 'OK ' : '失败'} ${r.url}  ${r.ms}ms  ${r.detail}`),
            '',
            appUp
                ? '⚠️ 有地址仍然通 —— 应用大概率活着，先查 Caddy / 证书 / 中间网络，别急着重启。'
                : '所有地址都不通 —— 先 SSH 看 pm2 状态和磁盘。',
        ].join('\n');
        console.log('\n' + body);
        try {
            // ⚠️ 必须 await：process.exit() 会在异步邮件发出前结束进程（本项目踩过两次）
            await require('../mailer').sendAlert(`${NAME} 存活状态变化`, body);
            console.log('[alive] 告警邮件已发出');
        } catch (e) {
            console.error('[alive] 告警邮件发送失败：', e.message);
        }
    }

    process.exit(anyDown ? 1 : 0);
})();
