'use strict';
// 2026-11-14 全项目排查修掉的几个洞，各守一条。
// 能用真模块跑的就真跑（头像白名单、入座扣款、SNG 解散退款）；
// 只有穿过框架才能触发的（socket 包装层、HTTP 路由、浏览器模板）守结构。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// 只剥整行注释和块注释（宁可少剥留个假警报，也不能多剥把真违规藏起来）
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// ───────── 头像注入 ─────────
test('🔴 头像只收内置文件路径；带引号 / 脚本 / 外链的一律变成「没有头像」', () => {
    const { safeAvatar } = require('./src/account/avatar');
    assert.equal(safeAvatar('/avatars/b1.svg'), '/avatars/b1.svg');
    assert.equal(safeAvatar('/avatars/b27.svg'), '/avatars/b27.svg');
    for (const bad of [
        'x" onerror="alert(1)', 'x"><img src=x onerror=alert(1)>', '/avatars/b1.svg" onerror="x',
        'https://evil.example/a.svg', '/avatars/b28.svg', '/avatars/b0.svg', '/avatars/a1.svg',
        '/avatars/../secret.key', '', null, undefined, 42, {}
    ]) assert.equal(safeAvatar(bad), null, `应当拒绝：${String(bad)}`);
});

test('🔴 set_avatar 走白名单；从库里读出来也过一遍（脏数据不必改库就失效）', () => {
    const ev = codeOf(read('src/socket/events/connection-events.js'));
    const at = ev.indexOf("socket.on('set_avatar'");
    assert.ok(at > 0);
    assert.match(ev.slice(at, at + 200), /!safeAvatar\(avatar\)\)\s*return/, 'set_avatar 必须拒绝白名单之外的值');
    assert.match(read('src/storage/user-repository.js'), /avatar:\s*safeAvatar\(row\.avatar\)/, '读用户行时头像要过白名单');
});

test('🔴 客户端模板里不许把别人的数据原样拼进 <img src>', () => {
    const dir = path.join(__dirname, 'public/js');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
        codeOf(fs.readFileSync(path.join(dir, f), 'utf8')).split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/src="\$\{([^}]*)\}"/g)) {
                const expr = m[1].trim();
                // 放行：已转义的；以及 AVATARS 常量表里的内置路径（40-profile 的头像选择器）
                if (/^escapeHtml\(/.test(expr) || (expr === 'u' && /AVATARS\.map\(u =>/.test(line))) continue;
                bad.push(`${f}:${i + 1}  ${expr}`);
            }
        });
    }
    assert.deepEqual(bad, [], '这些 <img src> 没有 escapeHtml');
});

test('表情气泡只当文本显示', () => {
    const chat = codeOf(read('public/js/60-chat.js'));
    const at = chat.indexOf('function seatBubble(');
    const body = chat.slice(at, chat.indexOf('\n}', at));
    assert.doesNotMatch(body, /innerHTML/);
    assert.match(body, /textContent/);
});

// ───────── socket 包装层 ─────────
test('🔴 空负载不能让处理器抛错（抛错会把发送者所在的整张桌子暂停）', () => {
    const src = codeOf(read('src/socket/register-socket-handlers.js'));
    assert.match(src, /args\[0\] == null[^\n]*args\[0\] = \{\}/, '第一个参数为空时要补成 {}');
    assert.ok(src.indexOf('args[0] = {}') < src.indexOf('handler(...args)'), '必须在调用处理器之前补');
});

test('add_time 的房间号只解析一次；看后续牌只能对自己所在的桌发', () => {
    const act = codeOf(read('src/socket/events/poker-action-events.js'));
    const at = act.indexOf("socket.on('add_time'");
    const body = act.slice(at, at + 1600);
    assert.doesNotMatch(body, /roomGames\[\w+\]\s*\|\|\s*roomGames\[socket\.currentRoom\]/, '不能「找牌局退回 currentRoom、上计时器却用原值」');
    const card = codeOf(read('src/socket/events/poker-card-events.js'));
    const r = card.indexOf("socket.on('rabbit_deal'");
    assert.match(card.slice(r, r + 200), /socket\.currentRoom !== roomId\)\s*return/);
});

test('重发 join_room 不能白拿一轮思考时间', () => {
    const ms = codeOf(read('src/rooms/membership-service.js'));
    assert.match(ms, /if \(wasAway \|\| !game\.actionTimer\) startActionTimer\(roomId\)/);
});

// ───────── 入座扣款 ─────────
function seatHarness(walletResult) {
    const { createSeatService } = require('./src/rooms/seat-service');
    const game = {
        matchId: 'm1', roomType: 'sng', status: 'waiting', phase: 'waiting', players: [], buttonIdx: 0, prizePool: 0,
        config: { maxPlayers: 2, buyIn: 1100, startingStack: 10000 }
    };
    const keys = [];
    const emitted = [];
    const socket = { id: 's1', playRoom: 'r', join() {}, emit(e, p) { emitted.push([e, p]); }, to() { return { emit() {} }; } };
    const svc = createSeatService({
        io: { in: () => ({ emit() {} }), to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
        db: { getUserById: () => ({ gold: 5000, avatar: null }), wallet: { countOperations: () => keys.length } },
        roomGames: { r: game }, lobbySockets: new Set(),
        persistence: {
            commitWithWallet(roomId, changes) { keys.push(changes[0].operationKey); return { wallets: [walletResult], match: {} }; },
            commit() { return {}; }
        },
        config: { PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' }, BUYIN_RATE: 0.11, CASHOUT_RATE: 0.1, gameBB: () => 50, timeCardsFor: () => 1 },
        hooks: { clampInt: (v) => v, broadcastState() {}, broadcastRoomList() {}, clearActionTimer() {}, afterAction() {}, isBettingRoundComplete: () => false, advanceStage() {}, scheduleNextHand() {}, liveCount: () => 0, cashOut: () => 0, recordLeft() {} }
    });
    return { svc, game, socket, keys, emitted };
}

test('🔴 钱包说「这笔早处理过」= 这次没扣到钱 → 入座必须失败并回滚', () => {
    const { svc, game, socket } = seatHarness({ balance: 5000, applied: false });
    const ok = svc.seatPlayer('r', socket, { id: 'u1', username: 'U' }, null, 0);
    assert.equal(ok, false, '没扣到报名费就不能入座');
    assert.equal(game.players.length, 0, '座位要回滚');
    assert.equal(game.prizePool, 0, '没人付的钱不能进奖池');
});

test('同一场里再次入座用的是新的扣款键（退出再进来要重新扣报名费）', () => {
    const { svc, game, socket, keys } = seatHarness({ balance: 3900, applied: true });
    assert.equal(svc.seatPlayer('r', socket, { id: 'u1', username: 'U' }, null, 0), true);
    game.players.length = 0;   // 模拟「开赛前退出」后座位被移除
    assert.equal(svc.seatPlayer('r', socket, { id: 'u1', username: 'U' }, null, 0), true);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1], '两次入座不能复用同一个幂等键');
});

test('座位号必须是整数：字符串 "0" 不能骗过占座检查', () => {
    const { svc, game, socket } = seatHarness({ balance: 3900, applied: true });
    game.players.push({ userId: 'other', seat: 0, chips: 10000 });
    assert.equal(svc.seatPlayer('r', socket, { id: 'u1', username: 'U' }, null, '0'), true);
    assert.equal(game.players.find(p => p.userId === 'u1').seat, 1, '应当被分到空座，而不是和别人挤在 0 号');
});

// ───────── SNG 没开赛就解散 ─────────
function sngHarness(status, players = [
    { userId: 'owner', seat: 0, chips: 10000, buyInGold: 1100 },
    { userId: 'guest', seat: 1, chips: 10000, buyInGold: 1100 }
]) {
    const { createSngMatchService } = require('./src/matches/sng-match-service');
    const { createMatchResultService } = require('./src/matches/match-result-service');
    const config = require('./src/config');
    const game = {
        matchId: 'm1', roomType: 'sng', status, prizePool: 1100 * players.length, config: { name: 'T', buyIn: 1100 },
        players
    };
    // 排名用真的 buildRanking（按名次发奖靠它算每一名拿多少）
    const { buildRanking } = createMatchResultService({ io: { in: () => ({ emit() {} }) }, db: { getUserById: () => null }, roomGames: { r: game } });
    const paid = [];
    const svc = createSngMatchService({
        io: { in: () => ({ emit() {} }), to: () => ({ emit() {} }), sockets: { sockets: new Map() } },
        db: { wallet: { countOperations: () => 0 } },
        roomGames: { r: game }, lobbySockets: new Set(), sngPrize: config.sngPrize, sngPayouts: config.sngPayouts, sngEntrants: config.sngEntrants,
        persistence: {
            commitWithWallet(roomId, changes) { changes.forEach(c => paid.push([c.userId, c.delta, c.type])); return { wallets: changes.map(() => ({ balance: 0, applied: true })) }; },
            finish() {}
        },
        PHASES: { WAITING: 'waiting', SHOWDOWN: 'showdown' },
        hooks: { broadcastState() {}, broadcastRoomList() {}, buildRanking, sendMatchResult() {}, listRooms: () => [], clearActionTimer() {} }
    });
    return { svc, paid };
}

test('🔴 没开赛的 SNG 被解散 → 每人原数退回报名费，不判给「筹码领先者」', () => {
    const { svc, paid } = sngHarness('waiting');
    svc.dissolveSngRoom('r');
    assert.deepEqual(paid.sort(), [['guest', 1100, 'sng_refund'], ['owner', 1100, 'sng_refund']]);
});

test('已经开赛的单挑 SNG 被解散 → 奖池（抽水后）给筹码领先者（单挑只发一名，和原来一样）', () => {
    const { svc, paid } = sngHarness('running', [
        { userId: 'owner', seat: 0, chips: 12000, buyInGold: 1100 },
        { userId: 'guest', seat: 1, chips: 8000, buyInGold: 1100 }
    ]);
    svc.dissolveSngRoom('r');
    assert.deepEqual(paid, [['owner', 2000, 'sng_prize']]);
});

test('已经开赛的 3 人 SNG 被解散 → 按当前名次发：筹码第一 2 份、第二 1 份（2026-11-18 起按名次发奖）', () => {
    const { svc, paid } = sngHarness('running', [
        { userId: 'a', seat: 0, chips: 5000, buyInGold: 1100 },
        { userId: 'b', seat: 1, chips: 15000, buyInGold: 1100 },
        { userId: 'c', seat: 2, chips: 10000, buyInGold: 1100 }
    ]);
    svc.dissolveSngRoom('r');
    assert.deepEqual(paid, [['b', 2000, 'sng_prize'], ['c', 1000, 'sng_prize']]);   // 奖池 3300 → 抽水后 3000
});

test('SNG 里已入座的人不能被请出（否则报名费既不退也不参与排名）', () => {
    const src = codeOf(read('src/socket/events/table-control-events.js'));
    const at = src.indexOf("socket.on('kick_player'");
    const body = src.slice(at, src.indexOf('standUpPlayer(roomId, idx, true)', at));
    assert.match(body, /roomType === 'sng' && target\)[^\n]*return/, '必须在离座之前拦住');
});

// ───────── 验证码 ─────────
test('🔴 邮箱验证码输错有次数上限，四个校验入口都走同一个闸；生成用 crypto', () => {
    const src = codeOf(read('src/http/register-auth-routes.js'));
    assert.match(src, /MAX_CODE_TRIES\s*=\s*[3-9]\b/);
    assert.equal((src.match(/return wrongCode\(/g) || []).length, 4, '注册 / 找回密码 / 绑邮箱 / 游客保存账号 四处都要计错');
    assert.doesNotMatch(src, /k: 'codeWrong' \}\);\s*\n\s*(try|const hash|const existing)/, '不能还有直接返回「验证码错误」而不计数的校验');
    assert.match(src, /gen6 = \(\) => String\(crypto\.randomInt\(100000, 1000000\)\)/);
    assert.doesNotMatch(src, /Math\.random/);
});

// ───────── 客户端 ─────────
test('🔴 重连失败不等于登录失效：还会自己重连时只显示「重连中」，不清令牌', () => {
    const src = codeOf(read('public/js/20-socket.js'));
    const at = src.indexOf("socket.on('connect_error'");
    const body = src.slice(at, at + 400);
    assert.ok(body.indexOf('socket.active') > 0 && body.indexOf('socket.active') < body.indexOf("removeItem('token')"),
        '必须先判 socket.active 再决定要不要清令牌');
});

test('确认弹窗被第二个顶掉时，第一个要了结（不能让它的 Promise 永远挂着）', () => {
    const src = codeOf(read('public/js/05-utils.js'));
    const at = src.indexOf('function uiConfirm(');
    // 2026-11-19 起落 null（「没来得及答」，同样是假值）而不是 false：带入审批要分清「被拒」和「被顶掉」
    assert.match(src.slice(at, at + 1200), /if \(_confirmResolve\)[^\n]*prev\(null\)/);
});

// ───────── 运维脚本 ─────────
test('清理每日备份时不许把部署前快照算进保留名额', () => {
    const sh = read('scripts/backup-cron.sh');
    assert.doesNotMatch(sh, /ls -1t "\$DST"\/pokerdojo-\*\.sqlite/, '这个通配会把 pokerdojo-predeploy-* 也数进去');
    assert.match(sh, /pokerdojo-\[0-9\]\*_\[0-9\]\*\.sqlite/);
});
