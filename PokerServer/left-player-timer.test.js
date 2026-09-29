'use strict';
// SNG 里【主动退出】的人 vs【断网掉线】的人：行动计时必须区分开。
// 2026-09-29 最终验收：一场 6 人 SNG 里有人开赛后点了退出，之后每手每街都让全桌等满 18 秒，
// 15 分钟只打了 30 手 —— 桌上看起来就是「卡住了」。
// 7/26 那次把掉线者的「秒判弃牌」改成正常计时，是为了网络抖动时不冤枉人；
// 可主动退出和断网被合成了同一个 away 标记，于是「人都走了」也享受 18 秒。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('🔴 主动退出 SNG 的人快速代打；断网的人仍给正常时间', () => {
    const hs = read('src/games/poker/hand-service.js');
    const i = hs.indexOf('function startActionTimer(');
    const body = hs.slice(i, hs.indexOf('\n}\n', i));
    assert.match(body, /leftByChoice\s*\?\s*LEFT_PLAYER_ACT_MS\s*:\s*ACTION_TIME/, '计时要按 leftByChoice 区分');
    assert.doesNotMatch(body, /\baway\s*\?/, '不能按 away 缩短 —— 那会让网络抖动的人被秒判弃牌（7/26 修过的老问题）');
    const m = /const LEFT_PLAYER_ACT_MS = (\d+)/.exec(hs);
    assert.ok(m && +m[1] >= 1000 && +m[1] <= 3000, '代打前留 1~3 秒，让桌上看得清');
});

test('只有「开赛后主动退出 SNG」才打标记；回来就清掉', () => {
    const me = read('src/socket/events/membership-events.js');
    const at = me.indexOf('SNG 开赛后退出');
    assert.ok(at > 0, '找不到 SNG 开赛后退出的分支');
    assert.match(me.slice(at, at + 300), /leftByChoice = true/, '主动退出要打 leftByChoice');
    // 断线处理里绝不能打这个标记
    assert.doesNotMatch(read('src/socket/events/disconnect-events.js'), /leftByChoice\s*=\s*true/);
    const ms = read('src/rooms/membership-service.js');
    assert.match(ms, /existing\.leftByChoice = false/, '重新进房要清掉标记，恢复正常计时');
});
