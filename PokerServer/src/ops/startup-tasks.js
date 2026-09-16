'use strict';

// 启动后的收尾活（2026-09-16）。
//
// 两件事的共同点：都是【上一个进程没做完就没了】的东西，
// 只能由下一个健康的进程接手。放在一起也是为了让 server.js 保持成
// 一个【只负责组装】的入口（server-modules.test.js 那条关卡守的就是这个，
// 我把这两段写进 server.js 时它当场拦下来了）。

const { crashFileFor, reportPendingCrash } = require('./crash-report');

function runStartupTasks({ db, mailer, label, log = console.log, errLog = console.error }) {
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

module.exports = { runStartupTasks };
