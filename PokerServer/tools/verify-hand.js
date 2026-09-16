#!/usr/bin/env node
'use strict';

// 牌局公平性离线验算器（2026-09-16）。
//
// 这个脚本是【可验证公平】里真正对玩家有意义的那一半：
// 光在服务器上说「我们是公平的」没有任何说服力 —— 得让人**自己能算一遍**。
//
// 它只依赖标准 SHA-256/HMAC，不连服务器、不查数据库、也不需要信任本仓库的其它代码。
// 任何人都可以照着 provably-fair.js 里那几十行用别的语言重写一份，结论应当完全一致。
//
// 用法：
//   node tools/verify-hand.js <牌谱文件.json>
//   node tools/verify-hand.js -              # 从标准输入读
// 牌谱 JSON 从「牌谱回顾」里导出，或管理员 GET /api/admin/hands/<用户名> 拿到。
//
// 退出码：0 = 验证通过；1 = 验证失败（有问题）；2 = 用法/数据不对。

const fs = require('fs');
const path = require('path');
const { commitOf, shuffledOrder } = require(path.join(__dirname, '../src/games/poker/provably-fair'));

// 与 PokerLogic 的 Deck.reset() 完全一致的初始顺序。
// 【必须和它一字不差】——重放的起点错了，后面全错。
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const ORDERED = [];
for (const s of SUITS) for (const r of RANKS) ORDERED.push(r + s[0]);

function fail(msg) { console.error('用法错误：' + msg); process.exit(2); }

function readInput() {
    const arg = process.argv[2];
    if (!arg) fail('请给出牌谱 JSON 文件，或用 - 从标准输入读');
    const text = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
    try { return JSON.parse(text); } catch (e) { fail('不是合法的 JSON：' + e.message); }
}

function verify(hand) {
    const out = [];
    const fair = hand.fair;
    if (!fair) {
        console.log('这手牌没有公平性数据（2026-09-16 之前打的牌没有，属正常）。');
        process.exit(2);
    }
    const { commit, serverSeed, clientSeed, nonce, deckOrder } = fair;

    // ① 承诺：开局前公布的 commit 必须就是这个种子的 SHA-256。
    //    这一条成立，就说明服务器【在发牌之前】已经把整副牌定死了。
    const recomputed = commitOf(serverSeed);
    const commitOk = recomputed === commit;
    out.push(['承诺对得上种子（SHA-256）', commitOk,
        commitOk ? commit.slice(0, 16) + '…' : '算出来是 ' + recomputed.slice(0, 16) + '…，公布的是 ' + String(commit).slice(0, 16) + '…']);

    // ② 牌序：用三要素重新洗一遍，必须和当时记录的牌序一模一样。
    const replay = shuffledOrder(ORDERED, { serverSeed, clientSeed, nonce });
    const orderOk = Array.isArray(deckOrder) && deckOrder.length === replay.length
        && replay.every((c, i) => c === deckOrder[i]);
    out.push(['重新洗牌得到同样的牌序', orderOk,
        orderOk ? replay.slice(0, 5).join(' ') + ' …' : '重放结果与记录不符']);

    // ③ 最要紧的一条：记录下来的牌序，能不能解释【你当时真的看到的那些牌】。
    //    ①② 只证明「服务器没换过种子」，③ 才证明「这副牌就是发到你手上的那副」。
    const seats = Array.isArray(hand.seats) ? hand.seats : [];
    const problems = [];
    seats.forEach((s, i) => {
        const expect = [replay[2 * i], replay[2 * i + 1]];
        const actual = Array.isArray(s.hole) ? s.hole : null;
        if (!actual) return;                       // 没记底牌（观战者等）就跳过
        if (actual[0] !== expect[0] || actual[1] !== expect[1]) {
            problems.push('座位 ' + (s.seat ?? i) + '（' + (s.username || '?') + '）记录是 '
                + actual.join(' ') + '，按牌序应当是 ' + expect.join(' '));
        }
    });
    const base = 2 * seats.length;
    // 发牌顺序与 hand-service 一致：每人两张 → 烧一张 → 翻牌 3 张 → 烧 → 转牌 → 烧 → 河牌
    const expectedBoard = [replay[base + 1], replay[base + 2], replay[base + 3],
        replay[base + 5], replay[base + 7]];
    const board = Array.isArray(hand.community) ? hand.community : [];
    board.forEach((c, i) => {
        if (c !== expectedBoard[i]) {
            problems.push('公共牌第 ' + (i + 1) + ' 张记录是 ' + c + '，按牌序应当是 ' + expectedBoard[i]);
        }
    });
    const dealOk = problems.length === 0;
    out.push(['发到手里的牌与牌序一致', dealOk,
        dealOk ? (seats.length + ' 家底牌 + ' + board.length + ' 张公共牌全部对得上') : problems.join('；')]);

    return { out, ok: commitOk && orderOk && dealOk };
}

const hand = readInput();
console.log('');
console.log('  房间 ' + (hand.roomId || '?') + ' · 第 ' + (hand.handSeq ?? '?') + ' 手'
    + (hand.ts ? ' · ' + new Date(hand.ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)' : ''));
console.log('  clientSeed = ' + JSON.stringify(hand.fair && hand.fair.clientSeed)
    + '   nonce = ' + (hand.fair && hand.fair.nonce));
console.log('');
const { out, ok } = verify(hand);
for (const [label, pass, detail] of out) {
    console.log('  ' + (pass ? 'OK  ' : 'FAIL') + '  ' + label);
    console.log('        ' + detail);
}
console.log('');
if (ok) {
    console.log('  ✅ 这手牌通过验证：牌序在发牌之前就已被锁定，且与你看到的牌完全一致。');
} else {
    console.log('  ❌ 验证不通过。请把这份牌谱和这段输出一起反馈。');
}
console.log('');
process.exit(ok ? 0 : 1);
