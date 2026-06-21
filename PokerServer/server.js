const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Deck, HandEvaluator } = require('./PokerLogic');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.use(express.json());
app.use('/avatars', express.static(__dirname + '/avatars'));   // 本地头像图片
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const PHASES = {
    WAITING:  'waiting',
    PREFLOP:  'preflop',
    FLOP:     'flop',
    TURN:     'turn',
    RIVER:    'river',
    SHOWDOWN: 'showdown'
};

const DEFAULT_SMALL_BLIND = 10;
const DEFAULT_BIG_BLIND   = 20;
const JWT_SECRET  = process.env.JWT_SECRET || 'poker-dev-secret-change-in-prod';

// 标准 SNG 升盲表（级别 0 起，初始 25/50；SB=BB/2，每级 BB ×1.3~1.5 取整，行业标准结构）
const STANDARD_BLIND_LEVELS = [
    { sb: 25,   bb: 50   },
    { sb: 50,   bb: 100  },
    { sb: 75,   bb: 150  },
    { sb: 100,  bb: 200  },
    { sb: 150,  bb: 300  },
    { sb: 200,  bb: 400  },
    { sb: 300,  bb: 600  },
    { sb: 400,  bb: 800  },
    { sb: 500,  bb: 1000 },
    { sb: 600,  bb: 1200 },
    { sb: 800,  bb: 1600 },
    { sb: 1000, bb: 2000 },
    { sb: 1500, bb: 3000 },
    { sb: 2000, bb: 4000 },
    { sb: 3000, bb: 6000 }
];
const INITIAL_BB = STANDARD_BLIND_LEVELS[0].bb;   // 200BB 计算基准（默认初始记分牌 10000 = 200BB）

// 当前房间的盲注（按 SNG 当前级别；非 SNG 走默认）
function gameSB(game) {
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].sb;
    return DEFAULT_SMALL_BLIND;
}
function gameBB(game) {
    if (game.blindLevels) return game.blindLevels[Math.min(game.currentLevel, game.blindLevels.length - 1)].bb;
    return DEFAULT_BIG_BLIND;
}

// 行动思考时间（毫秒）
const ACTION_TIME = 15000;    // 初始 15s
const EXTRA_STEP  = 15000;    // 每次加时 +15s
const EXTRA_MAX   = 120000;   // 单次行动累计加时上限 2min
const RUNOUT_DELAY = 1400;    // all-in 摊牌跑马，每条街发牌间隔
const FIXED_BUYIN  = 50;      // 报名费固定 50 金币

const roomGames = {};

// ===== Admin middleware =====

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        const user = db.getUserById(payload.id);
        if (!user?.isAdmin) return res.status(403).json({ error: '无管理员权限' });
        req.adminUser = user;
        next();
    } catch {
        res.status(401).json({ error: '登录已过期' });
    }
}

// 获取所有用户列表
app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(db.getAllUsers());
});

// 设置任意玩家金币
app.post('/api/admin/set-gold', requireAdmin, (req, res) => {
    const { username, gold } = req.body || {};
    if (!username || gold === undefined)
        return res.status(400).json({ error: '缺少 username 或 gold' });
    if (!Number.isInteger(gold) || gold < 0)
        return res.status(400).json({ error: 'gold 必须为非负整数' });
    const target = db.getUserByUsername(username);
    if (!target) return res.status(404).json({ error: `用户 "${username}" 不存在` });
    db.setGold(target.id, gold);
    console.log(`[admin] ${req.adminUser.username} 将 ${target.username} 金币设为 ${gold}`);
    res.json({ ok: true, username: target.username, gold });
});

// ===== Auth routes =====

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: '请填写用户名和密码' });
    if (username.length < 2 || username.length > 20)
        return res.status(400).json({ error: '用户名 2-20 字符' });
    if (password.length < 6)
        return res.status(400).json({ error: '密码至少 6 位' });
    try {
        const hash = await bcrypt.hash(password, 10);
        const user = db.createUser(username, hash);
        const token = jwt.sign({ id: user.id, username: user.username, isAdmin: !!user.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, username: user.username, gold: user.gold, isAdmin: !!user.isAdmin } });
    } catch (err) {
        if (err.message?.includes('UNIQUE'))
            return res.status(409).json({ error: '用户名已被注册' });
        console.error(err);
        res.status(500).json({ error: '服务器错误' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: '请填写用户名和密码' });
    const user = db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin: !!user.isAdmin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, gold: user.gold, isAdmin: !!user.isAdmin } });
});

// ===== Game helpers =====

function activePlayers(game) {
    return game.players.filter(p => !p.folded);
}

function canAct(p) {
    return !p.folded && !p.allIn;
}

function findNextActionIdx(game, fromIdx) {
    const n = game.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        if (canAct(game.players[idx])) return idx;
    }
    return -1;
}

function isBettingRoundComplete(game) {
    const active = activePlayers(game);
    if (active.length <= 1) return true;
    const canStill = active.filter(canAct);
    if (canStill.length === 0) return true;
    return canStill.every(p => p.hasActed && p.currentBet === game.currentBet);
}

function collectBetsToPot(game) {
    const activeBets = game.players
        .filter(p => !p.folded)
        .map(p => p.currentBet)
        .sort((a, b) => b - a);
    const cap = activeBets.length >= 2 ? activeBets[1] : 0;
    game.players.forEach(p => {
        let contribute = p.currentBet;
        if (!p.folded) {
            contribute = Math.min(p.currentBet, cap);
            p.chips += (p.currentBet - contribute);
        }
        game.pot += contribute;
        p.currentBet = 0;
        p.hasActed = false;
    });
    game.currentBet = 0;
    game.lastRaiseSize = gameBB(game);   // 新街最小加注增量重置为大盲
}

function broadcastState(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const state = {
        phase: game.phase,
        pot: game.pot,
        currentBet: game.currentBet,
        smallBlind: gameSB(game),
        bigBlind: gameBB(game),
        minBet:     gameBB(game),                                       // 本街首注最小额
        minRaiseTo: game.currentBet + (game.lastRaiseSize || gameBB(game)), // 最小加注目标额
        roomType:   game.roomType || 'cash',
        roomName:   game.config?.name || roomId,
        ownerUserId:    game.ownerUserId || null,
        status:         game.status || 'waiting',
        currentLevel:   game.currentLevel || 0,
        nextLevelAt:    game.roomType === 'sng' && game.status === 'running' && game.levelStartTime
                        ? game.levelStartTime + game.config.levelMinutes * 60000 : null,
        pendingLevelUp: !!game.pendingLevelUp,
        tournamentOver: game.tournamentOver || false,
        actionDeadline: game.actionOnIdx >= 0 ? (game.actionDeadline || null) : null, // 行动截止时间戳(ms)
        actionTotalMs:  game.actionOnIdx >= 0 ? (game.actionTotalMs || ACTION_TIME) : null, // 本次行动总时长(环形进度)
        canAddTime:     game.actionOnIdx >= 0 && (game.extraAddedThisTurn || 0) < EXTRA_MAX, // 还能加时
        buttonUserId:   game.players[game.buttonIdx]?.userId || null,
        actionOnUserId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.userId || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            userId:     p.userId,
            username:   p.username,
            avatar:     p.avatar || null,
            chips:      p.chips,
            currentBet: p.currentBet,
            folded:     p.folded,
            allIn:      p.allIn,
            ready:      p.ready,
            away:       !!p.away
        }))
    };
    io.in(roomId).emit('game_state', state);
    emitHandHints(roomId);
}

// 向每位在局玩家私发其「当前最强 5 张牌」+ 牌型名（仅 flop 起，showdown 由 reveal 接管）
function emitHandHints(roomId) {
    const game = roomGames[roomId];
    if (!game || game.phase === PHASES.SHOWDOWN) return;
    const comLen = game.communityCards.length;
    if (comLen < 3) return;
    game.players.forEach(p => {
        if (p.folded || !p.socketId || !game.holeCards[p.userId]) return;
        const cards = game.communityCards.concat(game.holeCards[p.userId]);
        const bh = HandEvaluator.bestHandFrom(cards);
        if (!bh) return;
        const community = bh.indices.filter(i => i < comLen);
        const hole = bh.indices.filter(i => i >= comLen).map(i => i - comLen);
        io.to(p.socketId).emit('my_hand', { community, hole, category: bh.category });
    });
}

// ===== 行动计时器（服务器权威）=====

function clearActionTimer(game) {
    if (game.actionTimer) { clearTimeout(game.actionTimer); game.actionTimer = null; }
}

// 给当前行动玩家开始计时；超时自动 check / fold
function startActionTimer(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    clearActionTimer(game);
    if (game.actionOnIdx < 0) { game.actionDeadline = null; return; }
    game.extraAddedThisTurn = 0;
    // 离桌挂机的玩家：快速自动行动，避免每步等满 15s
    const actor = game.players[game.actionOnIdx];
    const ms = (actor && actor.away) ? 800 : ACTION_TIME;
    game.actionDeadline = Date.now() + ms;
    game.actionTotalMs = ms;
    game.actionTimer = setTimeout(() => onActionTimeout(roomId), ms);
}

function onActionTimeout(roomId) {
    const game = roomGames[roomId];
    if (!game || game.actionOnIdx < 0) return;
    const player = game.players[game.actionOnIdx];
    if (!player) return;
    const toCall = game.currentBet - player.currentBet;
    if (toCall <= 0) {
        player.hasActed = true;
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动过牌`);
    } else {
        player.folded = true; player.hasActed = true;
        io.in(roomId).emit('server_msg', `⏱ ${player.username} 超时自动弃牌`);
    }
    afterAction(roomId);
}

// 一次行动后推进：本街结束则进下一阶段，否则轮到下一位并重启计时
function afterAction(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (isBettingRoundComplete(game)) {
        advanceStage(roomId);
    } else {
        game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
        startActionTimer(roomId);
        broadcastState(roomId);
    }
}

function dealCommunity(game, count) {
    game.deck.drawCard(); // burn
    const dealt = [];
    for (let i = 0; i < count; i++) {
        const c = game.deck.drawCard();
        game.communityCards.push(c);
        dealt.push(c);
    }
    return dealt;
}

function advanceStage(roomId) {
    const game = roomGames[roomId];
    clearActionTimer(game);   // 进入新阶段前先停掉上一位的计时

    // all-in 跑马：当至多 1 名活跃玩家还能行动（其余已全押且已跟齐）→ 无更多下注，先亮牌再发完
    const act = activePlayers(game);
    const bettingClosed = act.length > 1 && act.filter(canAct).length <= 1;
    if (!game.allinRevealed && bettingClosed) {
        game.allinRevealed = true;
        collectBetsToPot(game);                 // 先把全押筹码收进底池
        const reveals = {};
        act.forEach(p => {
            const h = game.holeCards[p.userId];
            if (h) reveals[p.userId] = h.map(c => ({ suit: c.suit, rank: c.rank }));
        });
        io.in(roomId).emit('server_msg', `🃏 双方全押，亮牌！`);
        io.in(roomId).emit('allin_reveal', { reveals });
        broadcastState(roomId);                 // 先展示亮牌（公共牌暂不变）
        clearTimeout(game.runoutTimer);
        game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
        return;                                 // 下一次 advanceStage 才开始发公共牌
    }

    while (true) {
        const active = activePlayers(game);
        if (active.length <= 1) {
            collectBetsToPot(game);
            if (active.length === 1) {
                const winner = active[0];
                winner.chips += game.pot;
                io.in(roomId).emit('server_msg', `🏆 ${winner.username} 赢得底池 ${game.pot}（对手弃牌）`);
                io.in(roomId).emit('sfx', 'win');
            }
            game.pot = 0;
            game.phase = PHASES.SHOWDOWN;
            game.actionOnIdx = -1;
            applyPendingLevelUp(roomId);
            broadcastState(roomId);
            maybeEndSNG(roomId);
            if (!game.tournamentOver) scheduleNextHand(roomId);
            return;
        }
        collectBetsToPot(game);
        if (game.phase === PHASES.PREFLOP) {
            game.phase = PHASES.FLOP;
            const flop = dealCommunity(game, 3);
            io.in(roomId).emit('server_msg', `🌅 Flop: ${flop.map(c => c.toString()).join(' | ')}`);
        } else if (game.phase === PHASES.FLOP) {
            game.phase = PHASES.TURN;
            const [turn] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌇 Turn: ${turn.toString()}`);
        } else if (game.phase === PHASES.TURN) {
            game.phase = PHASES.RIVER;
            const [river] = dealCommunity(game, 1);
            io.in(roomId).emit('server_msg', `🌃 River: ${river.toString()}`);
        } else if (game.phase === PHASES.RIVER) {
            game.phase = PHASES.SHOWDOWN;
            doShowdown(roomId);
            return;
        }
        // 至多 1 人能行动（其余全押）→ 不再要任何人行动，直接跑马
        const act2 = activePlayers(game);
        if (act2.length > 1 && act2.filter(canAct).length <= 1) {
            game.actionOnIdx = -1;
        } else {
            game.actionOnIdx = findNextActionIdx(game, game.buttonIdx);
        }
        if (game.actionOnIdx < 0) {
            // 无人可行动（全押 all-in 跑马）：发完这条街先展示，间隔一段时间再发下一张
            broadcastState(roomId);
            clearTimeout(game.runoutTimer);
            game.runoutTimer = setTimeout(() => advanceStage(roomId), RUNOUT_DELAY);
            return;
        }
        startActionTimer(roomId);
        broadcastState(roomId);
        return;
    }
}

function doShowdown(roomId) {
    const game = roomGames[roomId];
    const active = activePlayers(game);
    io.in(roomId).emit('server_msg', `\n--- 🃏 Showdown ---`);

    const scored = active.map(p => {
        const sevenCards = game.communityCards.concat(game.holeCards[p.userId]);
        const score = HandEvaluator.evaluate7Cards(sevenCards);
        return { player: p, score };
    });

    const bestScore = Math.min(...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === bestScore).map(s => s.player);

    // 广播所有手牌（供客户端翻牌展示）
    const reveals = {};
    scored.forEach(({ player, score }) => {
        const hole = game.holeCards[player.userId];
        reveals[player.userId] = hole.map(c => ({ suit: c.suit, rank: c.rank }));
        io.in(roomId).emit('server_msg', `📊 ${player.username}: ${hole[0].toString()}, ${hole[1].toString()} → 得分 ${score}`);
    });

    // 赢家最强 5 张：7 张牌序为 community(0-4) + hole(5-6)
    const firstWinner = winners[0];
    const wSeven = game.communityCards.concat(game.holeCards[firstWinner.userId]);
    const wb = HandEvaluator.bestHand(wSeven);
    const bestCommunity = wb.indices.filter(i => i < 5);
    const bestHole = wb.indices.filter(i => i >= 5).map(i => i - 5);

    io.in(roomId).emit('showdown_reveal', {
        reveals,
        winners: winners.map(w => w.userId),
        winnerId: firstWinner.userId,
        bestCommunity, bestHole,
        category: wb.category
    });

    const split = Math.floor(game.pot / winners.length);
    const remainder = game.pot - split * winners.length;
    winners.forEach((w, i) => { w.chips += split + (i === 0 ? remainder : 0); });

    const winnerLabel = winners.map(w => w.username).join(', ');
    io.in(roomId).emit('server_msg',
        `🏆 ${winnerLabel} 赢得底池 ${game.pot}${winners.length > 1 ? `（平分每人 ${split}）` : ''}`);

    game.pot = 0;
    game.actionOnIdx = -1;
    applyPendingLevelUp(roomId);
    broadcastState(roomId);
    io.in(roomId).emit('sfx', 'win');
    maybeEndSNG(roomId);
    if (!game.tournamentOver) scheduleNextHand(roomId);
}

// 全员准备就绪后自动开新局
function tryStartHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.tournamentOver) return;
    if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) return;
    if (game.players.length < 2) return;
    if (!game.players.every(p => p.ready)) return;
    startHand(roomId);
}

function startHand(roomId) {
    const game = roomGames[roomId];
    if (!game) return;

    const BB = gameBB(game), SB = gameSB(game);
    // 仅在有玩家已无筹码时阻止开局；短码（< BB）允许下盲即全下
    if (game.players.some(p => p.chips <= 0)) {
        io.in(roomId).emit('server_msg', `⚠️ 有玩家筹码为 0，无法开局`);
        return;
    }
    clearTimeout(game.nextHandTimer);
    clearTimeout(game.runoutTimer);
    game.rabbitStreets = 0;   // 重置「看后续牌」状态
    // SNG：第一手开始时启动比赛与升盲计时
    if (game.roomType === 'sng' && game.status !== 'running') {
        game.status = 'running';
        game.levelStartTime = Date.now();
        startLevelTimer(roomId);
        broadcastRoomList();
    }
    if (game.phase === PHASES.SHOWDOWN)
        game.buttonIdx = (game.buttonIdx + 1) % game.players.length;

    game.deck.reset(); game.deck.shuffle();
    game.holeCards = {}; game.communityCards = [];
    game.shownCards = {};   // 本局主动亮牌记录（userId -> Set(牌索引)）
    game.allinRevealed = false;   // 全押亮牌标志
    game.pot = 0; game.currentBet = 0;
    game.lastRaiseSize = BB;   // 本街最小加注增量（每条街在 collectBetsToPot 重置）
    game.players.forEach(p => {
        p.currentBet = 0; p.folded = false; p.allIn = false; p.hasActed = false;
        p.ready = false;   // 开局即清空准备状态，下一局需重新准备
    });
    game.phase = PHASES.PREFLOP;

    // 标准 heads-up：按钮位 = SB，preflop 先动
    const sbIdx = game.buttonIdx;
    const bbIdx = (game.buttonIdx + 1) % game.players.length;
    const sb = game.players[sbIdx];
    const bb = game.players[bbIdx];
    const sbAmt = Math.min(SB, sb.chips);
    const bbAmt = Math.min(BB, bb.chips);
    sb.chips -= sbAmt; sb.currentBet = sbAmt;
    bb.chips -= bbAmt; bb.currentBet = bbAmt;
    if (sb.chips === 0) sb.allIn = true;
    if (bb.chips === 0) bb.allIn = true;
    game.currentBet = bbAmt;

    io.in(roomId).emit('server_msg', `\n--- 🎲 新一局开始 ---`);
    io.in(roomId).emit('server_msg', `💰 SB: ${sb.username} (${sbAmt}) | BB: ${bb.username} (${bbAmt})`);

    game.players.forEach(p => {
        const c1 = game.deck.drawCard();
        const c2 = game.deck.drawCard();
        game.holeCards[p.userId] = [c1, c2];
        io.to(p.socketId).emit('hole_cards', [
            { suit: c1.suit, rank: c1.rank },
            { suit: c2.suit, rank: c2.rank }
        ]);
    });

    game.actionOnIdx = sbIdx;
    startActionTimer(roomId);
    broadcastState(roomId);
}

// ===== 房间 / 大厅 =====

const lobbySockets = new Set();   // 当前停留在大厅页的 socketId，用于推送房间列表

function clampInt(v, min, max, def) {
    v = parseInt(v);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
}

function genRoomId() {
    let id;
    do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (roomGames[id]);
    return id;
}

function roomSummary(roomId, userId) {
    const g = roomGames[roomId];
    return {
        roomId,
        roomType:   g.roomType,
        name:       g.config?.name || roomId,
        ownerName:  g.ownerName || '',
        maxPlayers: g.config?.maxPlayers || 2,
        playerCount: g.players.length,
        status:     g.status,                    // waiting | running | finished
        levelMinutes: g.config?.levelMinutes || 0,
        startingStack: g.config?.startingStack || 0,
        buyIn:      g.config?.buyIn || 0,
        isMember:   !!(userId && g.players.some(p => p.userId === userId))   // 我是否本房成员（可重进）
    };
}

function listRooms(userId) {
    return Object.keys(roomGames)
        .filter(id => roomGames[id].roomType && roomGames[id].status !== 'finished')
        .map(id => roomSummary(id, userId));
}

function broadcastRoomList() {
    for (const sid of lobbySockets) {
        const s = io.sockets.sockets.get(sid);
        io.to(sid).emit('room_list', listRooms(s && s.user && s.user.id));
    }
}

// SNG 升盲计时器
function startLevelTimer(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng') return;
    clearTimeout(game.levelTimer);
    game.levelTimer = setTimeout(() => onLevelUp(roomId), game.config.levelMinutes * 60000);
}

function onLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || game.status !== 'running') return;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    if (inHand) {
        // 牌局进行中：挂起涨盲，等本局结束再应用并重启倒计时（不在此重启计时）
        game.pendingLevelUp = true;
        io.in(roomId).emit('server_msg', `⏫ 涨盲时间到，将于本局结束后升盲`);
        broadcastState(roomId);
        return;
    }
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

function doLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    if (game.currentLevel < game.blindLevels.length - 1) {
        game.currentLevel++;
        const lvl = game.blindLevels[game.currentLevel];
        io.in(roomId).emit('server_msg', `⏫ 升盲！级别 ${game.currentLevel + 1}：${lvl.sb}/${lvl.bb}`);
    }
    game.levelStartTime = Date.now();
}

// 本局结束时若有挂起的涨盲，则应用并重启倒计时
function applyPendingLevelUp(roomId) {
    const game = roomGames[roomId];
    if (!game || !game.pendingLevelUp) return;
    game.pendingLevelUp = false;
    doLevelUp(roomId);
    startLevelTimer(roomId);
}

// SNG 结束判定：仅剩 1 人有筹码 → 比赛结束，奖池给赢家
function maybeEndSNG(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng' || game.tournamentOver) return;
    const alive = game.players.filter(p => p.chips > 0);
    if (alive.length <= 1) {
        game.tournamentOver = true;
        game.status = 'finished';
        clearTimeout(game.levelTimer);
        const winner = alive[0];
        if (winner) {
            const prize = game.prizePool || 0;
            if (prize > 0) {
                const fresh = db.getUserById(winner.userId).gold;
                db.setGold(winner.userId, fresh + prize);
                if (winner.socketId) io.to(winner.socketId).emit('gold_update', { gold: fresh + prize });
            }
            io.in(roomId).emit('server_msg', `🏆🏆 ${winner.username} 夺冠！奖池 ${prize} 金币`);
            io.in(roomId).emit('tournament_over', { winner: winner.username, prize });
        }
        broadcastRoomList();
    }
}

// 一局结束后自动开下一局（SNG 进行中，无需重新准备）
function scheduleNextHand(roomId) {
    const game = roomGames[roomId];
    if (!game || game.roomType !== 'sng' || game.tournamentOver) return;
    if (game.players.filter(p => p.chips > 0).length < 2) return;
    clearTimeout(game.nextHandTimer);
    game.nextHandTimer = setTimeout(() => {
        const g = roomGames[roomId];
        if (g && !g.tournamentOver && g.phase === PHASES.SHOWDOWN
            && g.players.filter(p => p.chips > 0).length >= 2) {
            startHand(roomId);
        }
    }, 5000);   // 留时间看摊牌结果 / 主动亮牌
}

// 入座：扣报名费、发起始筹码、加入房间
function seatPlayer(roomId, socket, user) {
    const game = roomGames[roomId];
    const fee = game.config.buyIn || 0;
    const fresh = db.getUserById(user.id);
    if (fresh.gold < fee) { socket.emit('server_msg', `⚠️ 金币不足报名费 ${fee}（当前 ${fresh.gold}）`); return false; }
    if (fee > 0) {
        db.setGold(user.id, fresh.gold - fee);
        user.gold = fresh.gold - fee;
        game.prizePool = (game.prizePool || 0) + fee;
        socket.emit('gold_update', { gold: user.gold });
    }
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    game.players.push({
        userId: user.id, socketId: socket.id, username: user.username,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips: game.config.startingStack, currentBet: 0,
        folded: false, allIn: false, hasActed: false, ready: false
    });
    socket.emit('room_joined', { roomId });
    socket.to(roomId).emit('server_msg', `🪑 ${user.username} 加入比赛`);
    broadcastState(roomId);
    broadcastRoomList();
    return true;
}

// ===== Socket auth middleware =====

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('未登录'));
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = db.getUserById(payload.id);
        if (!user) return next(new Error('用户不存在'));
        socket.user = { ...user }; // shallow copy so we can mutate gold cache
        next();
    } catch {
        next(new Error('登录已过期，请重新登录'));
    }
});

// ===== Socket handlers =====

io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`[+] ${user.username} 上线`);
    socket.emit('gold_update', { gold: user.gold });
    socket.emit('profile', { avatar: db.getUserById(user.id)?.avatar || null });

    // 网络延迟测量：回声
    socket.on('latency_ping', (t) => socket.emit('latency_pong', t));

    // 设置头像：持久化 + 更新在座玩家 + 重广播
    socket.on('set_avatar', ({ avatar }) => {
        if (avatar && typeof avatar !== 'string') return;
        db.setAvatar(user.id, avatar || null);
        user.avatar = avatar || null;
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const p = game.players.find(pl => pl.userId === user.id);
            if (p) { p.avatar = avatar || null; broadcastState(roomId); }
        }
        socket.emit('profile', { avatar: avatar || null });
    });

    // 进入大厅：订阅房间列表
    socket.on('enter_lobby', () => {
        lobbySockets.add(socket.id);
        socket.currentRoom = null;
        socket.emit('room_list', listRooms(user.id));
    });

    // 创建 SNG 房间（双人升盲），创建者自动入座
    socket.on('create_room', (cfg) => {
        cfg = cfg || {};
        const roomId = genRoomId();
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, actionOnIdx: -1,
            roomType: 'sng', status: 'waiting',
            ownerUserId: user.id, ownerName: user.username,
            config: {
                name:        (cfg.name || '').toString().trim().slice(0, 20) || `${user.username}的比赛`,
                maxPlayers:  2,                                              // 当前仅双人 heads-up
                startingStack: clampInt(cfg.startingStack, 5000, 30000, 10000),
                levelMinutes:  clampInt(cfg.levelMinutes, 3, 10, 3),
                buyIn:         FIXED_BUYIN
            },
            blindLevels: STANDARD_BLIND_LEVELS,
            currentLevel: 0, levelStartTime: null, prizePool: 0, tournamentOver: false
        };
        if (!seatPlayer(roomId, socket, user)) { delete roomGames[roomId]; }
    });

    // 加入已有房间（含断线重连）
    socket.on('join_room', ({ roomId }) => {
        const game = roomGames[roomId];
        if (!game) { socket.emit('server_msg', '⚠️ 房间不存在或已结束'); socket.emit('room_list', listRooms(user.id)); return; }

        // 断线重连
        const existing = game.players.find(p => p.userId === user.id);
        if (existing) {
            existing.socketId = socket.id;
            existing.away = false;   // 重连后恢复在桌
            lobbySockets.delete(socket.id);
            socket.join(roomId);
            socket.currentRoom = roomId;
            socket.emit('room_joined', { roomId });
            socket.emit('server_msg', '🔄 重新连接成功');
            if (game.holeCards[user.id]) {
                socket.emit('hole_cards', game.holeCards[user.id].map(c => ({ suit: c.suit, rank: c.rank })));
            }
            broadcastState(roomId);
            return;
        }

        if (game.players.length >= game.config.maxPlayers) { socket.emit('server_msg', '⚠️ 房间已满'); return; }
        if (game.roomType === 'sng' && game.status === 'running') { socket.emit('server_msg', '⚠️ 比赛已开始，无法加入'); return; }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) { socket.emit('server_msg', '⚠️ 牌局进行中，请稍后'); return; }

        seatPlayer(roomId, socket, user);
    });

    // 退出房间，返回大厅
    socket.on('leave_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (game) {
            const idx = game.players.findIndex(p => p.userId === user.id);
            if (idx >= 0) {
                const p = game.players[idx];
                const started = game.roomType === 'sng' && game.status === 'running';
                if (!started) {
                    // 开赛前退出：退还报名费、移除座位（不结算、不判赢）
                    if (game.roomType === 'sng' && game.config.buyIn > 0) {
                        const fresh = db.getUserById(user.id).gold;
                        db.setGold(user.id, fresh + game.config.buyIn);
                        game.prizePool = Math.max(0, (game.prizePool || 0) - game.config.buyIn);
                        user.gold = fresh + game.config.buyIn;
                        socket.emit('gold_update', { gold: user.gold });
                    }
                    game.players.splice(idx, 1);
                    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开房间`);
                    if (game.players.length === 0) {
                        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer);
                        clearActionTimer(game); delete roomGames[roomId];
                    } else {
                        broadcastState(roomId);
                    }
                } else {
                    // 比赛已开始：保留座位（视为离桌挂机），不结算；本局自动弃牌推进
                    p.away = true;
                    socket.leave(roomId);
                    io.to(roomId).emit('server_msg', `🚪 ${user.username} 离桌（座位保留，盲注照扣，可重连）`);
                    if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN && !p.folded) {
                        p.folded = true; p.hasActed = true;
                        if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
                        else if (isBettingRoundComplete(game)) { advanceStage(roomId); }
                        else broadcastState(roomId);
                    } else {
                        broadcastState(roomId);
                    }
                }
            }
        }
        socket.currentRoom = null;
        lobbySockets.add(socket.id);
        socket.emit('left_room');
        socket.emit('room_list', listRooms(user.id));
        broadcastRoomList();
    });

    // 解散房间：仅房主可用。结束比赛、奖池给当前筹码领先者、全员回大厅
    socket.on('dissolve_room', () => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.ownerUserId !== user.id) { socket.emit('server_msg', '⚠️ 只有房主可以解散房间'); return; }

        clearTimeout(game.levelTimer); clearTimeout(game.nextHandTimer); clearTimeout(game.runoutTimer); clearActionTimer(game);
        // 奖池给当前筹码最多者
        if (game.prizePool > 0) {
            const leader = [...game.players].sort((a, b) => b.chips - a.chips)[0];
            if (leader) {
                const fresh = db.getUserById(leader.userId).gold;
                db.setGold(leader.userId, fresh + game.prizePool);
                if (leader.socketId) io.to(leader.socketId).emit('gold_update', { gold: fresh + game.prizePool });
            }
        }
        io.in(roomId).emit('server_msg', `🛑 房主解散了房间`);
        io.in(roomId).emit('room_dissolved');
        for (const p of game.players) {
            const s = io.sockets.sockets.get(p.socketId);
            if (s) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('room_list', listRooms(p.userId)); }
        }
        delete roomGames[roomId];
        broadcastRoomList();
    });

    // 准备 / 取消准备：全员准备且 >=2 人时自动开局
    socket.on('toggle_ready', (roomId) => {
        const game = roomGames[roomId];
        if (!game) return;
        // 仅开赛前需要准备；比赛开始后自动续局，无需重新准备
        if (game.roomType === 'sng' && game.status === 'running') return;
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', '⚠️ 牌局进行中，无法更改准备状态'); return;
        }
        const p = game.players.find(p => p.userId === user.id);
        if (!p) { socket.emit('server_msg', '⚠️ 你还未入座'); return; }
        p.ready = !p.ready;
        io.in(roomId).emit('server_msg', `${p.ready ? '✅' : '⬜'} ${p.username} ${p.ready ? '已准备' : '取消准备'}`);
        broadcastState(roomId);
        tryStartHand(roomId);
    });

    // 主动亮牌：摊牌阶段（含弃牌结束的局间）玩家可选择亮出自己某张/全部底牌
    socket.on('show_card', ({ roomId, index }) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const hole = game.holeCards[user.id];
        if (!hole) return;
        index = parseInt(index);
        if (index !== 0 && index !== 1) return;
        game.shownCards = game.shownCards || {};
        const set = game.shownCards[user.id] || (game.shownCards[user.id] = new Set());
        if (set.has(index)) return;
        set.add(index);
        const shown = [...set].map(i => ({ index: i, suit: hole[i].suit, rank: hole[i].rank }));
        io.in(roomId).emit('show_cards', { userId: user.id, cards: shown });
        io.in(roomId).emit('server_msg', `👁️ ${user.username} 亮出一张牌`);
        // 每亮一张牌就重置局间倒计时，给大家看牌的时间
        scheduleNextHand(roomId);
    });

    // 看后续牌（rabbit hunt）：弃牌结束的局间，任一玩家可逐步发出剩余公共牌仅供观看
    socket.on('rabbit_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.phase !== PHASES.SHOWDOWN) return;
        const n = game.communityCards.length;
        if (n >= 5) return;                       // 已到河牌（含真摊牌），无可发
        const count = n === 0 ? 3 : 1;            // 0→翻牌3张，3→转牌1张，4→河牌1张
        const dealt = dealCommunity(game, count);
        io.in(roomId).emit('server_msg', `🐰 看后续牌：${dealt.map(c => c.toString()).join(' ')}`);
        scheduleNextHand(roomId);                 // 重置局间倒计时，给看牌时间
        broadcastState(roomId);
    });

    socket.on('player_action', ({ roomId, action, amount }) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.actionOnIdx < 0 || game.players[game.actionOnIdx]?.userId !== user.id) {
            socket.emit('server_msg', '⚠️ 不是你的回合'); return;
        }

        const player = game.players[game.actionOnIdx];
        const tag = player.username;

        switch (action) {
            case 'fold':
                player.folded = true; player.hasActed = true;
                io.in(roomId).emit('server_msg', `❌ ${tag} 弃牌`);
                break;

            case 'check':
                if (player.currentBet < game.currentBet) {
                    socket.emit('server_msg', '⚠️ 有未跟注，不能 Check'); return;
                }
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `✓ ${tag} 过牌`);
                break;

            case 'call': {
                const toCall = game.currentBet - player.currentBet;
                if (toCall <= 0) { socket.emit('server_msg', '⚠️ 无需跟注'); return; }
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay; player.currentBet += pay;
                if (player.chips === 0) player.allIn = true;
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `📞 ${tag} 跟注 ${pay}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'bet': {
                if (game.currentBet > 0) { socket.emit('server_msg', '⚠️ 已有下注，请用 Raise'); return; }
                const betTo = parseInt(amount);
                const maxBet = player.currentBet + player.chips;   // 全下额
                const allInBet = betTo === maxBet;
                const minBet = gameBB(game);
                // 最小下注 = 大盲（不足大盲只能全下）
                if (!betTo || (betTo < minBet && !allInBet)) {
                    socket.emit('server_msg', `⚠️ 下注最少 ${minBet}`); return;
                }
                if (betTo > maxBet) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                player.chips -= betTo; player.currentBet = betTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = betTo;
                game.lastRaiseSize = betTo;   // 首注额即为后续最小加注增量基准
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `💸 ${tag} 下注 ${betTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'raise': {
                if (game.currentBet === 0) { socket.emit('server_msg', '⚠️ 无人下注，请用 Bet'); return; }
                const raiseTo = parseInt(amount);
                const maxRaise = player.currentBet + player.chips;          // 全下额
                const allInRaise = raiseTo === maxRaise;
                const minRaiseTo = game.currentBet + game.lastRaiseSize;    // 最小加注目标
                if (!raiseTo || raiseTo <= game.currentBet) {
                    socket.emit('server_msg', `⚠️ 加注须大于当前注 ${game.currentBet}`); return;
                }
                // 未达最小加注：仅当全下时允许（all-in for less）
                if (raiseTo < minRaiseTo && !allInRaise) {
                    socket.emit('server_msg', `⚠️ 至少加注到 ${minRaiseTo}（最小加注增量 ${game.lastRaiseSize}）`); return;
                }
                const needed = raiseTo - player.currentBet;
                if (needed > player.chips) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                const increment = raiseTo - game.currentBet;
                // 完整加注才刷新最小增量；all-in for less 不重开下注（保持原增量）
                if (increment >= game.lastRaiseSize) game.lastRaiseSize = increment;
                player.chips -= needed; player.currentBet = raiseTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = raiseTo;
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `🔼 ${tag} 加注到 ${raiseTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            default: return;
        }

        // 行动音效
        let sfxType = action;
        if ((action === 'bet' || action === 'raise' || action === 'call') && player.allIn) sfxType = 'allin';
        io.in(roomId).emit('sfx', sfxType);

        clearActionTimer(game);   // 玩家已行动，取消其计时
        afterAction(roomId);
    });

    // 加时：仅当前行动玩家可用，单次行动累计上限 EXTRA_MAX
    socket.on('add_time', (roomId) => {
        const game = roomGames[roomId];
        if (!game || game.actionOnIdx < 0) return;
        if (game.players[game.actionOnIdx]?.userId !== user.id) return;
        if ((game.extraAddedThisTurn || 0) >= EXTRA_MAX) {
            socket.emit('server_msg', '⚠️ 本次行动加时已达上限'); return;
        }
        const add = Math.min(EXTRA_STEP, EXTRA_MAX - game.extraAddedThisTurn);
        game.extraAddedThisTurn += add;
        game.actionDeadline += add;
        game.actionTotalMs = (game.actionTotalMs || ACTION_TIME) + add;
        clearActionTimer(game);
        game.actionTimer = setTimeout(() => onActionTimeout(roomId), Math.max(0, game.actionDeadline - Date.now()));
        io.in(roomId).emit('server_msg', `⏱ ${user.username} 加时 +${add / 1000}s`);
        broadcastState(roomId);
    });

    socket.on('disconnect', () => {
        console.log(`[-] ${user.username} 下线`);
        lobbySockets.delete(socket.id);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;
        const player = game.players[idx];
        player.away = true;   // 标记掉线（座位保留，可重连）

        io.to(roomId).emit('server_msg', `🔌 ${user.username} 掉线（保留座位，可重连）`);

        // 保留座位以便重连；不退还筹码（SNG 为比赛筹码）
        // 若牌局进行中，本局自动弃牌并推进
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            if (!player.folded) { player.folded = true; player.hasActed = true; }
            if (game.actionOnIdx === idx) {
                clearActionTimer(game);
                afterAction(roomId);
            } else if (isBettingRoundComplete(game)) {
                advanceStage(roomId);
            } else {
                broadcastState(roomId);
            }
        } else {
            broadcastState(roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 扑克服务器已启动！端口: ${PORT}`); });
