'use strict';
// 带入审批（2026-11-17）。完整流程（真服务器：申请 → 房主批准 → 自动重发 → 入座扣钱）上线前用端到端脚本跑过；
// 这里守住「批准」这张票的规矩：谁、做什么、多少钱、多久内、用几次。
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsApproval, takeApproval, requestApproval, decide, PENDING_MS, APPROVED_MS } = require('./src/rooms/buyin-approval');

const game = (approve = true) => ({ roomType: 'cash', ownerUserId: 'owner', config: { approveBuyIn: approve } });
function fakeIo(ownerHere = true) {
    const sent = [];
    const mk = (id, room) => ({ user: { id }, currentRoom: room, emit: (ev, d) => sent.push({ to: id, ev, d }) });
    const sockets = new Map([['o', mk('owner', ownerHere ? 'R' : 'lobby')], ['b', mk('bob', 'R')]]);
    return { io: { sockets: { sockets } }, sent, bob: sockets.get('b') };
}

test('房主自己不用批；没开审批谁都不用批；只管现金桌', () => {
    assert.equal(needsApproval(game(), 'owner'), false);
    assert.equal(needsApproval(game(), 'bob'), true);
    assert.equal(needsApproval(game(false), 'bob'), false);
    assert.equal(needsApproval({ ...game(), roomType: 'sng' }, 'bob'), false);
});

test('申请发到房主；房主不在桌上就直接告诉申请人，不让他干等', () => {
    const g = game();
    const a = fakeIo(true);
    requestApproval({ io: a.io, game: g, roomId: 'R', socket: a.bob, user: { id: 'bob' }, kind: 'sit', chips: 2000, seat: 3, name: 'Bob' });
    assert.ok(a.sent.some(m => m.to === 'owner' && m.ev === 'buyin_request' && m.d.chips === 2000));
    assert.ok(a.sent.some(m => m.to === 'bob' && m.d && m.d.k === 'buyin.waiting'));
    const g2 = game();
    const b = fakeIo(false);
    requestApproval({ io: b.io, game: g2, roomId: 'R', socket: b.bob, user: { id: 'bob' }, kind: 'sit', chips: 2000, name: 'Bob' });
    assert.ok(b.sent.some(m => m.to === 'bob' && m.d && m.d.k === 'buyin.ownerAway'));
    assert.ok(!g2.pendingBuyins || !g2.pendingBuyins.bob, '没人能批的申请不该挂着');
});

test('🔴 只有房主能批', () => {
    const g = game();
    g.pendingBuyins = { bob: { kind: 'sit', chips: 2000, at: 1000 } };
    assert.equal(decide(g, 'bob', 'bob', true, 1001).ok, false, '自己批自己');
    assert.equal(decide(g, 'cid', 'bob', true, 1001).ok, false);
    assert.ok(g.pendingBuyins.bob, '非房主的决定不能把申请消耗掉');
});

test('🔴 批准只认：同一个人、同一种操作、不超过批准的金额、1 分钟内、只能用一次', () => {
    const g = game();
    g.pendingBuyins = { bob: { kind: 'sit', chips: 2000, at: 1000 } };
    assert.equal(decide(g, 'owner', 'bob', true, 1001).approved, true);
    assert.equal(takeApproval(g, 'bob', 'rebuy', 2000, 1002), false, '批的是坐下，不能拿去补码');
    assert.equal(takeApproval(g, 'bob', 'sit', 5000, 1002), false, '改客户端把金额改大 → 对不上');
    assert.equal(takeApproval(g, 'cid', 'sit', 2000, 1002), false, '别人用不了');
    assert.equal(takeApproval(g, 'bob', 'sit', 2000, 1003), true);
    assert.equal(takeApproval(g, 'bob', 'sit', 2000, 1004), false, '只能用一次');
    g.pendingBuyins = { bob: { kind: 'rebuy', chips: 1000, at: 1000 } };
    decide(g, 'owner', 'bob', true, 1000);
    assert.equal(takeApproval(g, 'bob', 'rebuy', 1000, 1000 + APPROVED_MS + 1), false, '过期');
});

test('拒绝 / 过期：申请被清掉，不留批准', () => {
    const g = game();
    g.pendingBuyins = { bob: { kind: 'sit', chips: 2000, at: 1000 } };
    const r = decide(g, 'owner', 'bob', false, 1001);
    assert.equal(r.approved, false);
    assert.equal(takeApproval(g, 'bob', 'sit', 2000, 1002), false);
    g.pendingBuyins = { bob: { kind: 'sit', chips: 2000, at: 1000 } };
    assert.equal(decide(g, 'owner', 'bob', true, 1000 + PENDING_MS + 1).reason, 'gone');
    assert.equal(takeApproval(g, 'bob', 'sit', 2000, 1000 + PENDING_MS + 2), false);
});
