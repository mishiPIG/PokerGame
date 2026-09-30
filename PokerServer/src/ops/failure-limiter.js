'use strict';

// 按「失败次数」限流（2026-09-30，防暴力试密码 / 撞库）。
//
// 和 send-code-limiter 的区别：那个是【每次尝试】都计数（发信本身就是成本），
// 这个只数【失败】—— 正常人输对了密码不该被算进去，输错几次也不该马上被锁。
//
// 用法：先 check(key) 看是否已被挡；失败了 fail(key)；成功了按需 clear(key)。

function createFailureLimiter({ max, windowMs, now = () => Date.now(), maxKeys = 20000 } = {}) {
    if (!(max > 0) || !(windowMs > 0)) throw new Error('createFailureLimiter: max / windowMs 必填');
    const fails = new Map();   // key -> 失败时间戳数组（升序）

    const recent = (key, t) => {
        const arr = (fails.get(key) || []).filter(x => t - x < windowMs);
        if (arr.length) fails.set(key, arr); else fails.delete(key);
        return arr;
    };

    function check(key) {
        const t = now();
        const arr = recent(key, t);
        if (arr.length >= max) return { ok: false, retryAfterMs: windowMs - (t - arr[0]) };
        return { ok: true };
    }

    function fail(key) {
        const t = now();
        const arr = recent(key, t);
        arr.push(t);
        fails.set(key, arr);
        if (fails.size > maxKeys) {   // 换着 key 刷时别让 Map 无限长大
            for (const [k, a] of fails) if (!a.length || t - a[a.length - 1] >= windowMs) fails.delete(k);
        }
    }

    return { check, fail, clear: (key) => fails.delete(key), size: () => fails.size };
}

module.exports = { createFailureLimiter };
