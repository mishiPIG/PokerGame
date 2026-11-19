'use strict';
const { normalizeVariant } = require('../../games/poker/variants');
// 房间名是房主自己输入的，会出现在大厅列表、牌桌水印、管理面板、收件箱里。
// 能拼出 HTML / 跳出 JS 字符串的字符直接去掉（客户端也会转义，这是第二道）。
// 建房上限。没有它的话一个人可以开到房间码用完（4 位码 = 1 万个），之后谁都建不了房；
// 而且每个房间都常驻内存，1G 的生产机经不起刷。
const MAX_ROOMS_PER_OWNER = 3;
const MAX_ROOMS_TOTAL = 300;
// 游客同时只能开 1 个房间：全服一共 300 个房间的名额，游客号谁都能建，
// 每个游客都给 3 个的话，一百个游客号就能把名额占满、谁都开不了房。
const MAX_ROOMS_GUEST = 1;
const roomCapFor = (user) => (user.isGuest ? MAX_ROOMS_GUEST : MAX_ROOMS_PER_OWNER);
function roomLimitReached(roomGames, user) {
    const live = Object.values(roomGames).filter(g => !g.tournamentOver);
    if (live.length >= MAX_ROOMS_TOTAL) return 'room.serverFull';
    if (live.filter(g => g.ownerUserId === user.id).length >= roomCapFor(user)) {
        return user.isGuest ? 'room.guestOneRoom' : 'room.tooManyMine';
    }
    return null;
}
const cleanRoomName = (v) => (v == null ? '' : String(v)).replace(/[<>"'`&\\]/g, '').trim().slice(0, 20);
const { bind } = require('./room-context');
const { initialFair } = require('../../games/poker/provably-fair');
const { offerRematch, REMATCH_TTL_MS } = require('../rematch-invites');
const { nameOf } = require('../../account/display-name');

function registerLobbyEvents(context) {
    const { socket, user, io, roomGames, lobbySockets, listRooms, genRoomId, Deck, PHASES, createRoomInvite, clampInt, SNG_BUYIN_TIERS, STANDARD_BLIND_LEVELS, authorize, seatPlayer, emitRoomInviteInfo, joinAsSpectator, persistence } = bind(context);
    // 进入大厅：订阅房间列表
    socket.on('enter_lobby', () => {
        lobbySockets.add(socket.id);
        context.tableService.leavePreviousRoom(socket);   // 真的离开原来的 socket.io 房间，不只是把 currentRoom 清空
        socket.emit('room_list', listRooms(user.id));
    });

    // 创建 SNG 房间（双人升盲），创建者自动入座
    // 开一张 SNG。「再来一局」也走这里（同样的校验、同样的建房），返回新房间号或 null。
    function createSngRoom(cfg) {
        cfg = cfg || {};
        const limit = roomLimitReached(roomGames, user);
        if (limit) { socket.emit('server_msg', { k: limit, p: { n: roomCapFor(user) } }); return null; }
        const roomId = genRoomId();
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            // 可验证公平：房间一建好就备好承诺，这样【第一手】的 commit 也是发牌之前就公开的。
            // （放到 startHand 里才创建的话，第一手的承诺和发牌是同一瞬间，玩家根本来不及先看到它。）
            fair: initialFair(),
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'sng', status: 'waiting',
            ownerUserId: user.id, ownerName: user.displayName || user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            kicked: new Set(),
            config: {
            // 谁能进：private（默认）= 沿用「列表只观战、下场必须输四位码」；
            //         public = 从发现页点进来就能坐下。
            // 🔴 默认私密：默认值决定 90% 的结果。把「陌生人能坐进我的局」设成默认，
            //    一旦出事就是信任事故 —— 而信任事故比冷启动难修得多。
            visibility: cfg.visibility === 'public' ? 'public' : 'private',
                name:        cleanRoomName(cfg.name) || `${user.displayName || user.username}的比赛`,
                maxPlayers:  clampInt(cfg.maxPlayers, 2, 9, 2),              // 2–9 人（引擎已支持多人）
                startingStack: clampInt(cfg.startingStack, 5000, 30000, 10000),
                levelMinutes:  clampInt(cfg.levelMinutes, 3, 10, 3),
                buyIn:         SNG_BUYIN_TIERS.includes(+cfg.buyIn) ? +cfg.buyIn : SNG_BUYIN_TIERS[0],
                actionTimeSec: context.config.pickActionTimeSec(cfg.actionTimeSec),   // 每次行动的思考时间（秒）
                // 玩法（德州 / 短牌 / 奥马哈）：建房时定，之后不可改（见 games/poker/variants）
                variant: normalizeVariant(cfg.variant)
            },
            blindLevels: STANDARD_BLIND_LEVELS,
            currentLevel: 0, levelStartTime: null, prizePool: 0, tournamentOver: false,
            statsHistory: []
        };
        persistence.createMatch(roomId, roomGames[roomId]);
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格
        if (!seatPlayer(roomId, socket, user)) {
            persistence.finish(roomId, 'cancelled');
            delete roomGames[roomId];
            return null;
        }
        emitRoomInviteInfo(socket, roomGames[roomId], true);
        return roomId;
    }
    socket.on('create_room', (cfg) => { createSngRoom(cfg); });

    // SNG 打完「再来一局」（2026-11-17）：房主一点，用同样设置开新桌，上一场还停在结算页的人收到邀请。
    // 报名费照常扣（落座时扣，和正常建房 / 入座完全同一条路）。
    socket.on('rematch_sng', () => {
        const oldId = socket.currentRoom;
        const old = oldId && roomGames[oldId];
        // 🔴 只有房主、只有已经打完的 SNG、每场只能发起一次
        if (!old || old.roomType !== 'sng' || !old.tournamentOver || old.ownerUserId !== user.id) return;
        if (old.rematchRoomId && roomGames[old.rematchRoomId]) return;
        const c = old.config || {};
        // 先记下上一场还连着这张桌的人（房主建新桌时会离开旧桌）
        const ids = new Set([...(old.players || []), ...(old.statsHistory || [])].map(p => p.userId));
        ids.delete(user.id);
        const here = [];
        for (const sid of io.sockets.adapter.rooms.get(oldId) || []) {
            const s = io.sockets.sockets.get(sid);
            if (s && s.user && ids.has(s.user.id)) here.push(s);
        }
        const newId = createSngRoom({ name: c.name, visibility: c.visibility, maxPlayers: c.maxPlayers,
            startingStack: c.startingStack, levelMinutes: c.levelMinutes, buyIn: c.buyIn, actionTimeSec: c.actionTimeSec, variant: c.variant });
        if (!newId) return;
        old.rematchRoomId = newId;
        const expiresAt = Date.now() + REMATCH_TTL_MS;
        for (const s of here) {
            offerRematch(newId, s.user.id, user.id);
            // ⚠️ 不带房间码（理由同牌友邀请）：拿到下场资格靠服务端那条待办记录，不靠码
            s.emit('rematch_offer', { roomId: newId, fromName: nameOf(user), buyIn: c.buyIn, maxPlayers: c.maxPlayers, expiresAt });
        }
    });

    // 创建现金桌（2–9 人，固定盲注，金币↔筹码买入），创建者按 buyInChips 买入
    socket.on('create_cash_room', (cfg) => {
        cfg = cfg || {};
        const limit = roomLimitReached(roomGames, user);
        if (limit) { socket.emit('server_msg', { k: limit, p: { n: roomCapFor(user) } }); return; }
        const roomId = genRoomId();
        const bb = clampInt(cfg.bb, 20, 1000, 40);
        const sb = clampInt(cfg.sb, 10, bb, Math.floor(bb / 2));
        const minBuyIn = clampInt(cfg.minBuyIn, 2000, 8000, 2000);
        const maxBuyIn = clampInt(cfg.maxBuyIn, 0, 60000, 0);   // 0=无限制
        roomGames[roomId] = {
            deck: new Deck(), players: [], phase: PHASES.WAITING,
            // 可验证公平：房间一建好就备好承诺，这样【第一手】的 commit 也是发牌之前就公开的。
            // （放到 startHand 里才创建的话，第一手的承诺和发牌是同一瞬间，玩家根本来不及先看到它。）
            fair: initialFair(),
            holeCards: {}, communityCards: [], pot: 0, currentBet: 0,
            buttonIdx: 0, buttonSeat: -1, actionOnIdx: -1,
            roomType: 'cash', status: 'waiting',
            ownerUserId: user.id, ownerName: user.displayName || user.username,
            authorized: new Set([user.id]),
            invite: createRoomInvite(roomId),
            kicked: new Set(),
            config: {
            // 谁能进：private（默认）= 沿用「列表只观战、下场必须输四位码」；
            //         public = 从发现页点进来就能坐下。
            // 🔴 默认私密：默认值决定 90% 的结果。把「陌生人能坐进我的局」设成默认，
            //    一旦出事就是信任事故 —— 而信任事故比冷启动难修得多。
            visibility: cfg.visibility === 'public' ? 'public' : 'private',
                name:      cleanRoomName(cfg.name) || `${user.displayName || user.username}的现金桌`,
                maxPlayers: clampInt(cfg.maxPlayers, 2, 9, 6),
                sb, bb, ante: clampInt(cfg.ante, 0, 80, 0), minBuyIn, maxBuyIn,
                allowUtgStraddle: cfg.allowUtgStraddle === true,
                durationH: [0.5, 1, 2, 3, 4, 5, 6].includes(+cfg.durationH) ? +cfg.durationH : 2,
                approveBuyIn: cfg.approveBuyIn === true,   // 带入 / 补码需房主批准（默认关）
                // 7-2 奖励：0 = 关；1 / 2 / 5 = 用 7-2 赢下底池时其余每人付几个大盲（见 extensions/seven-deuce.js）
                // 7-2 奖励只在德州：短牌没有 2、奥马哈手里是 4 张，都不会发生，干脆不让开（免得有人开了一个不会生效的设置）
                sevenDeuceBB: normalizeVariant(cfg.variant) === 'nlhe' && [0, 1, 2, 5].includes(Number(cfg.sevenDeuceBB)) ? Number(cfg.sevenDeuceBB) : 0,
                // Bomb pot：每 N 手一次（0 = 不自动；房主也可以随时点「下一手 Bomb」）、每人放几个大盲（见 extensions/bomb-pot.js）
                bombEvery: [0, 5, 10, 20].includes(Number(cfg.bombEvery)) ? Number(cfg.bombEvery) : 0,
                bombBB: [2, 5, 10].includes(Number(cfg.bombBB)) ? Number(cfg.bombBB) : 2,
                variant: normalizeVariant(cfg.variant),   // 玩法：建房时定，之后不可改
                actionTimeSec: context.config.pickActionTimeSec(cfg.actionTimeSec)   // 每次行动的思考时间（秒）
            },
            prizePool: 0, tournamentOver: false,
            statsHistory: [], tableEndAt: null, extraMs: 0, timeExpired: false
        };
        persistence.createMatch(roomId, roomGames[roomId]);
        // 现金桌：房主先以观众身份进桌，点空座位「坐下」再带入（坐下式入座）
        socket.playRoom = roomId; authorize(roomId, user.id);   // 房主有下场资格（无需再输房号）
        joinAsSpectator(roomId, socket);
        emitRoomInviteInfo(socket, roomGames[roomId], true);
    });


}
module.exports = { registerLobbyEvents };
