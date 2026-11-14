'use strict';
// 钱包账本核对（2026-11-14 加，每天随筹码守恒审计一起跑）。
//
// 筹码守恒审计看的是【牌谱】：单手内筹码有没有凭空出现。它看不到牌谱之外的钱 ——
// 入座扣款、退款、补码、奖金、签到、管理员补偿，全都只在钱包流水里。
// 这次全量排查查出的 SNG「退出再进来免费入座」就属于这一类：筹码守恒，金币却多出来了。
//
// 这里核对三件事（每个用户的流水按写入顺序排）：
//   ① 每一笔：余额变动前 + 变动 = 变动后
//   ② 相邻两笔首尾相接：这一笔的「变动前」= 上一笔的「变动后」（中间没有绕过账本改余额）
//   ③ 最后一笔的「变动后」= 用户当前余额
// 任何一条不成立，就是有人在账本之外动过金币。它抓不到漏洞本身，但凡是有人靠漏洞多拿了钱，第二天就会知道。
//
// ⚠️ 必须按 rowid（写入顺序）排，不能按 id：id 是 UUID，按它排是乱序 ——
//    第一次手动核对时就因为这个报出了 59 个「对不上」，其实一个都没错。

function checkWalletLedger(db) {
    const users = new Map(db.prepare('SELECT id, username, gold FROM users').all().map(u => [u.id, u]));
    const problems = [];
    const seen = new Set();
    let prev = null;
    const flush = () => {
        if (!prev) return;
        const u = users.get(prev.user_id);
        if (u && prev.balance_after !== u.gold) {
            problems.push({ username: u.username, kind: 'balance', detail: `流水最后一笔余额 ${prev.balance_after}，账户实际 ${u.gold}（差 ${u.gold - prev.balance_after}）` });
        }
    };
    const rows = db.prepare(`
        SELECT rowid AS rid, user_id, delta, balance_before, balance_after, transaction_type, created_at_ms
        FROM wallet_transactions ORDER BY user_id, rowid
    `).iterate();
    for (const t of rows) {
        if (!prev || prev.user_id !== t.user_id) { flush(); prev = null; seen.add(t.user_id); }
        const name = users.get(t.user_id)?.username || t.user_id;
        if (t.balance_before + t.delta !== t.balance_after) {
            problems.push({ username: name, kind: 'arithmetic', detail: `${t.transaction_type}：${t.balance_before} + ${t.delta} ≠ ${t.balance_after}` });
        }
        if (prev && t.balance_before !== prev.balance_after) {
            problems.push({ username: name, kind: 'gap', detail: `${new Date(t.created_at_ms).toISOString()} ${t.transaction_type} 之前余额 ${t.balance_before}，上一笔之后是 ${prev.balance_after}（账本外变动 ${t.balance_before - prev.balance_after}）` });
        }
        prev = t;
    }
    flush();
    for (const u of users.values()) {
        if (!seen.has(u.id) && u.gold !== 0) problems.push({ username: u.username, kind: 'no-ledger', detail: `没有任何流水，余额却是 ${u.gold}` });
    }
    return { users: users.size, problems };
}

module.exports = { checkWalletLedger };
