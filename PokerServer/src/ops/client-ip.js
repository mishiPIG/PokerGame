'use strict';

// 取客户端真实 IP + 归一化（2026-09-21）。
//
// 单拎出来是因为这里有三个**很容易悄悄搞错**的地方，而搞错了不会报错、只会让
// 「同 IP 多账号」这类判断给出垃圾结论：
//
// 1) 🔴 **`X-Forwarded-For` 只有在请求来自本机反代时才可信，而且要取【最右边】那个。**
//    这个头**任何客户端都能自己填**。生产走 Caddy，Caddy 会把它看到的真实对端写进去；
//    链条里 Caddy 写的是最右边那个，左边的全是客户端自己能编的。
//    🔴 **3000 端口对公网开放**（存活探针要直连它来区分「应用挂了」还是「证书/反代挂了」），
//    所以直连 3000 的请求**根本不经过 Caddy** —— 这种请求带来的 X-Forwarded-For
//    一个字都不能信，只能用真实的连接地址。
//    （2026-09-29 更正：本文件原先写的是「取最左边」+「外部到不了 3000 端口」，
//     后一句是假的——从外网直连 3000 实测 200。照原写法，任何人直连 3000 自带一个
//     假 XFF 头就能随意冒充来源 IP：登录来源统计会被污染，按 IP 的限流形同虚设。）
//
// 2) 🔴 **IPv6 的完整地址不能直接拿来比对。**
//    地址按设备分配、还会随时间变（隐私扩展），同一个人每次登录看起来都是「新 IP」。
//    有意义的聚合单位是 **/64 前缀**（一个家庭/一条线路通常共用一个 /64）。
//    IPv4 这边同理用 **/24** 做粗聚合（同一个小网段）。
//
// 3) `::ffff:1.2.3.4` 这种 IPv4-mapped IPv6 要还原成 IPv4，否则同一个人会被
//    拆成两个不同的「IP」。
//
// 从 http 请求里取出客户端 IP。peerAddress = 真实的 TCP 对端（req.socket.remoteAddress）。
// 取不到就返回 null —— **绝不编一个假的**（比如 '0.0.0.0'），否则一堆取不到的人会被聚成「同一个 IP」。
function extractIp(headers, peerAddress) {
    const peer = normalizeIp(peerAddress);
    if (!peer) return null;                           // 连对端都不知道，更没理由信一个客户端能写的头
    if (!isLoopback(peer)) return peer;               // 直连（没经过本机反代）：XFF 一律不信
    // 对端是本机 → 经由本机反代而来：取 Caddy 写进去的那个（最右边）
    const fwd = headers && (headers['x-forwarded-for'] || headers['X-Forwarded-For']);
    if (!fwd) return null;                            // 本机直接发起的请求，没有真实来源可记
    const parts = String(fwd).split(',');
    const ip = normalizeIp(parts[parts.length - 1]);
    if (!ip || isLoopback(ip)) return null;
    return ip;
}

function isLoopback(ip) {
    return ip === '::1' || /^127\./.test(ip);
}

function normalizeIp(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    // ::ffff:1.2.3.4 → 1.2.3.4
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
    if (mapped) s = mapped[1];
    // 去掉 IPv6 的 zone id（fe80::1%eth0）
    s = s.split('%')[0];
    if (isIpv4(s) || s.includes(':')) return s.toLowerCase();
    return null;
}

function isIpv4(s) {
    const parts = String(s).split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// 聚合用的前缀。**同 IP 判断一律用它，不要用完整地址**（见上面第 2 点）。
function prefixOf(ip) {
    if (!ip) return null;
    if (isIpv4(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24';

    if (!ip.includes(':')) return null;
    // IPv6 /64 = 前四组。先把 :: 展开，否则 'fe80::1' 会被当成只有两组。
    const groups = expandIpv6(ip);
    if (!groups) return null;
    return groups.slice(0, 4).join(':') + '::/64';
}

function expandIpv6(ip) {
    const [head, tail] = String(ip).split('::');
    if (tail === undefined) {
        const g = head.split(':');
        return g.length === 8 ? g.map(pad) : null;
    }
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    return [...h, ...Array(fill).fill('0'), ...t].map(pad);
}

const pad = (g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '');

module.exports = { extractIp, normalizeIp, prefixOf, isIpv4, isLoopback };
