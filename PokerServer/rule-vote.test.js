'use strict';
// 现金桌「桌规投票」（2026-11-18）：改盲注 / 7-2 奖励 / Bomb pot 设置 / 下一手 Bomb。
// 最怕的三件事：
//   ① 一手牌中间生效（同一手前后两次行动按两套规则）→ 盲注只在下一手开头换上；7-2 / Bomb 都是开手时读
//   ② 有人没同意也改成了 → 必须【在座每个人】都同意，不是多数
//   ③ 房主绕开投票直接改 → 不许有「直接改」的入口
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rv = require('./src/rooms/rule-vote');
const { proposalNotice, passedNotice } = require('./src/socket/events/rule-vote-events');

const P = (userId, extra = {}) => ({ userId, chips: 1000, ...extra });
function table(players = ['host', 'a', 'b'], extra = {}) {
    return { roomType: 'cash', ownerUserId: 'host', config: { sb: 10, bb: 20, ante: 0, sevenDeuceBB: 0, bombEvery: 0, bombBB: 2 }, players: players.map(id => P(id)), ...extra };
}
const T0 = 1_000_000;
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

test('盲注范围和建房时一致：大盲 20–1000、小盲 10 到大盲、前注 0–80，必须是整数', () => {
    assert.deepEqual(rv.validateBlinds({ sb: 25, bb: 50 }), { sb: 25, bb: 50, ante: 0 });
    assert.deepEqual(rv.validateBlinds({ sb: '25', bb: '50', ante: '5' }), { sb: 25, bb: 50, ante: 5 });
    for (const bad of [{ sb: 10, bb: 20.5 }, { sb: 5, bb: 20 }, { sb: 30, bb: 20 }, { sb: 10, bb: 2000 }, { sb: 10, bb: 20, ante: 90 }, { sb: 10, bb: 20, ante: -1 }, {}, null])
        assert.equal(rv.validateBlinds(bad), null, JSON.stringify(bad));
});

test('🔴 必须在座每个人都同意：两人同意、一人还没表态 → 还不生效；有人不同意 → 作废', () => {
    for (const [kind, input, check] of [
        ['blinds', { sb: 25, bb: 50 }, g => g.pendingBlinds],
        ['sevenDeuce', { bb: 2 }, g => g.config.sevenDeuceBB],
        ['bomb', { every: 10 }, g => g.config.bombEvery],
        ['bombNext', {}, g => g.nextBomb],
    ]) {
        const g = table(['host', 'a', 'b']);
        const r = rv.propose(g, 'host', kind, input, T0);
        assert.equal(r.result, 'pending', kind);
        assert.deepEqual(r.vote.agreed, ['host'], '房主提议即算同意');
        assert.equal(rv.respond(g, 'a', true, T0 + 1).result, 'pending');
        assert.ok(!check(g), `${kind}：还差 b，不能生效`);
        assert.equal(rv.respond(g, 'b', false, T0 + 2).result, 'rejected');
        assert.ok(!check(g), `${kind}：有人不同意，没改`);
        assert.equal(g.ruleVote, null);
    }
});

test('🔴 盲注：全员同意后只记「下一手起」，开下一手时才换上', () => {
    const g = table(['host', 'a']);
    rv.propose(g, 'host', 'blinds', { sb: 25, bb: 50, ante: 5 }, T0);
    assert.equal(rv.respond(g, 'a', true, T0 + 1).result, 'passed');
    assert.deepEqual(g.pendingBlinds, { sb: 25, bb: 50, ante: 5 });
    assert.equal(g.config.bb, 20, '一手牌中间绝不改');
    assert.deepEqual(rv.applyPendingBlinds(g), { sb: 25, bb: 50, ante: 5 });
    assert.deepEqual([g.config.sb, g.config.bb, g.config.ante], [25, 50, 5]);
    assert.equal(rv.applyPendingBlinds(g), null, '只换一次');
});

test('🔴 开新一手时，先换盲注、再按盲注开局（顺序反了这一手就还是旧盲注）', () => {
    const src = read('src/games/poker/hand-service.js');
    const start = src.indexOf('function startHand(');
    const body = src.slice(start, start + 2000);
    const apply = body.indexOf('applyPendingBlinds(game)'), readBB = body.indexOf('const BB = gameBB(game), SB = gameSB(game);');
    assert.ok(apply > 0 && readBB > apply, '换盲注必须在读盲注之前');
    assert.ok(body.indexOf('if (game.paused || game.timeExpired)') < apply, '暂停中不开局的话，新盲注留到真正开局那一手');
});

test('7-2 / Bomb：通过后改的是 config（它们本来就是开手时才读的，所以只影响下一手）', () => {
    const g = table(['host', 'a']);
    rv.propose(g, 'host', 'sevenDeuce', { bb: 5 }, T0); rv.respond(g, 'a', true, T0 + 1);
    assert.equal(g.config.sevenDeuceBB, 5);
    rv.propose(g, 'host', 'bomb', { every: 5 }, T0 + 2); rv.respond(g, 'a', true, T0 + 3);
    assert.deepEqual([g.config.bombEvery, g.config.bombBB], [5, 2], '只改频率时金额沿用现在的');
    rv.propose(g, 'host', 'bomb', { bb: 10 }, T0 + 4); rv.respond(g, 'a', true, T0 + 5);
    assert.deepEqual([g.config.bombEvery, g.config.bombBB], [5, 10], '只改金额时频率沿用现在的（不能被清回 0）');
    rv.propose(g, 'host', 'bombNext', {}, T0 + 6); rv.respond(g, 'a', true, T0 + 7);
    assert.equal(g.nextBomb, true);
});

test('每种提议只认规定的取值：7-2 关/1/2/5BB、Bomb 频率 关/5/10/20、Bomb 每人 2/5/10BB', () => {
    const g = table(['host', 'a']);
    assert.equal(rv.propose(g, 'host', 'sevenDeuce', { bb: 3 }, T0).reason, 'bad');
    assert.equal(rv.propose(g, 'host', 'bomb', { every: 7 }, T0).reason, 'bad');
    assert.equal(rv.propose(g, 'host', 'bomb', { bb: 1 }, T0).reason, 'bad', '1BB 已经不是选项（用户改成 2 / 5 / 10）');
    assert.equal(rv.propose(g, 'host', 'nonsense', {}, T0).reason, 'bad');
    assert.equal(rv.propose(g, 'host', 'blinds', { sb: 1, bb: 2 }, T0).reason, 'badBlinds');
    assert.deepEqual(rv.BOMB_BB, [2, 5, 10]);
});

test('只有房主、只在现金桌、同一时间只有一个提议、和现在一样的不用投', () => {
    const g = table();
    assert.equal(rv.propose(g, 'a', 'blinds', { sb: 25, bb: 50 }, T0).reason, 'notOwner');
    assert.equal(rv.propose({ ...table(), roomType: 'sng' }, 'host', 'sevenDeuce', { bb: 2 }, T0).reason, 'notCash');
    assert.equal(rv.propose(g, 'host', 'blinds', { sb: 10, bb: 20 }, T0).reason, 'same');
    assert.equal(rv.propose(g, 'host', 'sevenDeuce', { bb: 0 }, T0).reason, 'same');
    assert.equal(rv.propose(g, 'host', 'bomb', { every: 0, bb: 2 }, T0).reason, 'same');
    assert.equal(rv.propose({ ...table(), nextBomb: true }, 'host', 'bombNext', {}, T0).reason, 'same');
    assert.equal(rv.propose(g, 'host', 'sevenDeuce', { bb: 2 }, T0).result, 'pending');
    assert.equal(rv.propose(g, 'host', 'blinds', { sb: 25, bb: 50 }, T0 + 1).reason, 'busy', '一次只能有一个提议，不管是哪一种');
    assert.equal(rv.respond(g, 'stranger', true, T0 + 2).reason, 'notVoter', '观战的人没有投票权');
});

test('超过 30 秒没凑齐就作废；作废后可以重新提议（服务器重启丢了计时器也一样）', () => {
    const g = table(['host', 'a']);
    rv.propose(g, 'host', 'sevenDeuce', { bb: 2 }, T0);
    assert.equal(rv.respond(g, 'a', true, T0 + rv.VOTE_MS + 1).reason, 'gone', '过期后的同意不算');
    assert.equal(g.config.sevenDeuceBB, 0);
    assert.equal(rv.propose(g, 'host', 'sevenDeuce', { bb: 2 }, T0 + rv.VOTE_MS + 2).result, 'pending', '不会被一个过期的提议一直挡住');
});

test('投票期间有人离座：剩下的人表态时只按还在座的人算', () => {
    // 已知边角（不修）：离座的正好是最后一个没表态的、其余人又都已同意时，没人再触发判定，要等 30 秒作废。
    const g = table(['host', 'a', 'b']);
    rv.propose(g, 'host', 'bombNext', {}, T0);
    g.players = g.players.filter(p => p.userId !== 'b');
    assert.equal(rv.respond(g, 'a', true, T0 + 1).result, 'passed');
});

test('桌上只有房主一个人：不用问别人，直接生效', () => {
    const g = table(['host']);
    assert.equal(rv.propose(g, 'host', 'bomb', { every: 5 }, T0).result, 'passed');
    assert.equal(g.config.bombEvery, 5);
});

test('🔴 投票状态能进快照：game 上不挂计时器（Timeout 有循环引用，JSON.stringify 会抛错）', () => {
    const g = table(['host', 'a']);
    rv.propose(g, 'host', 'blinds', { sb: 25, bb: 50 }, T0);
    assert.doesNotThrow(() => JSON.stringify(g));
    assert.doesNotMatch(read('src/socket/events/rule-vote-events.js'), /game\.\w*[Tt]imer\s*=/, '计时器放在模块里的 Map，不放 game 上');
});

test('🔴 房主没有「直接改」7-2 / Bomb 的入口：只能走投票', () => {
    const all = fs.readdirSync(path.join(__dirname, 'src/socket/events')).map(f => read('src/socket/events/' + f)).join('\n');
    assert.doesNotMatch(all, /socket\.on\('set_seven_deuce'/);
    assert.doesNotMatch(all, /socket\.on\('set_bomb_pot'/);
    const client = read('public/js/30-room.js');
    assert.doesNotMatch(client, /emit\('set_seven_deuce'|emit\('set_bomb_pot'/);
});

test('桌面提示：每种提议 / 结果都有中英文，占位符都由服务端发出', () => {
    const dict = read('public/js/03-i18n.js');
    const cases = [];
    for (const [kind, v] of [['blinds', { sb: 25, bb: 50, ante: 5 }], ['sevenDeuce', { bb: 2 }], ['sevenDeuce', { bb: 0 }], ['bomb', { every: 10, bb: 5 }], ['bomb', { every: 0, bb: 5 }], ['bombNext', { bb: 2 }]]) {
        cases.push(proposalNotice('Sam', kind, v), passedNotice(kind, v));
    }
    for (const n of cases) {
        assert.equal(dict.split(`'srv.${n.k}'`).length - 1, 2, `srv.${n.k} 中英各一份`);
        const m = dict.match(new RegExp(`'srv\\.${n.k.replace(/\./g, '\\.')}': '([^']*)'`));
        for (const ph of (m[1].match(/\{(\w+)\}/g) || [])) assert.ok(n.p && ph.slice(1, -1) in n.p, `srv.${n.k} 的 ${ph} 服务端要发`);
    }
    for (const reason of ['notOwner', 'notCash', 'busy', 'bad', 'badBlinds', 'same', 'gone'])
        assert.equal(dict.split(`'srv.rule.${reason}'`).length - 1, 2, `srv.rule.${reason} 中英各一份`);
});
