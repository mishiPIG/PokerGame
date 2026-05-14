const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Deck, HandEvaluator } = require('./PokerLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

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
const BIG_BLIND = 20;

const roomGames = {};

// ===== 工具函数 =====

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
    if (canStill.length === 0) return true; // 所有人都 all-in
    return canStill.every(p => p.hasActed && p.currentBet === game.currentBet);
}

// 把本街的 currentBet 收进 pot；未被跟注的部分退还给玩家（2人版替代边池）
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
            p.chips += (p.currentBet - contribute); // 退还未被跟注的部分
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
        buttonId: game.players[game.buttonIdx]?.id || null,
        actionOnId: game.actionOnIdx >= 0 ? (game.players[game.actionOnIdx]?.id || null) : null,
        communityCards: game.communityCards.map(c => ({ suit: c.suit, rank: c.rank })),
        players: game.players.map(p => ({
            id: p.id,
            chips: p.chips,
            currentBet: p.currentBet,
            folded: p.folded,
            allIn: p.allIn
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

        // 只剩一人 → 直接结束本局
        if (active.length <= 1) {
            collectBetsToPot(game);
            if (active.length === 1) {
                const winner = active[0];
                winner.chips += game.pot;
                io.in(roomId).emit('server_msg', `🏆 ${winner.id.substring(0, 4)} 赢得底池 ${game.pot}（对手弃牌）`);
            }
            game.pot = 0;
            game.phase = PHASES.SHOWDOWN;
            game.actionOnIdx = -1;
            broadcastState(roomId);
            return;
        }

        collectBetsToPot(game);

        // 阶段切换
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

        // 双人 postflop：行动先手是非按钮位（大盲位置）
        // 通用：从按钮位顺时针第一个能行动的人
        game.actionOnIdx = findNextActionIdx(game, game.buttonIdx);

        // 没人能行动了（双方都 all-in）→ 直接进入下一阶段
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
        const sevenCards = game.communityCards.concat(game.holeCards[p.id]);
        const score = HandEvaluator.evaluate7Cards(sevenCards);
        return { player: p, score };
    });

    const bestScore = Math.min(...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === bestScore).map(s => s.player);

    scored.forEach(({ player, score }) => {
        const hole = game.holeCards[player.id];
        io.in(roomId).emit('server_msg', `📊 ${player.id.substring(0, 4)}: ${hole[0].toString()}, ${hole[1].toString()} → 得分 ${score}`);
    });

    const split = Math.floor(game.pot / winners.length);
    const remainder = game.pot - split * winners.length;
    winners.forEach((w, i) => {
        w.chips += split + (i === 0 ? remainder : 0);
    });
    const winnerLabel = winners.map(w => w.id.substring(0, 4)).join(', ');
    io.in(roomId).emit('server_msg', `🏆 ${winnerLabel} 赢得底池 ${game.pot}${winners.length > 1 ? `（平分每人 ${split}）` : ''}`);

    game.pot = 0;
    game.actionOnIdx = -1;
    broadcastState(roomId);
}

// ===== Socket 处理 =====

io.on('connection', (socket) => {
    console.log(`[+] 玩家上线: ${socket.id}`);

    socket.on('join_room', ({ roomId, buyIn }) => {
        const buyInAmount = Math.max(BIG_BLIND * 5, parseInt(buyIn) || 1000);

        const existing = roomGames[roomId];
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
        if (!game.players.some(p => p.id === socket.id)) {
            game.players.push({
                id: socket.id,
                chips: buyInAmount,
                currentBet: 0,
                folded: false,
                allIn: false,
                hasActed: false
            });
        }

        socket.emit('server_msg', `✅ 加入房间 [${roomId}]，带入 ${buyInAmount}`);
        socket.to(roomId).emit('server_msg', `🪑 玩家 ${socket.id.substring(0, 4)} 加入（${buyInAmount}）`);
        broadcastState(roomId);
    });

    socket.on('start_deal', (roomId) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.players.length < 2) {
            socket.emit('server_msg', '⚠️ 至少需要 2 位玩家');
            return;
        }
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) {
            socket.emit('server_msg', `⚠️ 当前阶段 [${game.phase}] 无法开新局`);
            return;
        }

        // 第二局起庄家位顺移
        if (game.phase === PHASES.SHOWDOWN) {
            game.buttonIdx = (game.buttonIdx + 1) % game.players.length;
        }

        // 检查筹码
        const broke = game.players.filter(p => p.chips < BIG_BLIND);
        if (broke.length > 0) {
            socket.emit('server_msg', `⚠️ 有玩家筹码不足大盲 ${BIG_BLIND}`);
            return;
        }

        // 重置
        game.deck.reset();
        game.deck.shuffle();
        game.holeCards = {};
        game.communityCards = [];
        game.pot = 0;
        game.currentBet = 0;
        game.players.forEach(p => {
            p.currentBet = 0;
            p.folded = false;
            p.allIn = false;
            p.hasActed = false;
        });

        game.phase = PHASES.PREFLOP;

        // 标准 heads-up 规则：按钮位 = 小盲(SB)，preflop 先动；非按钮位 = 大盲(BB)，postflop 先动。
        // 3+人需另外实现 SB=(button+1)%N, BB=(button+2)%N
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
        io.in(roomId).emit('server_msg', `💰 SB: ${sb.id.substring(0, 4)} (${sbAmt}) | BB: ${bb.id.substring(0, 4)} (${bbAmt})`);

        // 发底牌
        game.players.forEach(p => {
            const c1 = game.deck.drawCard();
            const c2 = game.deck.drawCard();
            game.holeCards[p.id] = [c1, c2];
            io.to(p.id).emit('hole_cards', [
                { suit: c1.suit, rank: c1.rank },
                { suit: c2.suit, rank: c2.rank }
            ]);
        });

        // 双人 preflop 行动顺序：SB（=按钮）先动
        game.actionOnIdx = sbIdx;

        broadcastState(roomId);
    });

    socket.on('player_action', ({ roomId, action, amount }) => {
        const game = roomGames[roomId];
        if (!game) return;
        if (game.actionOnIdx < 0 || game.players[game.actionOnIdx]?.id !== socket.id) {
            socket.emit('server_msg', '⚠️ 不是你的回合');
            return;
        }

        const player = game.players[game.actionOnIdx];
        const tag = player.id.substring(0, 4);

        switch (action) {
            case 'fold':
                player.folded = true;
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `❌ ${tag} 弃牌`);
                break;

            case 'check':
                if (player.currentBet < game.currentBet) {
                    socket.emit('server_msg', '⚠️ 有未跟注，不能 Check');
                    return;
                }
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `✓ ${tag} 过牌`);
                break;

            case 'call': {
                const toCall = game.currentBet - player.currentBet;
                if (toCall <= 0) {
                    socket.emit('server_msg', '⚠️ 无需跟注，请 Check');
                    return;
                }
                const pay = Math.min(toCall, player.chips);
                player.chips -= pay;
                player.currentBet += pay;
                if (player.chips === 0) player.allIn = true;
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `📞 ${tag} 跟注 ${pay}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'bet': {
                if (game.currentBet > 0) {
                    socket.emit('server_msg', '⚠️ 已有下注，请用 Raise');
                    return;
                }
                const betTo = parseInt(amount);
                if (!betTo || betTo < BIG_BLIND) {
                    socket.emit('server_msg', `⚠️ 下注最少 ${BIG_BLIND}`);
                    return;
                }
                if (betTo > player.chips) {
                    socket.emit('server_msg', '⚠️ 筹码不足');
                    return;
                }
                player.chips -= betTo;
                player.currentBet = betTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = betTo;
                game.players.forEach(p => {
                    if (p.id !== player.id && canAct(p)) p.hasActed = false;
                });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `💸 ${tag} 下注 ${betTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            case 'raise': {
                if (game.currentBet === 0) {
                    socket.emit('server_msg', '⚠️ 当前无人下注，请用 Bet');
                    return;
                }
                const raiseTo = parseInt(amount);
                if (!raiseTo || raiseTo <= game.currentBet) {
                    socket.emit('server_msg', `⚠️ 加注须大于当前注 ${game.currentBet}`);
                    return;
                }
                const needed = raiseTo - player.currentBet;
                if (needed > player.chips) {
                    socket.emit('server_msg', '⚠️ 筹码不足');
                    return;
                }
                player.chips -= needed;
                player.currentBet = raiseTo;
                if (player.chips === 0) player.allIn = true;
                game.currentBet = raiseTo;
                game.players.forEach(p => {
                    if (p.id !== player.id && canAct(p)) p.hasActed = false;
                });
                player.hasActed = true;
                io.in(roomId).emit('server_msg', `🔼 ${tag} 加注到 ${raiseTo}${player.allIn ? ' (All-in)' : ''}`);
                break;
            }

            default:
                socket.emit('server_msg', '⚠️ 未知动作');
                return;
        }

        if (isBettingRoundComplete(game)) {
            advanceStage(roomId);
        } else {
            game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
            broadcastState(roomId);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[-] 玩家下线: ${socket.id}`);
        const roomId = socket.currentRoom;
        if (!roomId) return;
        const game = roomGames[roomId];
        if (!game) return;
        const idx = game.players.findIndex(p => p.id === socket.id);
        if (idx < 0) return;

        io.to(roomId).emit('server_msg', `🚪 玩家 ${socket.id.substring(0, 4)} 离开`);

        if (game.phase === PHASES.WAITING || game.phase === PHASES.SHOWDOWN) {
            game.players.splice(idx, 1);
            if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
            broadcastState(roomId);
        } else {
            // 进行中：标记为弃牌保留座位（保持索引）
            const p = game.players[idx];
            p.folded = true;
            p.hasActed = true;

            if (isBettingRoundComplete(game)) {
                advanceStage(roomId);
                return;
            }
            if (game.actionOnIdx === idx) {
                game.actionOnIdx = findNextActionIdx(game, game.actionOnIdx);
            }
            broadcastState(roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 权威扑克服务器已启动！端口: ${PORT}`); });
