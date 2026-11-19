'use strict';
// 现金桌「桌规投票」的 socket 事件：改盲注 / 7-2 奖励 / Bomb pot 设置 / 下一手 Bomb。规则在 rooms/rule-vote.js。
// 房主没有任何「直接改」的入口 —— 这几样都必须经过这里（否则投票形同虚设）。
const { nameOf } = require('../../account/display-name');
const { VOTE_MS, propose, respond, expire, publicVote } = require('../../rooms/rule-vote');

// 每张桌当前投票的作废计时器（不放在 game 上：快照会序列化 game）
const timers = new Map();
// 拒绝原因 → 文案 key。写成字面量（不拼字符串），字典完整性检查才认得出来
const REASON_MSG = {
    notOwner: { k: 'rule.notOwner' }, notCash: { k: 'rule.notCash' }, busy: { k: 'rule.busy' },
    bad: { k: 'rule.bad' }, badBlinds: { k: 'rule.badBlinds' }, same: { k: 'rule.same' }, gone: { k: 'rule.gone' },
    noSevenDeuce: { k: 'rule.noSevenDeuce' },
};

// 发起时的桌面提示：谁、提议了什么
function proposalNotice(name, kind, v) {
    if (kind === 'blinds') return { k: 'notice.vote.blinds', p: { name, sb: v.sb, bb: v.bb, ante: v.ante || 0 } };
    if (kind === 'sevenDeuce') return v.bb ? { k: 'notice.vote.sevenDeuce', p: { name, bb: v.bb } } : { k: 'notice.vote.sevenDeuceOff', p: { name } };
    if (kind === 'bomb') return v.every ? { k: 'notice.vote.bomb', p: { name, every: v.every, bb: v.bb } } : { k: 'notice.vote.bombAutoOff', p: { name, bb: v.bb } };
    return { k: 'notice.vote.bombNext', p: { name, bb: v.bb } };
}
// 通过后的桌面提示：从下一手起是什么样
function passedNotice(kind, v) {
    if (kind === 'blinds') return { k: 'notice.blindPassed', p: { sb: v.sb, bb: v.bb, ante: v.ante || 0 } };
    if (kind === 'sevenDeuce') return v.bb ? { k: 'notice.sevenDeuceOn', p: { bb: v.bb } } : { k: 'notice.sevenDeuceOff' };
    if (kind === 'bomb') return v.every ? { k: 'notice.bombSet', p: { every: v.every, bb: v.bb } } : { k: 'notice.bombAutoOff', p: { bb: v.bb } };
    return { k: 'notice.bombNext', p: { bb: v.bb } };
}

function registerRuleVoteEvents(context) {
    const { socket, user, io, runtime, tableService } = context;
    const { roomGames } = runtime;
    const { broadcastState } = tableService;

    function announcePassed(roomId, kind, payload) {
        io.in(roomId).emit('rule_vote_end', { result: 'passed', kind, payload });
        io.in(roomId).emit('table_notice', passedNotice(kind, payload));
        broadcastState(roomId);
    }

    socket.on('propose_rule', ({ kind, ...input } = {}) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        const r = propose(game, user.id, typeof kind === 'string' ? kind : '', input);
        if (!r.ok) { if (REASON_MSG[r.reason]) socket.emit('server_msg', REASON_MSG[r.reason]); return; }
        if (r.result === 'passed') { announcePassed(roomId, r.kind, r.payload); return; }
        const vote = r.vote;
        clearTimeout(timers.get(roomId));
        timers.set(roomId, setTimeout(() => {
            timers.delete(roomId);
            const g = roomGames[roomId];
            if (!expire(g, vote)) return;
            io.in(roomId).emit('rule_vote_end', { result: 'expired' });
            io.in(roomId).emit('table_notice', { k: 'notice.voteExpired' });
            broadcastState(roomId);
        }, VOTE_MS + 200));
        io.in(roomId).emit('rule_vote', publicVote(game));
        io.in(roomId).emit('table_notice', proposalNotice(nameOf(user), vote.kind, vote.payload));
        broadcastState(roomId);
    });

    socket.on('vote_rule', ({ agree } = {}) => {
        const roomId = socket.currentRoom;
        const game = roomId && roomGames[roomId];
        if (!game) return;
        const r = respond(game, user.id, agree === true);
        if (!r.ok) { if (r.reason === 'gone') socket.emit('server_msg', REASON_MSG.gone); return; }
        if (r.result === 'pending') { io.in(roomId).emit('rule_vote', publicVote(game)); return; }
        clearTimeout(timers.get(roomId)); timers.delete(roomId);
        if (r.result === 'passed') { announcePassed(roomId, r.kind, r.payload); return; }
        io.in(roomId).emit('rule_vote_end', { result: 'rejected', name: nameOf(user) });
        io.in(roomId).emit('table_notice', { k: 'notice.voteRejected', p: { name: nameOf(user) } });
        broadcastState(roomId);
    });
}

module.exports = { registerRuleVoteEvents, proposalNotice, passedNotice };
