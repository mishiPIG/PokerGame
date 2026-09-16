'use strict';

// 牌谱可见性过滤（2026-09-17）。
//
// 🔴 起因：`/api/my-hands` 一直直接返回整份 `payload_json`，里面有**同桌每个人的底牌**。
//    客户端 UI 会把弃牌者的牌盖上，但**网络响应里是有的** —— 按一下 F12 就全看见了。
//    这不是 1.8.0 引入的（`seats[].hole` 一直都在），但 1.8.0 的可验证公平又加了
//    `fair.serverSeed`：**知道种子就能重算整副牌**，于是通往同一份信息多了第二条路。
//
//    危害是【竞技公平】而不是实时作弊 —— 牌谱只在这手打完之后才落库，
//    所以查不到进行中的那一手。但「你弃牌从没亮过，对手事后能查出你拿的是什么」
//    等于给了他一个免费的 HUD。
//
// ⚖️ 这里有个绕不开的张力：**可验证公平要求公开种子，而种子公开 = 整副牌公开**，
//    包括弃牌者从未亮过的底牌。两件事天然打架。
//    用户 2026-09-17 定的解法是 **A：揭示延到整桌结束**——
//    「这一桌打完了，一切公开」。语义干净，而且不损害可验证性，只是晚一会儿。
//
// 所以规则就两条：
//   · 桌子**还没结束** → 藏起「本来就不该看见」的东西（别人的底牌、牌型、种子、牌序）；
//   · 桌子**已经结束** → 原样返回，随便验。
//
// ⚠️ 「本来就该看见」的判定**刻意和客户端用同一条规则**
//    （`42-replay.js`: `showFace = isMe || (!folded && showdown)`），
//    这样合法查看的显示一个像素都不会变 —— 变的只是「数据还发不发出去」。
//    两边写成两套规则的话，迟早会出现「界面显示了但数据被删了」的怪状。

// 这手牌是不是走到了摊牌：非弃牌者 ≥ 2 人。
// 与客户端同源判定（用 actions 里的 fold，results.folded 作为补充）。
function foldedUserIds(hand) {
    const ids = new Set();
    for (const a of hand.actions || []) if (a && a.action === 'fold') ids.add(a.userId);
    for (const r of hand.results || []) if (r && r.folded) ids.add(r.userId);
    return ids;
}

function wentToShowdown(hand) {
    const folded = foldedUserIds(hand);
    return (hand.seats || []).filter(s => !folded.has(s.userId)).length >= 2;
}

// 这一桌算不算结束了。
// 找不到对应的 match 行 → 当作已结束：那是 SQLite 上线之前的老牌谱，
// 那些桌子早就散了，没有「还在打」这种可能。
function tableEndedFrom(matchRow) {
    if (!matchRow) return true;
    if (matchRow.ended_at_ms) return true;
    return matchRow.status === 'finished' || matchRow.status === 'cancelled';
}

// 按查看者过滤一手牌。**不修改入参**。
function filterHandForViewer(hand, viewerUserId, { tableEnded = false } = {}) {
    if (!hand || typeof hand !== 'object') return hand;
    if (tableEnded) return hand;                 // 桌子散了：一切公开（见上方 A 方案）

    const out = JSON.parse(JSON.stringify(hand));
    const folded = foldedUserIds(out);
    const showdown = wentToShowdown(out);
    const visible = (userId) => userId === viewerUserId || (!folded.has(userId) && showdown);

    out.seats = (out.seats || []).map(s => {
        if (visible(s.userId)) return s;
        const { hole, ...rest } = s;             // eslint-disable-line no-unused-vars
        return rest;                             // 连字段一起去掉，别留个 null 让人猜
    });

    // 牌型名是从底牌算出来的 —— 留着等于把底牌泄露了一半（「他弃的是同花听」）。
    out.results = (out.results || []).map(r => {
        if (visible(r.userId)) return r;
        const { category, ...rest } = r;         // eslint-disable-line no-unused-vars
        return rest;
    });

    // 🔴 种子和牌序：知道种子就能重算整副牌，等于把上面两条过滤全部绕过去。
    //    承诺(commit)/clientSeed/nonce 照发 —— 它们本来就是发牌前公开广播的，
    //    留着才能让玩家确认「事后揭示的那个种子，确实对应当时公布的承诺」。
    if (out.fair) {
        out.fair = {
            commit: out.fair.commit,
            clientSeed: out.fair.clientSeed,
            nonce: out.fair.nonce,
            revealPending: true,                 // 客户端据此提示「本桌结束后可验证」
        };
    }
    return out;
}

module.exports = { filterHandForViewer, tableEndedFrom, wentToShowdown, foldedUserIds };
