'use strict';
// 版本信息：人工版本号来自 package.json，构建信息（git SHA / 构建时间）由部署脚本生成。
//
// 为什么要有：以前确认「这次部署到底生效没有」只能 SSH 上去 grep 某个新增的关键字，
// 又土又容易看走眼。现在 `curl /api/version` 一句话就知道线上跑的是哪一版。
//
// ⚠️ 版本号只在【上生产】时才涨，测试服部署不涨 —— 否则号涨得毫无意义。
//    判定标准按【玩家视角】而不是 semver 的 API 兼容性：
//      主  = 大改版 / 玩法结构变了（AI 对战、房型重做）
//      次  = 新功能（链式 straddle、多次发牌、到时暂停）
//      修订 = 修 bug / 小调整
const fs = require('fs');
const path = require('path');

function read(file) {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')); }
    catch (e) { return null; }
}

const pkg = read('package.json') || {};
// build-info.json 由 deploy 脚本在打包时写入；本地开发时没有这个文件，属正常。
const build = read('build-info.json') || {};

const info = {
    version: pkg.version || '0.0.0',
    commit: build.commit || 'dev',
    builtAt: build.builtAt || null,
    // 部署到哪个环境（生产 / 测试服 / 本地）
    env: build.env || (process.env.LOCAL_DEV ? 'local' : 'unknown'),
    startedAt: Date.now()
};

// 给人看的一行：1.1.0 (2026-08-11 · 19c04f5)
info.label = `${info.version}`
    + (info.commit !== 'dev' ? ` (${(info.builtAt || '').slice(0, 10)} · ${info.commit})` : ' (dev)');

module.exports = info;
