'use strict';
// 2026-11-14「谁能做什么」逐个审接口之后补的几道闸。能跑真模块的就跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

const loadSanitize = () => require('./src/ops/payload-sanitize').sanitize;

test('🔴 「毒对象」进不了处理器：toString / valueOf / __proto__ 一律剥掉', () => {
    const sanitize = loadSanitize();
    const evil = JSON.parse('{"text":{"toString":1},"code":{"valueOf":1},"__proto__":{"isAdmin":true},"nested":[{"toJSON":1,"ok":2}],"keep":"x"}');
    const out = sanitize(evil);
    assert.doesNotThrow(() => String(out.text));
    assert.doesNotThrow(() => String(out.code));
    assert.equal(({}).isAdmin, undefined, '原型没被污染');
    assert.equal(out.isAdmin, undefined);
    assert.deepEqual(out.nested, [{ ok: 2 }]);
    assert.equal(out.keep, 'x');
    const ack = () => 1;
    assert.equal(sanitize(ack), ack, '回调函数原样保留');
});

test('🔴 只有在座的人 / 房主 / 管理员出错才暂停牌桌（观战者构造坏消息停不了别人的桌）', () => {
    const src = codeOf(read('src/socket/register-socket-handlers.js'));
    assert.match(src, /require\('\.\.\/ops\/payload-sanitize'\)/);
    assert.match(src, /const mayHaveTouchedGame = game && \(user\.isAdmin \|\| game\.ownerUserId === user\.id[\s\S]*?game\.players\.some/);
    assert.match(src, /if \(mayHaveTouchedGame\) \{\s*game\.paused = true/);
    assert.match(src, /args = args\.map\(a => sanitize\(a\)\)/, '每条消息进处理器之前都要过 sanitize');
});

test('🔴 换房间 / 回大厅都先离开原来的 socket.io 房间', () => {
    const seat = codeOf(read('src/rooms/seat-service.js'));
    const joins = (seat.match(/socket\.join\(roomId\)/g) || []).length;
    const leaves = (seat.match(/leavePreviousRoom\(socket, roomId\);\s*socket\.join\(roomId\)/g) || []).length;
    assert.equal(leaves, joins, 'seat-service 里每一处 socket.join 之前都要先 leavePreviousRoom');
    assert.match(codeOf(read('src/rooms/membership-service.js')), /leavePreviousRoom\(socket, roomId\);\s*socket\.join\(roomId\)/);
    assert.match(codeOf(read('src/socket/events/lobby-events.js')), /socket\.on\('enter_lobby'[\s\S]*?leavePreviousRoom\(socket\)/);
});

test('🔴 在座的人反复发请求不能把下一手无限往后推', () => {
    // 这几条入口都可能被同一个人反复触发：必须 keepExisting
    for (const [f, re] of [
        ['src/rooms/membership-service.js', /scheduleNextHand\(roomId, \{ keepExisting: true \}\);\s*\/\/ 续局/],
        ['src/socket/events/membership-events.js', /scheduleNextHand\(roomId, \{ keepExisting: true \}\);\s*\/\/ 已经排好下一手就不重置/],
        ['src/rooms/seat-service.js', /liveCount\(game\) >= 2\) scheduleNextHand\(roomId, \{ keepExisting: true \}\)/],
    ]) assert.match(codeOf(read(f)), re, f);
});

test('客户端传来的房间号：只能对自己所在的桌', () => {
    for (const [f, ev] of [
        ['src/socket/events/poker-action-events.js', 'player_action'],
        ['src/socket/events/poker-card-events.js', 'show_card'],
        ['src/socket/events/poker-card-events.js', 'rabbit_deal'],
        ['src/socket/events/table-control-events.js', 'toggle_ready'],
    ]) {
        const src = codeOf(read(f));
        const at = src.indexOf(`socket.on('${ev}'`);
        assert.match(src.slice(at, at + 250), /if \(socket\.currentRoom !== roomId\) return;/, `${ev} 要先校验 currentRoom`);
    }
    assert.match(codeOf(read('src/socket/events/table-control-events.js')), /socket\.on\('toggle_ready'[\s\S]*?if \(game\.status === 'running'\) return;/,
        '开赛后（现金桌也一样）不能靠「准备」绕过局间收尾');
});

test('反馈有频率限制；验证码 / 登录接口不吃非字符串', () => {
    const acct = codeOf(read('src/http/register-account-routes.js'));
    assert.match(acct, /FEEDBACK_PER_HOUR = \d/);
    assert.match(acct, /recent\.length >= FEEDBACK_PER_HOUR\) return res\.status\(429\)/);
    const auth = codeOf(read('src/http/register-auth-routes.js'));
    assert.doesNotMatch(auth, /\((username|email) \|\| ''\)\.trim\(\)/, '对象 / 数组传进来会让 .trim() 抛错、接口 500');
});

test('🔴 被拉黑的人删好友不能顺手把对方的拉黑也删了（真库）', () => {
    const { createDatabaseService } = require('./src/storage/database-service');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-authz-'));
    const db = createDatabaseService({ databasePath: path.join(dir, 't.sqlite'), allowCreate: true });
    try {
        const a = db.createUser('A1', 'h', false, null), b = db.createUser('B1', 'h', false, null);
        db.friends.block(b.id, a.id);                 // B 拉黑 A
        db.friends.remove(a.id, b.id);                // A 点「删除」
        assert.equal(db.friends.edgeStatus(b.id, a.id), 'blocked', 'B 的拉黑必须还在');
        db.friends.remove(b.id, a.id);                // B 自己删 —— 他的行可以删
        assert.notEqual(db.friends.edgeStatus(b.id, a.id), 'blocked');
    } finally {
        db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('搜牌友：人在哪个房间只告诉已经是牌友的人；注销会断开连接；管理员权限每次回库查', () => {
    assert.match(codeOf(read('src/socket/events/friend-events.js')), /=== 'accepted' \? st : \{ online: st\.online, roomId: null \}/);
    assert.match(codeOf(read('src/http/register-account-routes.js')), /s\.user\?\.id === user\.id\) s\.disconnect\(true\)/);
    const adm = codeOf(read('src/socket/events/admin-room-events.js'));
    assert.doesNotMatch(adm, /if \(!user\.isAdmin\)/, 'socket.user 是连接时的快照，撤销管理员后还会留着权限');
    assert.equal((adm.match(/if \(!stillAdmin\(\)\)/g) || []).length, 2);
});

test('管理员补偿的 requestId 在表单打开时定好，双击不会补两次', () => {
    const js = codeOf(read('public/js/90-admin.js'));
    assert.match(js, /data-req="\$\{Date\.now\(\)\}/);
    assert.match(js, /requestId: \(btn && btn\.dataset\.req\)/);
    assert.doesNotMatch(js, /requestId: `\$\{Date\.now\(\)\}-\$\{Math\.random/);
});
