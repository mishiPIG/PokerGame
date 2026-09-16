const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Card, Deck, HandEvaluator } = require('./PokerLogic');
const db = require('./database');
const stats = require('./stats');
const equity = require('./equity');
const mailer = require('./mailer');
const { crashFileFor, recordCrash } = require('./src/ops/crash-report');
const { runStartupTasks } = require('./src/ops/startup-tasks');
const buildInfo = require('./src/build-info');
const { createClientErrorSink } = require('./src/ops/client-errors');
const config = require('./src/config');
const { createRuntime } = require('./src/runtime');
const { createAuth } = require('./src/auth');
const { seedLocalDevUsers } = require('./src/dev-seed');
const { createTableService } = require('./src/table/table-service');
const { registerAdminRoutes } = require('./src/http/register-admin-routes');
const { registerVoiceModule } = require('./src/voice/voice-module');
const { registerAccountRoutes } = require('./src/http/register-account-routes');
const { registerAuthRoutes } = require('./src/http/register-auth-routes');
const { registerSocketHandlers } = require('./src/socket/register-socket-handlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
// 本地开发模式必须显式开启（npm run dev），生产/测试服默认永不开启。
const { LOCAL_DEV, PHASES, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND,
    STANDARD_BLIND_LEVELS, INITIAL_BB, gameSB, gameBB, gameAnte, timeCardsFor,
    ACTION_TIME, EXTRA_STEP, EXTRA_MAX, RUNOUT_DELAY, RUNIT_MAX, RUNIT_DECIDE_MS,
    STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS, FIXED_BUYIN, SNG_BUYIN_TIERS,
    BUYIN_RATE, CASHOUT_RATE, CONFIGURED_PUBLIC_ORIGIN, sngPrize } = config;
const JWT_SECRET = config.loadJwtSecret(__dirname);
const runtime = createRuntime();
const { roomGames, lobbySockets, inviteCodeFailuresByUser, inviteCodeFailuresByIp } = runtime;
app.use((req, res, next) => {
    if (runtime.shuttingDown && req.method !== 'GET') {
        return res.status(503).json({ error: '服务正在安全重启，请稍后重试' });
    }
    return next();
});
const auth = createAuth({ db, jwt, jwtSecret: JWT_SECRET });
const { signToken, userPayload, requireAdmin, requireAuth } = auth;
// 客户端报错上报。【故意不要鉴权】—— 登录页本身也会出错，
// 而那正是最看不到的一类。代价是它必须按敌对输入处理：
// 限流 / 去重 / 截断全在 client-errors.js 里。
//
// ⚠️ 必须挂在全局 express.json() 【之前】，它才能用自己那个更小的体积上限：
//    全局是默认的 100kb，而这是全站唯一一个不鉴权的写入口，
//    16kb 足够装下 message + stack，多出来的只可能是灌垃圾。
const clientErrors = createClientErrorSink();
const parseTinyJson = express.json({ limit: '16kb' });
app.post('/api/client-error', (req, res, next) => {
    // 解析失败（body 超限 / 根本不是 JSON）必须【自己吞掉】，不能交给 express 默认错误处理：
    // 那会把一整段 PayloadTooLargeError 栈打进 pm2 错误日志。
    // 这是全站唯一不鉴权的写入口，谁都能按，等于送一条免费的「往磁盘里灌栈」通道 ——
    // 而本模块存在的理由正是堵住这类灌日志的口子，别自己开一个。
    parseTinyJson(req, res, err => (err ? res.status(204).end() : next()));
}, (req, res) => {
    const fwd = req.headers['x-forwarded-for'];
    const ip = String(fwd || req.socket?.remoteAddress || '?').split(',')[0].trim();
    let username = null;
    try { username = req.body?.username ? String(req.body.username).slice(0, 40) : null; } catch { /* 无所谓 */ }
    clientErrors.record(req.body, { ip, username });
    res.status(204).end();          // 永远 204：不给掉到这里的人任何探测信息，
                                    // 也别让客户端因为上报失败而再报一次错
});
app.use(express.json());
app.use('/avatars', express.static(__dirname + '/avatars'));   // 本地头像图片
app.use(express.static(path.join(__dirname, 'public')));        // 仅暴露前端静态资源，禁止暴露数据/密钥文件
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });


// 仅供本机联调：每次 npm run dev 保证两个双人测试账号可登录。
// 此分支受 LOCAL_DEV 显式环境变量保护，普通 node server.js / pm2 都不会执行。
seedLocalDevUsers({ enabled: LOCAL_DEV, db, bcrypt });



const tableService = createTableService({ io, db, stats, equity, Card, Deck, HandEvaluator, crypto, config, runtime });
const { projectedPositions } = tableService;

registerAdminRoutes({ app, db, requireAdmin, roomGames, io, clientErrors });
const voiceModule = registerVoiceModule({ app, io, db, roomGames, requireAuth, express, crypto, fs, path, baseDir: __dirname });
registerAccountRoutes({ app, db, stats, mailer, requireAuth, requireAdmin, bcrypt, roomGames });
registerAuthRoutes({ app, db, bcrypt, mailer, signToken, userPayload, requireAuth });

auth.registerSocketAuth(io);
registerSocketHandlers({ io, db, stats, Deck, config, runtime, tableService, syncRecentVoices: voiceModule.syncRecentVoices });

const PORT = process.env.PORT || 3000;
const onListening = () => {
    const host = LOCAL_DEV ? '127.0.0.1' : '0.0.0.0';
    console.log(`🚀 扑克服务器已启动！${host}:${PORT}${LOCAL_DEV ? ' (本地开发模式)' : ''}`);
    runStartupTasks({ db, mailer, label: buildInfo.label });
};
if (require.main === module) {
    // 只有真正启动服务时才恢复牌局和计时器。测试或工具仅 require 本模块时不得产生后台定时器。
    const recoveredMatches = tableService.persistence.recoverAll();
    tableService.restoreRecoveredTimers(recoveredMatches);
    let shuttingDown = false;
    const shutdown = (signal, error = null) => {
        if (shuttingDown) return;
        shuttingDown = true;
        runtime.shuttingDown = true;
        console.error(`[shutdown] signal=${signal}`, error?.stack || error || '');
        // 崩溃（而不是 SIGTERM/SIGINT 这种正常停机）时记一笔。
        // 只做同步写盘，【不在这里发邮件】—— process.exit() 会在异步邮件发出前
        // 结束进程，告警会是哑的。交给下一个健康的进程发。
        if (error) recordCrash(crashFileFor(db.databasePath), signal, error);
        for (const roomId of Object.keys(roomGames)) {
            try {
                tableService.persistence.commit(roomId, 'process_shutdown', null, { signal });
            } catch (persistError) {
                console.error(`[shutdown] room=${roomId} snapshot failed`, persistError?.stack || persistError);
            }
        }
        const exitCode = error ? 1 : 0;
        const finish = () => {
            try { db.close(); } catch (closeError) { console.error('[shutdown] db close failed', closeError.message); }
            process.exit(exitCode);
        };
        if (server.listening) {
            server.close(finish);
            setTimeout(finish, 5000).unref();
        } else finish();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('uncaughtException', error => shutdown('uncaughtException', error));
    process.on('unhandledRejection', reason => shutdown('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
    if (LOCAL_DEV) server.listen(PORT, '127.0.0.1', onListening);
    else server.listen(PORT, onListening);
}

module.exports = {
    _test: { projectedPositions, STRADDLE_DECISION_MS: config.STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS: config.STRADDLE_INTERMISSION_MS }
};
