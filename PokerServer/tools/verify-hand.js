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
// ⚠️ 这个工具和 tools/ 里其它脚本不一样：**它是写在 README 里、给仓库外的人用的**，
//    而 README 有英文版。所以这里是全项目 tools/ 中唯一做了双语的脚本 ——
//    用英文 README 的人跑出一屏中文，等于这份说明书只写了一半。
//
// 用法：
//   node tools/verify-hand.js <hand.json>
//   node tools/verify-hand.js -            # 从标准输入读
//   node tools/verify-hand.js <file> --en  # 英文输出（默认中文）
//
// 退出码：0 = 验证通过；1 = 验证失败（有问题）；2 = 用法/数据不对。

const fs = require('fs');
const path = require('path');
const { commitOf, shuffledOrder } = require(path.join(__dirname, '../src/games/poker/provably-fair'));

const EN = process.argv.includes('--en');
const T = (zh, en) => (EN ? en : zh);

// 与 PokerLogic 的 Deck.reset() 完全一致的初始顺序。
// 【必须和它一字不差】——重放的起点错了，后面全错。
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const ORDERED = [];
for (const s of SUITS) for (const r of RANKS) ORDERED.push(r + s[0]);

function fail(msg) {
    console.error(T('用法错误：', 'Usage error: ') + msg);
    process.exit(2);
}

function readInput() {
    const arg = process.argv.slice(2).find(a => a !== '--en');
    if (!arg) {
        fail(T('请给出牌谱 JSON 文件，或用 - 从标准输入读',
            'pass a hand-history JSON file, or - to read from stdin'));
    }
    const text = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
    try {
        return JSON.parse(text);
    } catch (e) {
        fail(T('不是合法的 JSON：', 'not valid JSON: ') + e.message);
    }
}

function verify(hand) {
    const out = [];
    const fair = hand.fair;
    if (!fair) {
        console.log(T('这手牌没有公平性数据（2026-09-16 之前打的牌没有，属正常）。',
            'This hand has no fairness data (hands played before 2026-09-16 do not have it).'));
        process.exit(2);
    }
    const { commit, serverSeed, clientSeed, nonce, deckOrder } = fair;

    // ① 承诺：开局前公布的 commit 必须就是这个种子的 SHA-256。
    //    这一条成立，就说明服务器【在发牌之前】已经把整副牌定死了。
    const recomputed = commitOf(serverSeed);
    const commitOk = recomputed === commit;
    out.push([
        T('承诺对得上种子（SHA-256）', 'Commitment matches the revealed seed (SHA-256)'),
        commitOk,
        commitOk
            ? String(commit).slice(0, 16) + '…'
            : T('算出来是 ', 'computed ') + recomputed.slice(0, 16) + '…'
              + T('，公布的是 ', ', published ') + String(commit).slice(0, 16) + '…',
    ]);

    // ② 牌序：用三要素重新洗一遍，必须和当时记录的牌序一模一样。
    const replay = shuffledOrder(ORDERED, { serverSeed, clientSeed, nonce });
    const orderOk = Array.isArray(deckOrder) && deckOrder.length === replay.length
        && replay.every((c, i) => c === deckOrder[i]);
    out.push([
        T('重新洗牌得到同样的牌序', 'Re-shuffling reproduces the recorded deck order'),
        orderOk,
        orderOk ? replay.slice(0, 5).join(' ') + ' …'
            : T('重放结果与记录不符', 'replayed order does not match the record'),
    ]);

    // ③ 最要紧的一条：记录下来的牌序，能不能解释【你当时真的看到的那些牌】。
    //    ①② 只证明「服务器没换过种子」，③ 才证明「这副牌就是发到你手上的那副」。
    const seats = Array.isArray(hand.seats) ? hand.seats : [];
    const problems = [];
    seats.forEach((s, i) => {
        const expect = [replay[2 * i], replay[2 * i + 1]];
        const actual = Array.isArray(s.hole) ? s.hole : null;
        if (!actual) return;                       // 没记底牌（观战者等）就跳过
        if (actual[0] !== expect[0] || actual[1] !== expect[1]) {
            problems.push(T('座位 ', 'seat ') + (s.seat ?? i) + ' (' + (s.username || '?') + ')'
                + T('记录是 ', ' recorded ') + actual.join(' ')
                + T('，按牌序应当是 ', ', deck order says ') + expect.join(' '));
        }
    });
    const base = 2 * seats.length;
    // 发牌顺序与 hand-service 一致：每人两张 → 烧一张 → 翻牌 3 张 → 烧 → 转牌 → 烧 → 河牌
    const expectedBoard = [replay[base + 1], replay[base + 2], replay[base + 3],
        replay[base + 5], replay[base + 7]];
    const board = Array.isArray(hand.community) ? hand.community : [];
    board.forEach((c, i) => {
        if (c !== expectedBoard[i]) {
            problems.push(T('公共牌第 ', 'board card ') + (i + 1)
                + T(' 张记录是 ', ' recorded ') + c
                + T('，按牌序应当是 ', ', deck order says ') + expectedBoard[i]);
        }
    });
    const dealOk = problems.length === 0;
    out.push([
        T('发到手里的牌与牌序一致', 'The cards you saw match that deck order'),
        dealOk,
        dealOk
            ? seats.length + T(' 家底牌 + ', ' hands + ') + board.length
              + T(' 张公共牌全部对得上', ' board cards all match')
            : problems.join('; '),
    ]);

    return { out, ok: commitOk && orderOk && dealOk };
}

const hand = readInput();
console.log('');
console.log('  ' + T('房间 ', 'Room ') + (hand.roomId || '?')
    + T(' · 第 ', ' · hand #') + (hand.handSeq ?? '?') + T(' 手', '')
    + (hand.ts
        ? ' · ' + new Date(hand.ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)'
        : ''));
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
    console.log('  ✅ ' + T(
        '这手牌通过验证：牌序在发牌之前就已被锁定，且与你看到的牌完全一致。',
        'Verified: the deck was locked in before the deal and matches exactly what you saw.'));
} else {
    console.log('  ❌ ' + T(
        '验证不通过。请把这份牌谱和这段输出一起反馈。',
        'Verification FAILED. Please report this hand record together with this output.'));
}
console.log('');
process.exit(ok ? 0 : 1);
