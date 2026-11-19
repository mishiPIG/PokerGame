'use strict';
// 现金桌「桌规投票」（2026-11-18）：房主提议 → 在座每个人都同意 → 下一手起生效。
// 有人拒绝、或 30 秒没凑齐，就作废。SNG 不适用。
//
// 投票的东西（会直接改变每个人筹码的价值或输赢规则，所以不让房主一个人说了算 —— 用户 2026-11-18 定）：
//   · blinds     改盲注（小盲 / 大盲 / 前注）
//   · sevenDeuce 7-2 奖励：关 / 1 / 2 / 5BB
//   · bomb       Bomb pot 的自动频率（关 / 每 5 / 10 / 20 手）和每人放多少（2 / 5 / 10BB）
//   · bombNext   「下一手来一个 Bomb」（一次性）
// 建房时选的初始设置不投票：进桌的人是看到了才坐下的。
//
// 纯逻辑，不碰 socket（事件在 socket/events/rule-vote-events.js），便于单测。
//
// 🔴 两条不能破的规矩：
//   ① 绝不在一手牌中间生效 —— 盲注通过后只记 pendingBlinds，由 startHand 在下一手开头换上；
//      7-2 的奖励额、Bomb 的判定和金额都是开手那一刻读的，所以直接改 config 也只影响下一手。
//   ② 必须【在座每个人】都同意，不是多数。
//
// 计时器不放在 game 上（快照会序列化 game，Timeout 对象带循环引用），投票本身靠 deadline 判过期：
// 服务器重启后旧的投票照样会按时间作废，不会卡住、也不会挡住下一次提议。
const VOTE_MS = 30 * 1000;
const SEVEN_DEUCE_BB = [0, 1, 2, 5];
const BOMB_EVERY = [0, 5, 10, 20];
const BOMB_BB = [2, 5, 10];

function toInt(v) { const n = Number(v); return Number.isInteger(n) ? n : NaN; }

// 范围和建房时一致（lobby-events 的 create_cash_room）：大盲 20–1000、小盲 10–大盲、前注 0–80
function validateBlinds(input) {
    const bb = toInt(input && input.bb), sb = toInt(input && input.sb);
    const ante = input && input.ante != null && input.ante !== '' ? toInt(input.ante) : 0;
    if (!(bb >= 20 && bb <= 1000)) return null;
    if (!(sb >= 10 && sb <= bb)) return null;
    if (!(ante >= 0 && ante <= 80)) return null;
    return { sb, bb, ante };
}

const bombNow = (game) => ({
    every: BOMB_EVERY.includes(Number(game.config.bombEvery)) ? Number(game.config.bombEvery) : 0,
    bb: BOMB_BB.includes(Number(game.config.bombBB)) ? Number(game.config.bombBB) : 2,
});

// 每种提议：怎么校验、怎么判断「和现在一样」、通过后怎么生效
const KINDS = {
    blinds: {
        validate: (input) => validateBlinds(input),
        same: (game, v) => { const c = game.pendingBlinds || game.config; return v.sb === c.sb && v.bb === c.bb && v.ante === (c.ante || 0); },
        apply: (game, v) => { game.pendingBlinds = { sb: v.sb, bb: v.bb, ante: v.ante }; },
    },
    sevenDeuce: {
        validate: (input) => { const bb = toInt(input && input.bb); return SEVEN_DEUCE_BB.includes(bb) ? { bb } : null; },
        same: (game, v) => (Number(game.config.sevenDeuceBB) || 0) === v.bb,
        apply: (game, v) => { game.config.sevenDeuceBB = v.bb; },
    },
    bomb: {
        // 频率和金额可以只改一个：没给的那个沿用现在的
        validate: (input, game) => {
            const cur = bombNow(game);
            const every = input && input.every !== undefined ? toInt(input.every) : cur.every;
            const bb = input && input.bb !== undefined ? toInt(input.bb) : cur.bb;
            return BOMB_EVERY.includes(every) && BOMB_BB.includes(bb) ? { every, bb } : null;
        },
        same: (game, v) => { const c = bombNow(game); return c.every === v.every && c.bb === v.bb; },
        apply: (game, v) => { game.config.bombEvery = v.every; game.config.bombBB = v.bb; },
    },
    bombNext: {
        validate: (input, game) => ({ bb: bombNow(game).bb }),
        same: (game) => !!game.nextBomb,
        apply: (game) => { game.nextBomb = true; },
    },
};

// 谁有投票权：现在坐在桌上的人（正要离座的不算 —— 他下一手就不在了）
function voterIds(game) {
    return (game.players || []).filter(p => !p.standing && !p.vacateAfter).map(p => p.userId);
}

function activeVote(game, now = Date.now()) {
    const v = game && game.ruleVote;
    return v && v.deadline > now ? v : null;
}

// 还在座的投票人是不是全都同意了（中途离座的人不再卡住投票）
function allAgreed(game, vote) {
    const seated = new Set(voterIds(game));
    return vote.voters.filter(id => seated.has(id)).every(id => vote.agreed.includes(id));
}

function pass(game, vote) {
    KINDS[vote.kind].apply(game, vote.payload);
    game.ruleVote = null;
    return { ok: true, result: 'passed', kind: vote.kind, payload: vote.payload };
}

function propose(game, ownerId, kind, input, now = Date.now()) {
    if (!game) return { ok: false, reason: 'gone' };
    // Object.hasOwn：'constructor' / 'toString' 这类名字是对象自带的，KINDS[kind] 会取到函数（同 variants/index.js 那个坑）
    const K = typeof kind === 'string' && Object.hasOwn(KINDS, kind) ? KINDS[kind] : null;
    if (!K) return { ok: false, reason: 'bad' };
    if (game.roomType !== 'cash') return { ok: false, reason: 'notCash' };
    if (game.ownerUserId !== ownerId) return { ok: false, reason: 'notOwner' };
    if (activeVote(game, now)) return { ok: false, reason: 'busy' };
    if (kind === 'sevenDeuce' && (game.config.variant || 'nlhe') !== 'nlhe') return { ok: false, reason: 'noSevenDeuce' };   // 短牌没有 2、奥马哈是 4 张
    const payload = K.validate(input || {}, game);
    if (!payload) return { ok: false, reason: kind === 'blinds' ? 'badBlinds' : 'bad' };
    if (K.same(game, payload)) return { ok: false, reason: 'same' };
    const voters = voterIds(game);
    const vote = { kind, payload, proposerId: ownerId, deadline: now + VOTE_MS, voters, agreed: voters.includes(ownerId) ? [ownerId] : [] };
    game.ruleVote = vote;
    // 桌上只有房主自己（或一个人都没坐）：没有别人要问
    if (allAgreed(game, vote)) return pass(game, vote);
    return { ok: true, result: 'pending', vote };
}

function respond(game, userId, agree, now = Date.now()) {
    const vote = activeVote(game, now);
    if (!vote) { if (game && game.ruleVote) game.ruleVote = null; return { ok: false, reason: 'gone' }; }
    if (!vote.voters.includes(userId)) return { ok: false, reason: 'notVoter' };
    if (vote.agreed.includes(userId)) return { ok: true, result: 'pending', vote };
    if (agree !== true) { game.ruleVote = null; return { ok: true, result: 'rejected', vote }; }
    vote.agreed.push(userId);
    if (allAgreed(game, vote)) return pass(game, vote);
    return { ok: true, result: 'pending', vote };
}

// 到点还没凑齐：作废。返回 true = 这次确实把它作废了（调用方据此发通知）
function expire(game, vote) {
    if (!game || game.ruleVote !== vote) return false;
    game.ruleVote = null;
    return true;
}

// 开新一手时调用：有通过的新盲注就换上。返回换上的盲注（没有则 null）
function applyPendingBlinds(game) {
    const p = game && game.roomType === 'cash' && game.pendingBlinds;
    if (!p) return null;
    game.config.sb = p.sb; game.config.bb = p.bb; game.config.ante = p.ante;
    game.pendingBlinds = null;
    return p;
}

// 发给客户端的投票状态（全是公开信息）
function publicVote(game, now = Date.now()) {
    const v = activeVote(game, now);
    return v ? { kind: v.kind, payload: v.payload, deadline: v.deadline, voters: v.voters, agreed: v.agreed } : null;
}

module.exports = { VOTE_MS, SEVEN_DEUCE_BB, BOMB_EVERY, BOMB_BB, KINDS, validateBlinds, voterIds, propose, respond, expire, applyPendingBlinds, publicVote };
