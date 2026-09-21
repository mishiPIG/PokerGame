#!/usr/bin/env node
'use strict';

// IP → 国家/城市，**一次性子进程**（2026-09-21）。
//
// 🔴 为什么非要单开一个进程，而不是在游戏服务器里直接 require：
//    `require('geoip-lite')` 一次就吃 **+108MB 常驻内存**（实测 32MB → 140MB），
//    而生产是 **1GB 的 t3.micro**，游戏进程本身才 ~75MB。
//    在里面加载它 = 平时白占十分之一的内存，只为一个管理员偶尔看一眼的功能。
//    放进子进程：查完就退，内存立刻还回去，游戏进程一个字节都不多占。
//
// 调用方式（管理员查看地区分布时才会被拉起）：
//    echo '["8.8.8.8","1.1.1.1"]' | node tools/geo-lookup.js
// 输出：[{"ip":"8.8.8.8","country":"US","region":"","city":""}, ...]
//
// ⚠️ 查不到的 IP 也会返回一行（country 为 null）——
//    调用方要把它也写进缓存，否则每次都会重复去查同一批查不到的 IP。
//
// ⚠️ geoip-lite 的数据是随包发布的快照，会过时（IP 段会重新分配）。
//    它给的是「大致在哪」，不是权威定位 —— 拿来看分布够用，别拿来做判定。

const fs = require('fs');

function main() {
    let ips;
    try {
        ips = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
        console.error('用法：echo \'["1.2.3.4"]\' | node tools/geo-lookup.js');
        process.exit(2);
    }
    if (!Array.isArray(ips)) {
        console.error('输入必须是 IP 字符串数组');
        process.exit(2);
    }

    let geoip = null;
    try {
        geoip = require('geoip-lite');
    } catch (e) {
        // 没装也不要炸：返回全 null，调用方照常缓存，界面显示「未知」。
        // 比起让管理面板 500，显示「未知」诚实得多。
        console.error('[geo] geoip-lite 不可用：' + e.message);
        process.stdout.write(JSON.stringify(ips.map(ip => ({ ip, country: null, region: null, city: null }))));
        return;
    }

    const out = ips.map(ip => {
        try {
            const r = geoip.lookup(String(ip));
            if (!r) return { ip, country: null, region: null, city: null };
            return { ip, country: r.country || null, region: r.region || null, city: r.city || null };
        } catch {
            return { ip, country: null, region: null, city: null };
        }
    });
    process.stdout.write(JSON.stringify(out));
}

main();
