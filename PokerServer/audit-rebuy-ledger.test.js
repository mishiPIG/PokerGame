'use strict';

// 审计的「补码判定」回归测试。
//
// 背景：牌谱 seats 里没有 buyIn 字段，光看牌谱无法区分「补码」与「凭空多出来的筹码」，
// 旧实现只能靠「正向整百」的启发式猜 —— 一笔正好是整百的凭空筹码就会被当成补码放过。
// 现在优先查钱包账本（transaction_type='cash_rebuy'，有真金白银的扣款才算补码）。
// 2026-08-09 线上那两手 aaaaronx「白拿筹码」（补码幂等键复用导致金币没扣但筹码照给）
// 就是启发式放过、查账本才抓到的。
//
// 另含 ante 用例：前注是发牌前直接扣的、不是一个 action，contributions() 必须单独补，
// 否则补码差额会从 10,000 变成 9,990（不再整百）→ 合法补码被误报成凭空造币。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const root = __dirname;
const MATCH = 'match-test';
const ALICE = 'u-alice';
const BOB = 'u-bob';

// 一手两人局：两家各交 ante → alice 下注 1000、bob 跟注后在翻牌弃牌 → alice 赢下底池。
// ⚠️ 底池必须把前注还给赢家，否则 fixture 自己就不守恒（前注凭空蒸发），
//    审计会如实报出来——第一版就是这么写错的，反而验证了工具是对的。
//    alice = 10000 − ante − 1000 + (2000 + 2×ante) = 11000 + ante
//    bob   = 10000 − ante − 1000                   =  9000 − ante   → 合计恒为 20000
function makeHand({ seq, ts, extraChips = 0, ante = 0 }) {
    const pot = 2000 + 2 * ante;
    return {
        ts, completedAt: ts + 20000, matchId: MATCH, roomId: '999999', mode: 'cash',
        handSeq: seq, sb: 10, bb: 20, ante,
        seats: [
            { userId: ALICE, username: 'alice', seat: 0, startChips: 10000, hole: ['AS', 'KS'] },
            { userId: BOB, username: 'bob', seat: 1, startChips: 10000, hole: ['2C', '7D'] }
        ],
        actions: [
            { userId: ALICE, street: 'preflop', action: 'bet', amount: 1000 },
            { userId: BOB, street: 'preflop', action: 'call', amount: 1000 },
            { userId: BOB, street: 'flop', action: 'fold', amount: 0 }
        ],
        community: ['3D', '8H', 'JC'],
        results: [
            { userId: ALICE, endChips: 11000 + ante + extraChips, won: pot },
            { userId: BOB, endChips: 9000 - ante, won: 0 }
        ]
    };
}

function buildFixture(dir, rows) {
    const file = path.join(dir, 'fixture.sqlite');
    const db = new Database(file);
    db.exec(`CREATE TABLE hands(id TEXT PRIMARY KEY, room_code TEXT, started_at_ms INTEGER, payload_json TEXT);
             CREATE TABLE wallet_transactions(id TEXT PRIMARY KEY, user_id TEXT, delta INTEGER,
               transaction_type TEXT, match_id TEXT, operation_key TEXT, metadata_json TEXT, created_at_ms INTEGER);`);
    const insertHand = db.prepare('INSERT INTO hands VALUES(?,?,?,?)');
    const insertTx = db.prepare('INSERT INTO wallet_transactions VALUES(?,?,?,?,?,?,?,?)');
    for (const row of rows) {
        insertHand.run('h' + row.hand.handSeq, '999999', row.hand.ts, JSON.stringify(row.hand));
        if (row.ledgerChips) {
            insertTx.run('t' + row.hand.handSeq, ALICE, -550, 'cash_rebuy', MATCH,
                `cash-rebuy:${MATCH}:${ALICE}:${row.hand.handSeq}`,
                JSON.stringify({ chips: row.ledgerChips }), row.hand.ts + 5000);
        }
    }
    db.close();
    return file;
}

function runAudit(file) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools/audit-chips.js'), '--db', file, '--days', '3650'],
        { encoding: 'utf8', cwd: root });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function withFixture(rows, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-audit-ledger-'));
    try { fn(runAudit(buildFixture(dir, rows))); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const base = Date.now() - 3600000;

test('有钱包流水的补码判为合法，没有流水的凭空筹码一律报警（含正好整百的）', () => {
    withFixture([
        { hand: makeHand({ seq: 1, ts: base, extraChips: 5000 }), ledgerChips: 5000 },          // 真补码
        { hand: makeHand({ seq: 2, ts: base + 60000, extraChips: 5000 }) },                     // 凭空 5,000（整百）
        { hand: makeHand({ seq: 3, ts: base + 120000, extraChips: 777 }) },                     // 凭空 777
        { hand: makeHand({ seq: 4, ts: base + 180000 }) }                                       // 正常
    ], ({ status, out }) => {
        assert.equal(status, 1, '有凭空筹码时退出码必须是 1（cron 靠它发告警）');
        assert.match(out, /合法的手中补码 1 处/);
        assert.match(out, /发现 2 处异常/);
        assert.match(out, /seq 2\b/, '整百的凭空筹码必须报出——这正是旧启发式放过的那一类');
        assert.match(out, /seq 3\b/);
        assert.doesNotMatch(out, /seq 4\b/, '守恒的正常牌局不该出现在报告里');
        assert.match(out, /查钱包账本（权威）/);
    });
});

test('开了 ante 的桌上，合法补码不被误报（前注不是 action，必须单独补进投入）', () => {
    // ⚠️ 必须走【启发式】路径才测得到这一条：带账本时判定只看 delta 与流水金额，
    //    根本不经过 contributions()，撤掉 ante 补正测试照样会过（第一版就是这么写漏的）。
    //    所以这里去掉 matchId/completedAt，模拟查不到账本的老牌谱。
    const hand = makeHand({ seq: 1, ts: base, extraChips: 10000, ante: 10 });
    delete hand.matchId; delete hand.completedAt;
    withFixture([{ hand }], ({ status, out }) => {
        assert.match(out, /回退启发式/, '本用例必须落在启发式路径上，否则测不到 ante 补正');
        assert.match(out, /合法的手中补码 1 处/, 'ante 桌的补码差额是 10,000−ante，不补前注就不再是整百而被误报');
        assert.doesNotMatch(out, /发现 \d+ 处异常/);
        assert.equal(status, 0, '没有异常时退出码必须是 0，否则 cron 天天发假告警');
    });
});

test('没有账本可查时（旧牌谱 / JSONL）回退启发式，不因缺账本就误报', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-audit-legacy-'));
    try {
        // 去掉 matchId/completedAt = 模拟 2026-08-09 之前的老牌谱
        const legacy = makeHand({ seq: 1, ts: base, extraChips: 5000 });
        delete legacy.matchId; delete legacy.completedAt;
        const file = buildFixture(dir, [{ hand: legacy }]);
        const { status, out } = runAudit(file);
        assert.match(out, /合法的手中补码 1 处/, '老牌谱查不到账本，仍应按「正向整百」判为补码');
        assert.match(out, /回退启发式/);
        assert.equal(status, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
