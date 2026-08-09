'use strict';
const { nameOf } = require('../account/display-name');

function createSeatService({ io, db, roomGames, lobbySockets, config, persistence, hooks }) {
    const { PHASES, BUYIN_RATE, CASHOUT_RATE, gameBB, timeCardsFor } = config;
    const { clampInt, broadcastState, broadcastRoomList, clearActionTimer, afterAction, isBettingRoundComplete, advanceStage, scheduleNextHand, liveCount, cashOut, recordLeft } = hooks;
// 站起围观：把玩家移出座位（座位腾空、可被他人坐下），转为观众；筹码存入 vacatedPlayers，
// 结束/解散时统一结算（不立即兑出）。与「留座离桌」(reserved, 保留座位) 区分。
function vacateSeat(game, idx) {
    const p = game.players[idx];
    if (!p) return;
    if (!game.vacatedPlayers) game.vacatedPlayers = [];
    if (p.reserveTimer) { clearTimeout(p.reserveTimer); p.reserveTimer = null; }
    game.vacatedPlayers.push({
        userId: p.userId, username: p.username, displayName: p.displayName || p.username, avatar: p.avatar || null,
        chips: p.chips, buyIn: p.buyIn || 0, handsPlayed: p.handsPlayed || 0, socketId: p.socketId,
        timeCards: p.timeCards || 0
    });
    game.players.splice(idx, 1);
    if (game.buttonIdx > idx) game.buttonIdx--;
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
    // 同步调整当前行动索引，避免 splice 后 actionOnIdx 指错人导致行动卡住/错位
    if (game.actionOnIdx > idx) game.actionOnIdx--;
    else if (game.actionOnIdx === idx) game.actionOnIdx = -1;   // 正被移除者恰是当前行动位（正常已改为 mid-hand 不 vacate，这里兜底）
}

// 让某座位玩家站起围观（自己主动 or 房主强制）。本手进行中一律延后离座(vacateAfter)，绝不 mid-hand splice。
function standUpPlayer(roomId, idx, byOwner) {
    const game = roomGames[roomId];
    if (!game) return;
    const p = game.players[idx];
    if (!p) return;
    const handInProgress = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    io.in(roomId).emit('server_msg', byOwner
        ? `🧍 房主请 ${p.username} 到观战席（座位空出，筹码保留至结束结算）`
        : `🧍 ${p.username} 站起围观（座位空出，筹码保留至结束结算）`);
    if (handInProgress) {
        // 本手进行中：延后到本手结束再真正离座（removeBustedPlayers 处理），避免 splice 打乱 actionOnIdx
        p.vacateAfter = true;
        // ⚠️ 已全押者绝不能改判弃牌：他的筹码已在池中、本就无需再行动，
        // 强行 folded 会剥夺其池权，并让「未跟注退还」把对手已被跟的注错误退回 → 凭空造筹码
        // （线上事故：room130674 h53，全押被跟后离座 → 对手多得 16508）。
        if (!p.folded && !p.allIn) {
            p.folded = true; p.hasActed = true;
            if (game.actionOnIdx === idx) { clearActionTimer(game); afterAction(roomId); }
            else if (isBettingRoundComplete(game)) advanceStage(roomId);
            else broadcastState(roomId);
        } else broadcastState(roomId);
    } else {
        vacateSeat(game, idx);   // 局间(WAITING/SHOWDOWN)：立即离座安全
        broadcastState(roomId);
    }
    broadcastRoomList();
    if (byOwner) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('server_msg', '⚠️ 房主已把你移到观战席（筹码保留，可点「回到座位」重新入座）');
    }
}

// 站起围观者回座：从 vacatedPlayers 取出、带原筹码放回一个空座（不重复扣买入），并清掉 vacated 记录。
// sit_down 和 sit_back 都走这里，避免「坐下新建 + 回座又恢复」产生两个自己。
// 返回 true 表示「本人是站起围观者、已处理（成功或明确无空座）」，调用方应就此 return，不再走普通入座。
function restoreVacatedPlayer(roomId, socket, user, preferSeat) {
    const game = roomGames[roomId];
    if (!game || !game.vacatedPlayers) return false;
    const vi = game.vacatedPlayers.findIndex(v => v.userId === user.id);
    if (vi < 0) return false;
    let seat = preferSeat;
    if (seat == null || seat < 0 || seat >= game.config.maxPlayers || occupiedSeats(game).has(seat)) seat = firstFreeSeat(game);
    if (seat < 0) { socket.emit('server_msg', '⚠️ 暂无空座，无法回座'); return true; }
    const vp = game.vacatedPlayers.splice(vi, 1)[0];
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    lobbySockets.delete(socket.id);
    socket.join(roomId); socket.currentRoom = roomId;
    game.players.push({
        userId: user.id, socketId: socket.id, username: user.username, displayName: user.displayName, seat,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips: vp.chips, currentBet: 0, buyIn: vp.buyIn, handsPlayed: vp.handsPlayed || 0,
        timeCards: vp.timeCards || 0,
        folded: inHand, allIn: false, hasActed: false, ready: false, sittingOut: vp.chips <= 0
    });
    io.in(roomId).emit('server_msg', `🪑 ${nameOf(user)} 回到座位（${seat + 1} 号位，带回原筹码）`);
    if (game.status === 'running' && !inHand && liveCount(game) >= 2) scheduleNextHand(roomId);
    broadcastState(roomId); broadcastRoomList();
    return true;
}

// 为某座位扣金币、登记挂起补码（下一手生效）。成功返回 true
function chargeRebuy(game, p, chips) {
    const fresh = db.getUserById(p.userId);
    if (!fresh) return false;
    const cost = Math.ceil(chips * BUYIN_RATE);
    if (fresh.gold < cost) return false;
    const roomId = Object.keys(roomGames).find(id => roomGames[id] === game);
    if (!roomId || !game.matchId) return false;
    const before = {
        pendingRebuy: p.pendingRebuy || 0,
        buyIn: p.buyIn || 0,
        buyInGold: p.buyInGold || 0,
        timeCards: p.timeCards || 0,
        rebuySeq: p.rebuySeq || 0
    };
    p.pendingRebuy = (p.pendingRebuy || 0) + chips;
    p.buyIn = (p.buyIn || 0) + chips;
    p.buyInGold = (p.buyInGold || 0) + cost;
    p.timeCards = (p.timeCards || 0) + timeCardsFor(game, chips);   // 补码同步补时间卡
    // ⚠️ 幂等序号不能用内存里的自增计数：玩家站起/回座、服务器重启都会重建座位对象让它归零，
    //    于是同一个 (比赛,玩家,序号) 键被复用 —— 金额不同就抛 IDEMPOTENCY_CONFLICT（补码白点一次），
    //    金额相同更糟：钱包直接返回「已处理过」不扣钱，而筹码照给 = 白拿。
    //    改成按【钱包账本里已有的条数】推导，跨重启/跨重新落座都唯一。
    const keyPrefix = `cash-rebuy:${game.matchId}:${p.userId}:`;
    p.rebuySeq = db.wallet.countOperations(keyPrefix) + 1;
    try {
        const committed = persistence.commitWithWallet(roomId, [{
            userId: p.userId,
            delta: -cost,
            type: 'cash_rebuy',
            matchId: game.matchId,
            operationKey: keyPrefix + p.rebuySeq,
            metadata: { chips }
        }], 'cash_rebuy', p.userId, { chips, cost });
        // 每次补码都是一次全新的付款：若钱包说「这个键早处理过」(applied=false)，
        // 说明这一次【并没有真的扣钱】——绝不能当成功给筹码，必须回滚。
        if (committed.wallets[0] && committed.wallets[0].applied === false) {
            throw new Error('REBUY_KEY_REUSED');
        }
        const balance = committed.wallets[0].balance;
        if (p.socketId) io.to(p.socketId).emit('gold_update', { gold: balance });
    } catch (error) {
        Object.assign(p, before);
        if (error.message !== 'INSUFFICIENT_GOLD') console.error('[wallet] cash rebuy failed', error);
        return false;
    }
    return true;
}

// 下一手前的座位清理：
// - 现金桌：主动离场者兑出移除；筹码归零者「保留座位坐出」（可补码回来），不淘汰
// - SNG：筹码归零者淘汰移除
function removeBustedPlayers(game) {
    const roomId = Object.keys(roomGames).find(id => roomGames[id] === game);
    for (let i = game.players.length - 1; i >= 0; i--) {
        const p = game.players[i];
        if (game.roomType === 'cash') {
            // 站起围观待腾位（本手结束）：移出座位到 vacatedPlayers，座位空出
            if (p.vacateAfter) { vacateSeat(game, i); continue; }
            // 自动补码：耗尽且开启 autoRebuy 且无挂起 → 自动按最小带入补一手
            if (p.chips <= 0 && p.autoRebuy && !(p.pendingRebuy > 0) && !p.leaving) {
                if (chargeRebuy(game, p, game.config.minBuyIn)) io.in(roomId).emit('server_msg', `🔁 ${nameOf(p)} 自动补码 ${game.config.minBuyIn}`);
            }
            // 有挂起补码：下一手生效（加筹码，取消坐出）
            if (p.pendingRebuy > 0) { p.chips += p.pendingRebuy; p.pendingRebuy = 0; p.sittingOut = false; }
            if (p.leaving) {
                recordLeft(game, p);   // 战绩面板灰显 + 结束排名
                const payout = cashOut(p);
                io.in(roomId).emit('server_msg', `🚪 ${nameOf(p)} 离场，兑出 ${payout} 金币`);
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) { s.leave(roomId); s.currentRoom = null; lobbySockets.add(s.id); s.emit('busted_out'); }
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            } else if (p.chips <= 0 && !p.sittingOut) {
                p.sittingOut = true;   // 坐出（保留座位），等补码
                io.in(roomId).emit('server_msg', `💤 ${nameOf(p)} 记分牌耗尽，坐出（可补码回来）`);
            }
        } else {
            if (p.chips <= 0) {
                recordLeft(game, p);   // SNG 淘汰顺序（用于结束排名：先淘汰=末名）
                io.in(roomId).emit('server_msg', `💀 ${nameOf(p)} 出局`);
                // 淘汰后【留在房间继续观战】：只把他移出座位，不再踢出 socket 房间。
                // 观众 = 房间内未在座者（见 listSpectators），所以 splice 之后他自动就是观众。
                // 多人 SNG（类似 FT）里被淘汰还想看朋友打完，硬踢回大厅体验很差。
                const s = io.sockets.sockets.get(p.socketId);
                if (s && s.currentRoom === roomId) s.emit('eliminated', { canSpectate: true });
                game.players.splice(i, 1);
                if (game.buttonIdx > i) game.buttonIdx--;
            }
        }
    }
    if (game.buttonIdx >= game.players.length) game.buttonIdx = 0;
}

function restoreReserveTimers(roomId) {
    const game = roomGames[roomId];
    if (!game) return;
    game.players.forEach(p => {
        if (!p.reserved || !p.reserveLeaveAt) return;
        clearTimeout(p.reserveTimer);
        p.reserveTimer = setTimeout(() => {
            const g = roomGames[roomId];
            const player = g && g.players.find(x => x.userId === p.userId);
            if (!player || !player.reserved) return;
            player.reserved = false;
            player.standing = true;
            player.sittingOut = true;
            player.reserveTimer = null;
            broadcastState(roomId);
            broadcastRoomList();
        }, Math.max(0, p.reserveLeaveAt - Date.now()));
    });
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// 以观众身份进桌（不入座、不带入）：用于现金桌「坐下式」入座
function joinAsSpectator(roomId, socket) {
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
    broadcastState(roomId);
    broadcastRoomList();
}

// 座位占用集合 / 找首个空座
function occupiedSeats(game) { return new Set(game.players.map(p => p.seat)); }
function firstFreeSeat(game) {
    const taken = occupiedSeats(game);
    for (let s = 0; s < game.config.maxPlayers; s++) if (!taken.has(s)) return s;
    return -1;
}

// 入座：SNG=扣报名费+固定起始筹码；现金桌=金币按汇率买入筹码
// seat=指定座位号（现金桌坐下式由客户端点选；不传则取首个空座）
function seatPlayer(roomId, socket, user, buyInChips, seat) {
    const game = roomGames[roomId];
    const fresh = db.getUserById(user.id);
    // 座位分配（固定座位号；客户端按 seat 环形定位）
    if (seat == null || seat < 0 || seat >= game.config.maxPlayers || occupiedSeats(game).has(seat)) {
        seat = firstFreeSeat(game);
    }
    if (seat < 0) { socket.emit('server_msg', '⚠️ 没有空座位'); return false; }
    let chips;
    let cost;
    let walletType;
    let operationKey;
    if (game.roomType === 'cash') {
        const maxB = game.config.maxBuyIn || 1e9;
        chips = clampInt(buyInChips, game.config.minBuyIn, maxB, game.config.minBuyIn);
        cost = Math.ceil(chips * BUYIN_RATE);
        if (fresh.gold < cost) { socket.emit('server_msg', `⚠️ 金币不足：买入 ${chips} 筹码需 ${cost} 金币（当前 ${fresh.gold}）`); return false; }
        walletType = 'cash_buyin';
        operationKey = `cash-buyin:${game.matchId}:${user.id}`;
    } else {
        const fee = game.config.buyIn || 0;
        if (fresh.gold < fee) { socket.emit('server_msg', `⚠️ 金币不足报名费 ${fee}（当前 ${fresh.gold}）`); return false; }
        cost = fee;
        walletType = 'sng_entry';
        operationKey = `sng-entry:${game.matchId}:${user.id}`;
        chips = game.config.startingStack;
    }
    lobbySockets.delete(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
    const newP = {
        userId: user.id, socketId: socket.id, username: user.username, displayName: user.displayName, seat,
        avatar: db.getUserById(user.id)?.avatar || null,
        chips, currentBet: 0, buyIn: chips, buyInGold: cost || 0,
        joinedAt: Date.now(),
        timeCards: timeCardsFor(game, chips),   // 按买入BB×时长发时间卡（加时消耗）
        folded: inHand, allIn: false, hasActed: false, ready: false   // 中途加入则本局坐出（下一局开局重置）
    };
    // 牌局进行中：追加到末尾（避免打乱在用的数组索引），坐出本手；局间则按座位插入
    let insertedAt;
    if (inHand) {
        game.players.push(newP);
        insertedAt = game.players.length - 1;
    } else {
        let ins = game.players.findIndex(p => p.seat > seat);
        if (ins < 0) ins = game.players.length;
        game.players.splice(ins, 0, newP);
        insertedAt = ins;
        if (ins <= game.buttonIdx) game.buttonIdx++;
    }
    if (game.roomType === 'sng' && cost > 0) game.prizePool = (game.prizePool || 0) + cost;
    try {
        const changes = cost > 0 ? [{
            userId: user.id,
            delta: -cost,
            type: walletType,
            matchId: game.matchId,
            operationKey,
            metadata: { chips, roomId }
        }] : [];
        const committed = changes.length
            ? persistence.commitWithWallet(roomId, changes, walletType, user.id, { chips, cost })
            : { wallets: [], match: persistence.commit(roomId, 'player_seated', user.id, { chips }) };
        if (changes.length) {
            user.gold = committed.wallets[0].balance;
            socket.emit('gold_update', { gold: user.gold });
        }
    } catch (error) {
        const idx = game.players.indexOf(newP);
        if (idx >= 0) game.players.splice(idx, 1);
        if (!inHand && insertedAt <= game.buttonIdx && game.buttonIdx > 0) game.buttonIdx--;
        if (game.roomType === 'sng' && cost > 0) game.prizePool = Math.max(0, game.prizePool - cost);
        if (error.message === 'INSUFFICIENT_GOLD') socket.emit('server_msg', '⚠️ 金币不足');
        else console.error('[wallet] seat buy-in failed', error);
        return false;
    }
    socket.emit('room_joined', { roomId, canPlay: socket.playRoom === roomId });
    socket.to(roomId).emit('server_msg', `🪑 ${nameOf(user)} 入座 ${seat + 1} 号位`);
    broadcastState(roomId);
    broadcastRoomList();
    return true;
}

    return { vacateSeat, standUpPlayer, restoreVacatedPlayer, chargeRebuy, removeBustedPlayers, restoreReserveTimers, joinAsSpectator, occupiedSeats, firstFreeSeat, seatPlayer };
}

module.exports = { createSeatService };
