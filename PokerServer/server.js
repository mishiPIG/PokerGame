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
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const PHASES = {
    WAITING:  'waiting',
    PREFLOP:  'preflop',
    FLOP:     'flop',
    TURN:     'turn',
    RIVER:    'river',
    SHOWDOWN: 'showdown'
};

const SMALL_BLIND = 10;
const BIG_BLIND   = 20;
const JWT_SECRET  = process.env.JWT_SECRET || 'poker-dev-secret-change-in-prod';

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
}

function broadcastState(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    const state = {
        phase: game.phase,
        pot: game.pot,
        currentBet: game.currentBet,
        smallBlind: SMALL_BLIND,
        bigBlind: BIG_BLIND,
        buttonUserId:   game.players[game.buttonIdx]?.userId || null,
        actionOnUserId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.userId || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            userId:     p.userId,
            username:   p.username,
            chips:      p.chips,
            currentBet: p.currentBet,
            folded:     p.folded,
            allIn:      p.allIn
        }))
    };
    io.in(roomId).emit('game_state', state);
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
    while (true) {
        const active = activePlayers(game);
        if (active.length <= 1) {
            collectBetsToPot(game);
            if (active.length === 1) {
                const winner = active[0];
                winner.chips += game.pot;
                io.in(roomId).emit('server_msg', `🏆 ${winner.username} 赢得底池 ${game.pot}（对手弃牌）`);
            }
            game.pot = 0;
            game.phase = PHASES.SHOWDOWN;
            game.actionOnIdx = -1;
            broadcastState(roomId);
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
        game.actionOnIdx = findNextActionIdx(game, game.buttonIdx);
        if (game.actionOnIdx < 0) continue;
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
    io.in(roomId).emit('showdown_reveal', reveals);

    const split = Math.floor(game.pot / winners.length);
    const remainder = game.pot - split * winners.length;
    winners.forEach((w, i) => { w.chips += split + (i === 0 ? remainder : 0); });

    const winnerLabel = winners.map(w => w.username).join(', ');
    io.in(roomId).emit('server_msg',
        `🏆 ${winnerLabel} 赢得底池 ${game.pot}${winners.length > 1 ? `（平分每人 ${split}）` : ''}`);

    game.pot = 0;
    game.actionOnIdx = -1;
    broadcastState(roomId);
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

    socket.on('join_room', ({ roomId, buyIn }) => {
        const buyInAmount = Math.max(BIG_BLIND * 10, parseInt(buyIn) || 1000);
        const freshUser = db.getUserById(user.id);

        if (freshUser.gold < buyInAmount) {
            socket.emit('server_msg', `⚠️ 金币不足（当前 ${freshUser.gold}，需要 ${buyInAmount}）`);
            return;
        }

        // 断线重连：玩家已在房间内
        const existing = roomGames[roomId];
        if (existing?.players.some(p => p.userId === user.id)) {
            const p = existing.players.find(p => p.userId === user.id);
            p.socketId = socket.id;
            socket.join(roomId);
            socket.currentRoom = roomId;
            socket.emit('server_msg', '🔄 重新连接成功');
            if (existing.holeCards[user.id]) {
                socket.emit('hole_cards', existing.holeCards[user.id].map(c => ({ suit: c.suit, rank: c.rank })));
            }
            broadcastState(roomId);
            return;
        }

        if (existing && existing.phase !== PHASES.WAITING && existing.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', '⚠️ 当前牌局进行中，请等本局结束再加入');
            return;
        }

        socket.join(roomId);
        socket.currentRoom = roomId;

        if (!roomGames[roomId]) {
            roomGames[roomId] = {
                deck: new Deck(),
                players: [],
                phase: PHASES.WAITING,
                holeCards: {},
                communityCards: [],
                pot: 0,
                currentBet: 0,
                buttonIdx: 0,
                actionOnIdx: -1
            };
        }

        const game = roomGames[roomId];
        const newGold = freshUser.gold - buyInAmount;
        db.setGold(user.id, newGold);
        user.gold = newGold;

        game.players.push({
            userId:     user.id,
            socketId:   socket.id,
            username:   user.username,
            chips:      buyInAmount,
            currentBet: 0,
            folded:     false,
            allIn:      false,
            hasActed:   false
        });

        socket.emit('server_msg', `✅ 加入房间 [${roomId}]，带入 ${buyInAmount}`);
        socket.emit('gold_update', { gold: user.gold });
        socket.to(roomId).emit('server_msg', `🪑 ${user.username} 加入牌桌（${buyInAmount}）`);
        broadcastState(roomId);
    });

    socket.on('start_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.players.length < 2) { socket.emit('server_msg', '⚠️ 至少需要 2 位玩家'); return; }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', `⚠️ 当前阶段 [${game.phase}] 无法开新局`); return;
        }
        if (game.phase === PHASES.SHOWDOWN)
            game.buttonIdx = (game.buttonIdx + 1) % game.players.length;

        if (game.players.some(p => p.chips < BIG_BLIND)) {
            socket.emit('server_msg', `⚠️ 有玩家筹码不足大盲 ${BIG_BLIND}`); return;
        }

        game.deck.reset(); game.deck.shuffle();
        game.holeCards = {}; game.communityCards = [];
        game.pot = 0; game.currentBet = 0;
        game.players.forEach(p => {
            p.currentBet = 0; p.folded = false; p.allIn = false; p.hasActed = false;
        });
        game.phase = PHASES.PREFLOP;

        // 标准 heads-up：按钮位 = SB，preflop 先动
        const sbIdx = game.buttonIdx;
        const bbIdx = (game.buttonIdx + 1) % game.players.length;
        const sb = game.players[sbIdx];
        const bb = game.players[bbIdx];
        const sbAmt = Math.min(SMALL_BLIND, sb.chips);
        const bbAmt = Math.min(BIG_BLIND, bb.chips);
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
                if (!betTo || betTo < BIG_BLIND) { socket.emit('server_msg', `⚠️ 下注最少 ${BIG_BLIND}`); return; }
                if (betTo > player.chips) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
                player.chips -= betTo; player.currentBet = betTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = betTo;
                game.players.forEach(p => { if (p.userId !== user.id && canAct(p)) p.hasActed = false; });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `💸 ${tag} 下注 ${betTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'raise': {
                if (game.currentBet === 0) { socket.emit('server_msg', '⚠️ 无人下注，请用 Bet'); return; }
                const raiseTo = parseInt(amount);
                if (!raiseTo || raiseTo <= game.currentBet) {
                    socket.emit('server_msg', `⚠️ 加注须大于当前注 ${game.currentBet}`); return;
                }
                const needed = raiseTo - player.currentBet;
                if (needed > player.chips) { socket.emit('server_msg', '⚠️ 筹码不足'); return; }
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

        if (isBettingRoundComplete(game)) {
            advanceStage(roomId);
        } else {
            game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
            broadcastState(roomId);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[-] ${user.username} 下线`);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.userId === user.id);
        if (idx < 0) return;

        io.to(roomId).emit('server_msg', `🚪 ${user.username} 离开`);
        const player = game.players[idx];

        // 退还筹码到金币
        const freshGold = db.getUserById(user.id).gold;
        db.setGold(user.id, freshGold + player.chips);

        if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) {
            game.players.splice(idx, 1);
            if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
            broadcastState(roomId);
        } else {
            player.folded = true; player.hasActed = true; player.chips = 0;
            if (isBettingRoundComplete(game)) { advanceStage(roomId); return; }
            if (game.actionOnIdx === idx)
                game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
            broadcastState(roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 扑克服务器已启动！端口: ${PORT}`); });
