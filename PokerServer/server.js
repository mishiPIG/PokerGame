const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Deck, HandEvaluator } = require('./PokerLogic');
const db = require('./database');
const stats = require('./stats');
const equity = require('./equity');
const mailer = require('./mailer');
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
const auth = createAuth({ db, jwt, jwtSecret: JWT_SECRET });
const { signToken, userPayload, requireAdmin, requireAuth } = auth;
app.use(express.json());
app.use('/avatars', express.static(__dirname + '/avatars'));   // 本地头像图片
app.use(express.static(path.join(__dirname, 'public')));        // 仅暴露前端静态资源，禁止暴露数据/密钥文件
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });


// 仅供本机联调：每次 npm run dev 保证两个双人测试账号可登录。
// 此分支受 LOCAL_DEV 显式环境变量保护，普通 node server.js / pm2 都不会执行。
seedLocalDevUsers({ enabled: LOCAL_DEV, db, bcrypt });



const tableService = createTableService({ io, db, stats, equity, Deck, HandEvaluator, crypto, config, runtime });
const { projectedPositions } = tableService;

registerAdminRoutes({ app, db, requireAdmin });
const voiceModule = registerVoiceModule({ app, io, db, roomGames, requireAuth, express, crypto, fs, path, baseDir: __dirname });
registerAccountRoutes({ app, db, stats, mailer, requireAuth, requireAdmin });
registerAuthRoutes({ app, db, bcrypt, mailer, signToken, userPayload, requireAuth });

auth.registerSocketAuth(io);
registerSocketHandlers({ io, db, stats, Deck, config, runtime, tableService, syncRecentVoices: voiceModule.syncRecentVoices });

// 防崩溃兜底：某个 socket 事件处理器/异步里抛出未捕获异常时，只记录日志、绝不让整个进程崩溃。
// （进程崩溃 = pm2 重启 = 内存里所有正在进行的牌局清空 + 玩家在局筹码丢失，代价极大——
//  宁可让"出错的那一次操作"静默失败，也不能连累全服所有人。）
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] 已捕获，进程继续运行：', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] 已捕获，进程继续运行：', (reason && reason.stack) || reason);
});

const PORT = process.env.PORT || 3000;
const onListening = () => {
    const host = LOCAL_DEV ? '127.0.0.1' : '0.0.0.0';
    console.log(`🚀 扑克服务器已启动！${host}:${PORT}${LOCAL_DEV ? ' (本地开发模式)' : ''}`);
};
if (require.main === module) {
    if (LOCAL_DEV) server.listen(PORT, '127.0.0.1', onListening);
    else server.listen(PORT, onListening);
}

module.exports = {
    _test: { projectedPositions, STRADDLE_DECISION_MS: config.STRADDLE_DECISION_MS, STRADDLE_INTERMISSION_MS: config.STRADDLE_INTERMISSION_MS }
};
