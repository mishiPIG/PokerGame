'use strict';
// SNG 按名次发奖（2026-11-18 用户定）。原来不管几个人开都是冠军一个人拿走整个奖池。
// 抽水先从奖池里扣（× 10/11），剩下的：2 人冠军全拿 / 3 人 2:1（亚军拿回自己那份）/ 4–6 人 65:35 / 7–9 人 50:30:20。
// 同一手里几个人一起出局：开手筹码少的名次靠后；开手筹码一样多则那几个名次的奖金平分。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const config = require('./src/config');
const { createMatchResultService } = require('./src/matches/match-result-service');

const TIERS = [110, 220, 550, 1100];

test('分配表：每种人数发几名、各拿多少', () => {
    assert.deepEqual(config.sngPayouts(220, 2), [200]);                 // 2 人：冠军全拿（和原来一样）
    assert.deepEqual(config.sngPayouts(330, 3), [200, 100]);            // 3 人：亚军拿回自己那份
    assert.deepEqual(config.sngPayouts(660, 6), [390, 210]);            // 6 人：65 / 35
    assert.deepEqual(config.sngPayouts(990, 9), [450, 270, 180]);       // 9 人：50 / 30 / 20
    assert.equal(config.sngPayouts(440, 4).length, 2);
    assert.equal(config.sngPayouts(770, 7).length, 3);
});

test('🔴 每种人数、每档报名费：各名次加起来正好等于抽水后的奖池，一分不多一分不少', () => {
    for (const fee of TIERS) for (let n = 2; n <= 9; n++) {
        const pool = fee * n;
        const amounts = config.sngPayouts(pool, n);
        assert.equal(amounts.reduce((a, b) => a + b, 0), config.sngPrize(pool), `${fee} × ${n}`);
        for (let i = 1; i < amounts.length; i++) assert.ok(amounts[i - 1] >= amounts[i], `名次越靠前拿得越多：${fee} × ${n}`);
        assert.ok(amounts.every(a => a > 0));
    }
});

test('报名人数从奖池算（开赛前退出的已经退掉了）', () => {
    assert.equal(config.sngEntrants({ prizePool: 3300, config: { buyIn: 1100 }, players: [{}, {}] }), 3, '出局的人不在座位上，但报了名');
    assert.equal(config.sngEntrants({ prizePool: 2200, config: { buyIn: 1100 }, players: [{}, {}, {}] }), 2);
});

test('🔴 建房表单显示的奖金和服务端发的完全一样（客户端那份只用来显示）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'public/js/30-room.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function sngPayoutsView');
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fn + '\n;this.view = sngPayoutsView;', ctx);
    for (const fee of TIERS) for (let n = 2; n <= 9; n++) {
        assert.deepEqual([...ctx.view(fee, n)], config.sngPayouts(fee * n, n), `${fee} × ${n}`);
    }
});

// ───────────── 排名 ─────────────
function ranking(game, winnerId) {
    const svc = createMatchResultService({ io: { in: () => ({ emit() {} }) }, db: { getUserById: () => null }, roomGames: { r: game } });
    return svc.buildRanking(game, winnerId, config.sngPayouts(game.prizePool, config.sngEntrants(game)));
}
const P = (userId, chips, handStartChips, handStartSeq = 9) => ({ userId, username: userId, chips, handStartChips, handStartSeq, handsPlayed: 5 });

test('名次 = 冠军 → 最后出局的 → 最早出局的；每一名带奖金，净盈亏 = 奖金 − 报名费', () => {
    // 6 人：f 第 3 手出局、e 第 5 手、d 第 7 手、c 第 8 手；最后一手 b 输给 a
    const game = {
        roomType: 'sng', prizePool: 660, config: { buyIn: 110 },
        players: [P('a', 6600, 4000), P('b', 0, 2600)],
        statsHistory: ['f', 'e', 'd', 'c'].map((u, i) => ({ userId: u, username: u, handsPlayed: 3, bustSeq: 3 + i * 2, startChips: 500 })),
    };
    const r = ranking(game, 'a');
    assert.deepEqual(r.map(x => x.userId), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(r.map(x => x.prize), [390, 210, 0, 0, 0, 0]);
    assert.deepEqual(r.map(x => x.net), [280, 100, -110, -110, -110, -110]);
});

test('🔴 最后一手两个人一起出局：开手筹码少的名次靠后（拿不到亚军）', () => {
    // 3 人，最后一手 a 同时打掉 b、c；b 开手 3000、c 开手 1000 → b 亚军
    const game = { roomType: 'sng', prizePool: 330, config: { buyIn: 110 }, players: [P('a', 9000, 5000), P('c', 0, 1000), P('b', 0, 3000)] };
    const r = ranking(game, 'a');
    assert.deepEqual(r.map(x => x.userId), ['a', 'b', 'c']);
    assert.deepEqual(r.map(x => x.prize), [200, 100, 0]);
});

test('🔴 开手筹码一模一样、同一手出局：分不出先后，那几个名次的奖金平分', () => {
    const game = { roomType: 'sng', prizePool: 330, config: { buyIn: 110 }, players: [P('a', 9000, 5000), P('b', 0, 2000), P('c', 0, 2000)] };
    const r = ranking(game, 'a');
    assert.equal(r[0].prize, 200);
    assert.equal(r[1].prize, 50);
    assert.equal(r[2].prize, 50);
    assert.equal(r.reduce((s, x) => s + x.prize, 0), 300, '平分之后总数不变');
});

test('🔴 中途同一手淘汰两人：淘汰顺序按开手筹码从少到多记（不再按座位）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'src/rooms/seat-service.js'), 'utf8');
    const fn = src.slice(src.indexOf('function removeBustedPlayers'), src.indexOf('for (let i = game.players.length - 1', src.indexOf('function removeBustedPlayers')));
    assert.match(fn, /\.sort\(\(a, b\) => \(a\.handStartChips \|\| 0\) - \(b\.handStartChips \|\| 0\)\)\s*\.forEach\(p => \{ p\.bustSeq = p\.handStartSeq; recordLeft\(game, p\); \}\)/);
    // 记进淘汰顺序的必须带上「哪一手、开手多少筹码」—— 平分判定要用
    const ms = fs.readFileSync(path.join(__dirname, 'src/matches/match-result-service.js'), 'utf8');
    assert.match(ms, /bustSeq: p\.bustSeq \?\? null, startChips: p\.handStartChips \?\? null/);
    const hs = fs.readFileSync(path.join(__dirname, 'src/games/poker/hand-service.js'), 'utf8');
    assert.match(hs, /p\.handStartChips = p\.chips \+ p\.currentBet \+ \(p\.committed \|\| 0\);/);
});

test('结算：自然结束和开赛后解散都按名次发，钱包每人一笔、同一场同一人只发一次', () => {
    const src = fs.readFileSync(path.join(__dirname, 'src/matches/sng-match-service.js'), 'utf8');
    assert.match(src, /operationKey: `sng-prize:\$\{game\.matchId\}:\$\{r\.userId\}`/);
    const end = src.slice(src.indexOf('function maybeEndSNG'), src.indexOf('function restoreDissolveTimer'));
    assert.match(end, /sngPayouts\(game\.prizePool, sngEntrants\(game\)\)/);
    assert.match(end, /settleSngPlaces\(roomId, game, ranking, null\)/);
    const dis = src.slice(src.indexOf('function dissolveSngRoom'), src.indexOf('function settleSngPlaces'));
    assert.match(dis, /settleSngPlaces\(roomId, game, ranking, 'owner_dissolve'\)/);
});
