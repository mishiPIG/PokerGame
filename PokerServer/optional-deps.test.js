'use strict';

// 可选依赖的引擎门槛（2026-09-21）。
//
// 🔴 这条关卡是被一次真实的静默失效逼出来的：
//    `geoip-lite@2.0.3` 声明 `engines: { node: ">=24.0.0" }`，而生产是 Node 22。
//    **npm 对「引擎不匹配的 optional 依赖」是设计上静默跳过的** ——
//    不报错、不警告、**退出码 0**、`node_modules` 里就是没有那个目录。
//    我的开发机是 Node 24，所以本机一直好好的、111MB 数据俱全；
//    一上生产就没了，而且没有任何东西会说出来。
//
//    第一次撞上时（测试服）我归因成「npm 状态坏了」，还写进了文档 —— **那是误判**。
//    真凶从头到尾都是这个引擎门槛：测试服是 Node 20，同样不满足。
//    当时之所以「修好了」，是因为我改用了 `npm install geoip-lite --save-prod`
//    —— **显式安装时引擎不匹配只是警告（EBADENGINE），照装**；
//    而作为 optional 依赖被解析时，它是静默跳过。两条路径行为完全不同。
//
// 所以守的不是「某个包装没装上」，而是：
//    **每个可选依赖声明的 Node 范围，必须把我们真正部署的所有 Node 版本都包住。**
// 这样以后谁把版本一升（2.x 全线都要 Node>=24），这里当场就报，
// 而不是等到上了生产、管理员点开面板发现一片「未知」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const semver = require('semver');

// 我们真正跑这套代码的地方。**改服务器 Node 版本时必须同步改这里**，
// 它也正是 CI 矩阵（.github/workflows/ci.yml）里那两个版本。
const DEPLOY_TARGETS = [
    { where: '测试服', version: '20.20.2' },
    { where: '生产 AWS', version: '22.23.2' },
];

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'));

test('🔴 可选依赖的 engines 必须覆盖所有部署目标的 Node —— 否则 npm 会静默跳过它', () => {
    const optional = Object.keys(pkg.optionalDependencies || {});
    assert.ok(optional.length > 0,
        '没有可选依赖了？那就把这条关卡一起删掉，别留一条永远为真的断言');

    for (const name of optional) {
        const entry = lock.packages && lock.packages['node_modules/' + name];
        assert.ok(entry, `package-lock.json 里找不到 ${name} —— 先跑一次 npm install`);

        const range = entry.engines && entry.engines.node;
        if (!range) continue;   // 没声明 = 不挑 Node，随便装

        for (const t of DEPLOY_TARGETS) {
            assert.ok(semver.satisfies(t.version, range),
                `🔴 ${name}@${entry.version} 要求 Node "${range}"，`
                + `而${t.where}是 Node ${t.version} —— 不满足。\n`
                + '   npm 会【静默跳过】这个可选依赖：不报错、退出码 0、目录就是不存在。\n'
                + '   本机 Node 新一点的话你完全看不出来，一上服务器功能就没了。\n'
                + '   解法优先级：①降到支持该 Node 的版本（本项目先例：宁可降依赖，\n'
                + '   也不在别的事情正在进行时更换运行时）；②确实非升不可，就连同\n'
                + '   DEPLOY_TARGETS、CI 矩阵、两台服务器一起升，别只改一处。');
        }
    }
});

test('部署目标要和 CI 矩阵对得上 —— 只测一个版本等于没测另一台', () => {
    const ciPath = path.join(__dirname, '../.github/workflows/ci.yml');
    if (!fs.existsSync(ciPath)) return;   // CI 文件不在就不管
    const ci = fs.readFileSync(ciPath, 'utf8');

    for (const t of DEPLOY_TARGETS) {
        const major = semver.major(t.version);
        assert.match(ci, new RegExp(`${major}\\.x`),
            `🔴 CI 矩阵里没有 Node ${major}.x，而${t.where}正是这个大版本。`
            + '`better-sqlite3` 就因为 Node 版本段错误过一次 —— 没测到的那台迟早出事。');
    }
});
