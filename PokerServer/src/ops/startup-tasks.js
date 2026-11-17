'use strict';

// 启动后的收尾活（2026-09-16）。
//
// 两件事的共同点：都是【上一个进程没做完就没了】的东西，
// 只能由下一个健康的进程接手。放在一起也是为了让 server.js 保持成
// 一个【只负责组装】的入口（server-modules.test.js 那条关卡守的就是这个，
// 我把这两段写进 server.js 时它当场拦下来了）。

const { crashFileFor, reportPendingCrash } = require('./crash-report');

// 此刻「活着」的人：连着 socket 的，或者还挂在某张牌桌上的（座位 / 站起围观 / 房主）。
// 清理游客时要跳过他们 —— 筹码只在内存里，这时候把号删了，下一次落库就是外键错误。
function liveUserIds({ io, roomGames }) {
    const ids = new Set();
    for (const s of io?.sockets?.sockets?.values?.() || []) if (s.user?.id) ids.add(s.user.id);
    for (const g of Object.values(roomGames || {})) {
        if (g.ownerUserId) ids.add(g.ownerUserId);
        for (const p of [...(g.players || []), ...(g.vacatedPlayers || [])]) if (p?.userId) ids.add(p.userId);
    }
    return ids;
}

const GUEST_PURGE_EVERY_MS = 6 * 3600 * 1000;

function runStartupTasks({ db, mailer, label, io, roomGames, log = console.log, errLog = console.error }) {
    // ③ 清掉「来了一下、一手没打、7 天没再来」的游客号（判据见 user-repository.purgeStaleGuests）。
    //   放在进程里而不是 cron：要知道此刻谁在线 / 谁在牌桌上，只有进程自己知道。
    //   这只是打扫，不是义务（不像登录 IP 的保留期）—— 进程没活着的那几个小时不清，没有任何后果。
    const purgeGuests = () => {
        try {
            const n = db.purgeStaleGuests({ skip: liveUserIds({ io, roomGames }) });
            if (n) log('[guest] 清理了 ' + n + ' 个一手没打的过期游客号');
        } catch (e) { errLog('[guest] 清理失败', e.message); }
    };
    setTimeout(purgeGuests, 60000).unref();
    setInterval(purgeGuests, GUEST_PURGE_EVERY_MS).unref();

    // ① 上一个进程是崩溃退出的吗？是就现在报。
    //   必须由【健康的】进程发，而不是濒死的那个（见 crash-report.js）。
    //   不 await：告警发不出去不应该拖住服务启动。
    reportPendingCrash(crashFileFor(db.databasePath), { mailer, label })
        .then(r => { if (r.sent) errLog('[crash] 已告警上次的 ' + r.count + ' 次崩溃'); })
        .catch(e => errLog('[crash] 上报失败', e.message));

    // ② 上次有账号注销到一半就重启了？把没擦完的牌谱接着擦完。
    //   延迟 5 秒再开始：启动那一下要先把牌局从快照里恢复出来，
    //   别和它抢 CPU。unref() 是为了不拖住进程退出（测试里尤其要紧）。
    setTimeout(() => {
        db.accountDeletion.resumePendingScrubs({ log })
            .catch(e => errLog('[account] 续擦失败', e.message));
    }, 5000).unref();
}

module.exports = { runStartupTasks, liveUserIds };
