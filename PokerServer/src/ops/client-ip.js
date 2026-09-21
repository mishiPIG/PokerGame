'use strict';

// 取客户端真实 IP + 归一化（2026-09-21）。
//
// 单拎出来是因为这里有三个**很容易悄悄搞错**的地方，而搞错了不会报错、只会让
// 「同 IP 多账号」这类判断给出垃圾结论：
//
// 1) 🔴 **生产走 Caddy 反代，直连拿到的永远是 127.0.0.1。**
//    真实地址在 `X-Forwarded-For` 里，而且是一条链：`客户端, 代理1, 代理2`。
//    要取**最左边**那个（最靠近客户端的）。取错方向就全是代理自己的地址。
//
// 2) 🔴 **IPv6 的完整地址不能直接拿来比对。**
//    地址按设备分配、还会随时间变（隐私扩展），同一个人每次登录看起来都是「新 IP」。
//    有意义的聚合单位是 **/64 前缀**（一个家庭/一条线路通常共用一个 /64）。
//    IPv4 这边同理用 **/24** 做粗聚合（同一个小网段）。
//
// 3) `::ffff:1.2.3.4` 这种 IPv4-mapped IPv6 要还原成 IPv4，否则同一个人会被
//    拆成两个不同的「IP」。
//
// ⚠️ X-Forwarded-For 是**客户端可伪造的头**。这里能信它，是因为
//    Caddy 会覆盖/追加它，而应用只监听 localhost、外部到不了 3000 端口。
//    哪天把端口直接暴露出去，这个假设就不成立了 —— 那时必须改成只信任代理链。

// 从 socket / http 请求里取出客户端 IP。取不到就返回 null ——
// **绝不编一个假的**（比如 '0.0.0.0'），否则一堆取不到的人会被聚成「同一个 IP」。
function extractIp(headers, fallbackAddress) {
    const fwd = headers && (headers['x-forwarded-for'] || headers['X-Forwarded-For']);
    const raw = fwd
        ? String(fwd).split(',')[0]          // 最左边 = 最靠近客户端
        : String(fallbackAddress || '');
    const ip = normalizeIp(raw);
    if (!ip) return null;
    // 本机地址说明没穿过代理拿到真实来源，记下来没有意义
    if (ip === '127.0.0.1' || ip === '::1') return null;
    return ip;
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

module.exports = { extractIp, normalizeIp, prefixOf, isIpv4 };
