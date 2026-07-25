'use strict';
const { bind } = require('./room-context');

/**
 * Register squid game socket events (§7.7).
 * - set_squid_config: owner-only config changes
 * - claim_squid_token: eligible winner claims a token by revealing both hole cards
 * - decline_squid_token: eligible winner declines to claim
 */
function registerSquidEvents(context) {
    const { socket, user, io, roomGames } = bind(context);

    // We need squid service methods from tableService. These are injected into context
    // by register-socket-handlers.js which merges all service methods.
    const {
        requestConfigChange,
        claimToken,
        declineToken,
        broadcastState
    } = bind(context);

    if (!requestConfigChange || !claimToken || !declineToken) {
        console.error('[squid] Socket events were not registered: Squid service methods are unavailable');
        return;
    }

    // Owner sets squid config (§3.1, §3.4)
    socket.on('set_squid_config', ({ enabled, penaltyBB, rounds }) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        if (game.roomType !== 'cash') {
            socket.emit('server_msg', '⚠️ 鱿鱼游戏仅支持现金桌');
            return;
        }
        if (game.ownerUserId !== user.id) {
            socket.emit('server_msg', '⚠️ 只有房主可修改鱿鱼游戏设置');
            return;
        }
        requestConfigChange(game, user.id, {
            enabled: enabled === true ? true : (enabled === false ? false : undefined),
            penaltyBB: penaltyBB !== undefined ? parseInt(penaltyBB) : undefined,
            rounds: rounds !== undefined ? parseInt(rounds) : undefined
        });
        broadcastState(roomId);
    });

    // Eligible winner clicks "秀牌并领取" (§4.4)
    socket.on('claim_squid_token', ({ roomId, handSeq }) => {
        roomId = String(roomId || socket.currentRoom || '');
        const game = roomGames[roomId];
        if (!game) return;

        const result = claimToken(game, user.id, parseInt(handSeq) || 0);
        if (!result.ok) {
            const msgs = {
                'no_active_round': '⚠️ 当前无活跃鱿鱼轮',
                'not_eligible': '⚠️ 你不是本轮完整赢池者',
                'wrong_hand': '⚠️ 手号不匹配',
                'already_awarded': '⚠️ 已领取过',
                'expired': '⚠️ 领取窗口已过期',
                'deadline_passed': '⚠️ 已超过决定时间',
                'no_hole_cards': '⚠️ 底牌数据不存在'
            };
            socket.emit('server_msg', msgs[result.reason] || `⚠️ ${result.reason}`);
        }
    });

    // Eligible winner clicks "不秀牌" (§4.4)
    socket.on('decline_squid_token', ({ roomId, handSeq }) => {
        roomId = String(roomId || socket.currentRoom || '');
        const game = roomGames[roomId];
        if (!game) return;

        const result = declineToken(game, user.id, parseInt(handSeq) || 0);
        if (!result.ok) {
            socket.emit('server_msg', '⚠️ 无法操作（已过期或已处理）');
        }
    });
}

module.exports = { registerSquidEvents };
