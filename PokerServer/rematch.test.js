'use strict';
// 「再来一局」（2026-11-17）。完整流程（真服务器打完一场 SNG → 房主发起 → 对手加入 / 局外人伪造被拒）
// 在上线前用端到端脚本跑过；这里守住两道闸，防止以后有人改动时把它们拆掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { offerRematch, takeRematch, REMATCH_TTL_MS, _pending } = require('./src/socket/rematch-invites');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const handler = (src, ev) => {
    const i = src.indexOf(`socket.on('${ev}'`);
    assert.ok(i >= 0, ev + ' 处理器不见了');
    return src.slice(i, src.indexOf('\n    });', i));
};

test('待办邀请：只发给指定的人、只能用一次、过期作废', () => {
    _pending.clear();
    offerRematch('R1', 'bob', 'ann', 1000);
    assert.equal(takeRematch('R1', 'cid', 1001), null, '没发给 cid');
    assert.equal(takeRematch('R2', 'bob', 1001), null, '别的房间不算');
    assert.ok(takeRematch('R1', 'bob', 1002));
    assert.equal(takeRematch('R1', 'bob', 1003), null, '用过一次就没了');
    offerRematch('R1', 'bob', 'ann', 1000);
    assert.equal(takeRematch('R1', 'bob', 1000 + REMATCH_TTL_MS + 1), null, '过期');
});

test('🔴 rematch_join：先查待办记录，查到了才给下场资格', () => {
    const h = handler(read('src/socket/events/invite-events.js'), 'rematch_join');
    const take = h.indexOf('takeRematch(');
    const grant = h.indexOf('authorize(');
    assert.ok(take > 0 && grant > take, '没有这道闸，谁知道新桌房间号谁就能自己 emit 一个进来（大厅里房间号是公开的）');
    assert.ok(h.indexOf('canAuthorizeNewUser(') > take, '落地前再查一次能不能进（可能已经坐满 / 开赛）');
});

test('🔴 rematch_sng：只有房主、只有打完的 SNG、每场一次；邀请里不带房间码', () => {
    const h = handler(read('src/socket/events/lobby-events.js'), 'rematch_sng');
    assert.match(h, /ownerUserId !== user\.id/);
    assert.match(h, /tournamentOver/);
    assert.match(h, /rematchRoomId/);
    assert.ok(!/joinCode|invite\.code/.test(h), '邀请不能带房间码：被邀请者转手发给别人，房主控制入场那条就没了');
});
