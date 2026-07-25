'use strict';

const crypto = require('node:crypto');

function createLobbyService({ io, runtime, config }) {
    const { roomGames, lobbySockets, inviteCodeFailuresByUser, inviteCodeFailuresByIp } = runtime;
    const { PHASES, CONFIGURED_PUBLIC_ORIGIN } = config;
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

function genJoinCode(excludeRoomId = '', disallowedCode = '') {
    // 四位码只需在活跃房间中唯一；保留前导零。
    for (let attempts = 0; attempts < 20000; attempts++) {
        const code = String(crypto.randomInt(10000)).padStart(4, '0');
        if (code === disallowedCode) continue;
        const used = Object.entries(roomGames).some(([roomId, game]) =>
            roomId !== excludeRoomId && game.invite?.joinCode === code);
        if (!used) return code;
    }
    throw new Error('无法生成唯一房间码：活跃房间过多');
}

function createRoomInvite(excludeRoomId = '', disallowedCode = '') {
    return {
        token: crypto.randomBytes(16).toString('base64url'),
        joinCode: genJoinCode(excludeRoomId, disallowedCode),
        entryLocked: false,
        version: 1,
        createdAt: Date.now()
    };
}

function findRoomByInviteToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    return Object.entries(roomGames).find(([, game]) => game.invite?.token === token) || null;
}

function findRoomByJoinCode(code) {
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return null;
    return Object.entries(roomGames).find(([, game]) => game.invite?.joinCode === code) || null;
}

function emitRoomInviteInfo(socket, game, autoOpen = false) {
    if (!game || game.ownerUserId !== socket.user?.id || !game.invite) return;
    const requestOrigin = String(socket.handshake.headers.origin || '');
    const publicOrigin = CONFIGURED_PUBLIC_ORIGIN
        || (/^https?:\/\/[^/]+$/i.test(requestOrigin) ? requestOrigin : 'https://pokerdojo.space');
    socket.emit('room_invite_info', {
        joinCode: game.invite.joinCode,
        inviteUrl: `${publicOrigin}/#/join/${game.invite.token}`,
        entryLocked: !!game.invite.entryLocked,
        version: game.invite.version,
        autoOpen
    });
}

function clientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    return String(forwarded || socket.handshake.address || '').split(',')[0].trim();
}

function recentFailures(map, key, windowMs) {
    const cutoff = Date.now() - windowMs;
    const recent = (map.get(key) || []).filter(ts => ts > cutoff);
    if (recent.length) map.set(key, recent);
    else map.delete(key);
    return recent;
}

function codeAttemptLimited(socket, userId) {
    return recentFailures(inviteCodeFailuresByUser, userId, 60_000).length >= 5
        || recentFailures(inviteCodeFailuresByIp, clientIp(socket), 600_000).length >= 20;
}

function recordCodeFailure(socket, userId) {
    const ip = clientIp(socket);
    inviteCodeFailuresByUser.set(userId, [...recentFailures(inviteCodeFailuresByUser, userId, 60_000), Date.now()]);
    inviteCodeFailuresByIp.set(ip, [...recentFailures(inviteCodeFailuresByIp, ip, 600_000), Date.now()]);
}

function clearUserCodeFailures(userId) {
    inviteCodeFailuresByUser.delete(userId);
}

function canAuthorizeNewUser(game, userId) {
    if (!game || game.status === 'finished') return false;
    if (game.authorized?.has(userId)) return true;
    if (game.invite?.entryLocked) return false;
    if (game.roomType === 'sng') {
        if (game.status === 'running' || game.players.length >= game.config.maxPlayers) return false;
        if (game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN) return false;
    }
    return true;
}

// 记住"有下场资格"的用户（房主/验证过邀请/坐过）：即使退到大厅，列表仍显示「重新加入」
function authorize(roomId, userId) {
    const g = roomGames[roomId];
    if (!g) return;
    if (!g.authorized) g.authorized = new Set();
    g.authorized.add(userId);
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
        sb:         g.config?.sb || 0,
        bb:         g.config?.bb || 0,
        ante:       g.config?.ante || 0,
        allowUtgStraddle: !!g.config?.allowUtgStraddle,
        minBuyIn:   g.config?.minBuyIn || 0,
        // 我是否本房成员/有下场资格（在座 / 站起 / 输过房号授权）→ 列表显示「重新加入」而非「观战」
        isMember:   !!(userId && (g.players.some(p => p.userId === userId)
                    || (g.vacatedPlayers || []).some(v => v.userId === userId)
                    || (g.authorized && g.authorized.has(userId))))
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


    return { clampInt, genRoomId, genJoinCode, createRoomInvite, findRoomByInviteToken, findRoomByJoinCode, emitRoomInviteInfo, clientIp, recentFailures, codeAttemptLimited, recordCodeFailure, clearUserCodeFailures, canAuthorizeNewUser, authorize, roomSummary, listRooms, broadcastRoomList };
}

module.exports = { createLobbyService };
