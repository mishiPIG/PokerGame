'use strict';

// 客户端报错上报（2026-09-16）。
//
// 🔴 缺口：前端 JS 报错**只在玩家自己的 console 里**，服务端一无所知。
//    表现出来就是玩家说「点了没反应」「卡住了」，而我们这边日志干干净净。
//    这个项目吃过好几次这种亏：`sizeFor` 拼错、`#room-count` 被删、
//    `navigator.clipboard` 在 http 下是 undefined —— 全都是**静默失效**，
//    没有任何报错到得了服务端，最后都靠玩家截图才发现。
//
// ⚠️ 这个端点必然要开给未登录用户（登录页本身也会出错），所以**必须当成敌对输入处理**：
//    ① 按 IP 限流；② 同一条错误去重（一个坏循环能一秒报几百条）；③ 字段长度硬截断。
//    否则「可观测性」会变成一个免费的日志注入 + 磁盘填满通道。
//
// 存法：内存环形缓冲 + console.error（进 pm2 错误日志）。
//    刻意**不落库**——错误日志不是数据资产，而牌谱是；不值得为它加一张表、加一次迁移、
//    再加一条清理 cron。丢了就丢了，pm2 日志那份还在。

const MAX_BUFFER = 200;          // 管理面板只看最近这些
const MAX_PER_IP_PER_MIN = 10;   // 一个客户端一分钟最多 10 条
const DEDUPE_MS = 60_000;        // 同一条错误 1 分钟内只记一次

function createClientErrorSink({ now = Date.now } = {}) {
    const buffer = [];                    // 最近的错误（新的在后）
    const hits = new Map();               // ip -> [时间戳]
    const seen = new Map();               // 指纹 -> { at, count }

    const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

    function prune(t) {
        for (const [ip, arr] of hits) {
            const keep = arr.filter(x => t - x < 60_000);
            if (keep.length) hits.set(ip, keep); else hits.delete(ip);
        }
        for (const [k, v] of seen) if (t - v.at > DEDUPE_MS * 5) seen.delete(k);
    }

    return {
        // 返回 { accepted, reason? }。**永远不抛** —— 上报通道自己崩了是最讽刺的事。
        record(raw, { ip = '?', username = null } = {}) {
            try {
                const t = now();
                prune(t);

                const arr = hits.get(ip) || [];
                if (arr.length >= MAX_PER_IP_PER_MIN) return { accepted: false, reason: 'rate' };

                const message = clip(raw?.message, 300);
                if (!message) return { accepted: false, reason: 'empty' };

                const entry = {
                    at: t,
                    message,
                    source: clip(raw?.source, 200),
                    line: Number(raw?.line) || 0,
                    col: Number(raw?.col) || 0,
                    stack: clip(raw?.stack, 1500),
                    build: clip(raw?.build, 40),        // 前端构建号：一眼看出是不是缓存了旧 JS
                    page: clip(raw?.page, 120),
                    ua: clip(raw?.ua, 200),
                    kind: raw?.kind === 'rejection' ? 'rejection' : 'error',
                    username: clip(username, 40) || null,
                    ip,
                };

                // 去重：同一处同一条错误在循环里能一秒几百次
                const fp = `${entry.kind}|${entry.message}|${entry.source}:${entry.line}:${entry.col}`;
                const prev = seen.get(fp);
                if (prev && t - prev.at < DEDUPE_MS) {
                    prev.count++;
                    prev.at = t;
                    const inBuf = buffer.find(b => b._fp === fp);
                    if (inBuf) { inBuf.count = prev.count; inBuf.at = t; }
                    return { accepted: true, deduped: true, count: prev.count };
                }
                seen.set(fp, { at: t, count: 1 });
                hits.set(ip, [...arr, t]);

                entry._fp = fp;
                entry.count = 1;
                buffer.push(entry);
                if (buffer.length > MAX_BUFFER) buffer.shift();

                console.error(`[client-error] ${entry.build || '?'} ${entry.username || '(未登录)'} `
                    + `${entry.kind} ${entry.message} @${entry.source}:${entry.line}`);
                return { accepted: true };
            } catch {
                return { accepted: false, reason: 'internal' };
            }
        },
        list() { return buffer.slice().reverse().map(({ _fp, ...e }) => e); },
        size() { return buffer.length; },
    };
}

module.exports = { createClientErrorSink, MAX_BUFFER, MAX_PER_IP_PER_MIN, DEDUPE_MS };
