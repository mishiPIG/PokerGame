'use strict';

// 公开分享的一手牌：别人点链接、不用登录就能看的那一份（2026-11-17）。
//
// 🔴 规则只有一条：【只看得见分享人当时看得见的东西】。
//    - 分享人自己的底牌 + 摊牌时亮出来的牌；弃牌者没亮过的牌一律不给（连字段都不留）。
//    - 和 hand-visibility.js 的「桌子没散」那一档完全相同，而且【不管桌子散没散都按这一档】：
//      桌子散了对同桌玩家是「一切公开」（为了可验证公平），但对陌生人不是 ——
//      同桌人知道的事，不等于可以公开给任何人。
//    - 种子 / 牌序整段去掉：知道种子就能重算整副牌，等于绕过上面那条。
//    - userId 换成 p1、p2… 这样的代号：真实 id 是内部标识，别让它出现在任何公开的地方。
//      名字用的是牌谱里存的【显示名】（不是登录用的用户名）。
//    - roomId / matchId 去掉：私密桌的房间号不该随一个分享链接流出去。
//
// ⚠️ 这里不改入参，返回一份新的对象。
const { filterHandForViewer } = require('./hand-visibility');

function publicHandView(hand, sharerUserId) {
    if (!hand || typeof hand !== 'object') return null;
    const strict = filterHandForViewer(hand, sharerUserId, { tableEnded: false });
    delete strict.fair;
    delete strict.roomId;
    delete strict.matchId;
    delete strict.id;

    // 所有出现过的 userId 换成代号。按座位顺序编号，分享人也只是其中一个。
    // 整段 JSON 文本替换，而不是挨个字段改：牌谱里引用 userId 的地方很多
    // （actions / results / straddle / runIt.winners / buttonUserId …），以后再加字段也不会漏。
    const ids = (strict.seats || []).map(s => s.userId).filter(Boolean);
    const alias = new Map(ids.map((id, i) => [id, 'p' + (i + 1)]));
    let text = JSON.stringify(strict);
    for (const [id, a] of alias) text = text.split(JSON.stringify(id)).join(JSON.stringify(a));
    const out = JSON.parse(text);
    out.heroId = alias.get(sharerUserId) || null;   // 回放从分享人的视角看（他的牌亮着、坐在下方）
    out.shared = true;
    return out;
}

module.exports = { publicHandView };
