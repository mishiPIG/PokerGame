'use strict';

// 验证码发送的【按 IP】限流（2026-09-29）。
//
// 为什么需要：发码原来只按【邮箱地址】限流（同一地址 60 秒一次），
// 而发信额度是全站共用的（免费 163 每天 50 封）。换 50 个假邮箱，
// 一分钟就能把当天额度烧光——之后当天所有人都注册不了、找回不了密码，
// 连走同一个发信号的运维告警也一起发不出去。源码是公开的，谁都看得到这一点。
// 按 IP 限流把「烧额度」的成本从「50 个假邮箱」抬到「一堆不同的 IP」。
//
// ⚠️ IP 必须来自 extractIp()（只在经由本机反代时才信 X-Forwarded-For）。
//    直接信请求头的话，这道闸一个请求头就能绕过。
// ⚠️ 取不到 IP（null）不能等于「不限」—— 那等于给攻击者留了一扇门。统一记进同一个桶。
// ⚠️ 手机网络大多是 CGNAT，很多人共用一个出口 IP，阈值不能太紧：
//    一个正常人注册最多发 2–3 次（没收到再点一次），一间宿舍一起注册也就十来次。

const UNKNOWN = '(unknown)';

function createSendCodeLimiter({ max = 10, windowMs = 60 * 60 * 1000, now = () => Date.now(), maxKeys = 10000 } = {}) {
    const hits = new Map();   // key -> 时间戳数组（升序）

    function check(ip) {
        const key = ip || UNKNOWN;
        const t = now();
        const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
        if (recent.length >= max) {
            hits.set(key, recent);
            return { ok: false, retryAfterMs: windowMs - (t - recent[0]) };
        }
        recent.push(t);
        hits.set(key, recent);
        if (hits.size > maxKeys) sweep(t);
        return { ok: true };
    }

    // 防止换 IP 刷的时候 Map 无限长大：清掉整个窗口里都没动静的 key
    function sweep(t) {
        for (const [k, arr] of hits) {
            if (!arr.length || t - arr[arr.length - 1] >= windowMs) hits.delete(k);
        }
    }

    return { check, size: () => hits.size };
}

module.exports = { createSendCodeLimiter, UNKNOWN };
