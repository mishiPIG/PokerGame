'use strict';

// 游戏长连接（socket.io）的护栏（2026-09-30）。挂在 JWT 鉴权【之前】：被挡的连接连数据库都不碰。
//
// 原来：同一个 IP 能开任意多条连接，每条连接能以任意频率发任意事件。
// 生产是 1GB 内存的 t3.micro —— 开几千条连接、或一条连接每秒发几千个事件，就能把整机拖垮，
// 而「服务器被打挂」对正在打牌的人意味着牌局中断（虽然能恢复，但体验和信任都是真损失）。
//
// ① 每 IP 并发连接数上限。
//    ⚠️ 取不到 IP（null）的连接不计：只有「本机连本机、又没带代理头」才会取不到
//       （本地测试 / 健康探针）。远程攻击者造不出 null —— 直连拿得到真实对端，
//       经 Caddy 则有 Caddy 写的真实 IP。这和登录/发码限流「null 进同一个桶」是不同的取舍：
//       那两处是「从严」，这里若从严，本地起 30 个机器人的测试就全被挡掉了。
//    ⚠️ 手机 CGNAT、宿舍、公司常常很多人共用一个出口，上限定宽一些。
// ② 每条连接的事件令牌桶：平时够用得很宽，只挡「脚本狂刷」；持续超限就断开。
// ③ 单条消息体积上限在 new Server({ maxHttpBufferSize }) 设（语音走 HTTP 上传，不经 socket）。

const { extractIp } = require('./client-ip');

// 日志走 stdout（console.log）而不是 stderr：部署后的错误日志自查和告警都盯着 stderr，
// 有人刷一次就刷出一屏「错误」—— 告警一吵就没人看了。这是预期内的防护动作，不是故障。
const INFO_LOG = { warn: (...a) => console.log(...a) };
function registerSocketGuard(io, { maxPerIp = 30, burst = 40, refillPerSec = 15, kickAfterDrops = 200, now = () => Date.now(), log = INFO_LOG } = {}) {
    const perIp = new Map();   // ip -> 当前连接数

    io.use((socket, next) => {
        const ip = extractIp(socket.handshake.headers, socket.handshake.address);
        socket.data.guardIp = ip;
        if (ip && (perIp.get(ip) || 0) >= maxPerIp) {
            log.warn(`[guard] 拒绝连接：${ip} 已有 ${perIp.get(ip)} 条连接`);
            return next(new Error('too many connections'));
        }
        next();
    });

    // 计数放在 connection 里而不是 io.use 里：后面的鉴权中间件拒绝时，
    // 这条连接根本不会触发 disconnect —— 在 io.use 里 +1 就永远减不回去。
    io.on('connection', (socket) => {
        const ip = socket.data.guardIp;
        if (ip) perIp.set(ip, (perIp.get(ip) || 0) + 1);
        let tokens = burst, last = now(), drops = 0;
        socket.use((packet, next) => {
            const t = now();
            tokens = Math.min(burst, tokens + (t - last) / 1000 * refillPerSec);
            last = t;
            if (tokens >= 1) { tokens -= 1; return next(); }
            drops++;
            if (drops === 1 || drops % 50 === 0) log.warn(`[guard] 事件过快，丢弃 ${packet[0]}（${socket.user?.username || '?'} ${ip || ''}，累计 ${drops}）`);
            if (drops >= kickAfterDrops) { log.warn(`[guard] 断开持续狂刷的连接 ${socket.user?.username || '?'} ${ip || ''}`); socket.disconnect(true); }
            // 不调用 next：这个事件被丢弃
        });
        socket.on('disconnect', () => {
            if (!ip) return;
            const n = (perIp.get(ip) || 1) - 1;
            if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
        });
    });

    return { connectionsOf: (ip) => perIp.get(ip) || 0 };
}

module.exports = { registerSocketGuard };
