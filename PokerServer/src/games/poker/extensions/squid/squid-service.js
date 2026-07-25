'use strict';

const squidRules = require('./squid-rules');

function createSquidService({ io, roomGames, db, config, hooks }) {
    const {
        SQUID_PENALTY_BB_MIN, SQUID_PENALTY_BB_MAX, SQUID_PENALTY_BB_DEFAULT,
        SQUID_CLAIM_WINDOW_MS, PHASES, gameBB
    } = config;

    const { broadcastState, scheduleNextHand, saveHandHistory } = hooks;

    // ---- Helpers ----

    function clampInt(v, min, max, def) {
        const n = parseInt(v);
        return isNaN(n) ? def : Math.max(min, Math.min(max, n));
    }

    function ensureSquid(game) {
        resolveRoomId(game);
        if (!game.squid) {
            game.squid = {
                lifecycle: 'idle',        // idle | pending_start | pending_funding | active | stopping_after_round
                nextPenaltyBB: SQUID_PENALTY_BB_DEFAULT,
                fundingShortfalls: [],
                lastRoundNo: 0,
                targetRounds: 0,       // 0 = 一直开启；其余为本次计划轮数
                completedRounds: 0,
                round: null
            };
        }
        return game.squid;
    }

    function isActive(game) {
        return game && game.squid && game.squid.round && game.squid.round.status === 'active';
    }

    function roundId(roomId, roundNo) {
        return `${roomId}:${roundNo}`;
    }

    function resolveRoomId(game) {
        if (game.roomId) return game.roomId;
        const entry = Object.entries(roomGames).find(([, candidate]) => candidate === game);
        if (entry) game.roomId = entry[0];
        return game.roomId || '';
    }

    function finishPendingHandHistory(game) {
        const squid = game.squid;
        if (!squid || !squid.pendingHandHistory) return;
        const pending = squid.pendingHandHistory;
        squid.pendingHandHistory = null;
        if (saveHandHistory) saveHandHistory(game, pending.winShare);
    }

    // ---- Config management (§3) ----

    /**
     * Handle owner request to change squid config.
     * §3.4: active round params immutable; closing during active round = stop after round.
     */
    function requestConfigChange(game, ownerUserId, { enabled, penaltyBB, rounds }) {
        const squid = ensureSquid(game);

        if (rounds !== undefined) {
            const parsedRounds = parseInt(rounds);
            squid.targetRounds = [1, 2, 3, 5].includes(parsedRounds) ? parsedRounds : 0;
        }

        if (penaltyBB !== undefined) {
            const clamped = clampInt(penaltyBB, SQUID_PENALTY_BB_MIN, SQUID_PENALTY_BB_MAX, SQUID_PENALTY_BB_DEFAULT);
            // §3.4: active round penaltyBB/roundStartBB are immutable
            if (isActive(game)) {
                // Store for next round
                squid.nextPenaltyBB = clamped;
                io.in(game.roomId || '').emit('server_msg',
                    `🦑 罚金将在下一轮生效（当前轮仍为 ${squid.round.penaltyBB}BB）`);
            } else {
                squid.nextPenaltyBB = clamped;
            }
        }

        const wasEnabled = squid.lifecycle !== 'idle';

        if (enabled === true && !wasEnabled) {
            // §3.2: Enable — start from next hand
            if (isActive(game)) return; // already active

            const inHand = game.phase !== PHASES.WAITING && game.phase !== PHASES.SHOWDOWN;
            squid.completedRounds = 0;
            squid.lifecycle = 'pending_start';
            const msg = inHand
                ? '🦑 房主已开启鱿鱼游戏：当前手结束后，下一手开始新一轮'
                : '🦑 房主已开启鱿鱼游戏：下一手开始新一轮';
            io.in(game.roomId || '').emit('server_msg', msg);

        } else if (enabled === false && wasEnabled) {
            // §3.4: Close — if active round, mark as stopping; otherwise immediate
            if (isActive(game)) {
                squid.lifecycle = 'stopping_after_round';
                io.in(game.roomId || '').emit('server_msg',
                    '🦑 房主已关闭鱿鱼游戏：当前轮完成后停止');
            } else {
                squid.lifecycle = 'idle';
                squid.round = null;
                squid.fundingShortfalls = [];
                io.in(game.roomId || '').emit('server_msg', '🦑 房主已关闭鱿鱼游戏');
            }
        }

        // Persist to game config for room recreation
        if (!game.config) game.config = {};
        if (!game.config.squid) game.config.squid = {};
        game.config.squid.enabled = (squid.lifecycle !== 'idle');
        game.config.squid.penaltyBB = squid.nextPenaltyBB;
        game.config.squid.rounds = squid.targetRounds;
    }

    // ---- Round lifecycle (§3.2, §3.5) ----

    /**
     * Called before startHand. If squid is enabled and no active round,
     * attempt to start a new round.
     */
    function startRoundIfNeeded(game) {
        if (!game || game.roomType !== 'cash') return;
        const squid = ensureSquid(game);

        // Only start from pending_start or idle-with-config
        if (squid.lifecycle !== 'pending_start' && squid.lifecycle !== 'pending_funding'
            && squid.lifecycle !== 'idle') return;
        if (isActive(game)) return;

        // Check config
        const cfg = game.config?.squid;
        if (!cfg || !cfg.enabled) return;

        const candidates = squidRules.eligibleParticipants(game);
        if (candidates.length < 2) return; // §6.4: need at least 2

        const BB = gameBB(game);
        const penaltyBB = squid.nextPenaltyBB;
        const gpp = squidRules.guaranteePerPlayer({
            participantCount: candidates.length,
            penaltyBB,
            roundStartBB: BB
        });

        // §3.5: Check funding — every candidate must have enough chips for escrow + at least 1 chip leftover
        const shortfalls = [];
        for (const c of candidates) {
            const player = game.players.find(p => p.userId === c.userId);
            if (!player) { shortfalls.push({ userId: c.userId, username: c.username, need: gpp, have: 0 }); continue; }
            // Apply pending rebuy first (§3.5)
            const available = player.chips + (player.pendingRebuy || 0);
            if (available < gpp + 1) {
                shortfalls.push({ userId: c.userId, username: c.username, need: gpp + 1, have: available, short: gpp + 1 - available });
            }
        }

        if (shortfalls.length > 0) {
            squid.lifecycle = 'pending_funding';
            squid.fundingShortfalls = shortfalls;
            const list = shortfalls.map(s => `${s.username} 差 ${s.short} 筹码`).join('；');
            io.in(game.roomId || '').emit('server_msg',
                `🦑 鱿鱼游戏保证金不足，暂停开赛：${list}。请补码或站起退出`);
            io.in(game.roomId || '').emit('squid_funding_required', { shortfalls, guaranteePerPlayer: gpp });
            broadcastState(game.roomId || '');
            return;
        }

        // Lock escrow and create round
        lockEscrowAndStartRound(game, candidates, BB, penaltyBB, gpp);
    }

    function lockEscrowAndStartRound(game, candidates, BB, penaltyBB, gpp) {
        const squid = ensureSquid(game);
        const roomId = resolveRoomId(game);
        const roundNo = (squid.lastRoundNo || 0) + 1;
        squid.lastRoundNo = roundNo;
        const rId = roundId(roomId, roundNo);

        const unit = squidRules.unitChips(penaltyBB, BB);
        const escrowTotal = candidates.length * gpp;

        // Deduct escrow from each participant's chips
        const participants = [];
        for (const c of candidates) {
            const player = game.players.find(p => p.userId === c.userId);
            if (!player) continue;
            // Apply pending rebuy before locking
            if (player.pendingRebuy) {
                player.chips += player.pendingRebuy;
                player.pendingRebuy = 0;
            }
            player.chips -= gpp;
            participants.push({
                userId: c.userId,
                username: c.username,
                startSeat: c.seat,
                tokens: 0,
                escrow: gpp,
                presence: 'seated'
            });
        }

        // §3.5: Assert invariants
        const actualEscrowTotal = participants.reduce((s, p) => s + p.escrow, 0);
        if (actualEscrowTotal !== escrowTotal) {
            throw new Error(`Escrow invariant failed: ${actualEscrowTotal} ≠ ${escrowTotal}`);
        }
        for (const p of participants) {
            if (p.escrow !== gpp) {
                throw new Error(`Per-player escrow invariant failed: ${p.userId} ${p.escrow} ≠ ${gpp}`);
            }
        }
        // Every participant must have >= 0 chips remaining
        for (const p of participants) {
            const player = game.players.find(pl => pl.userId === p.userId);
            if (player && player.chips < 0) {
                throw new Error(`Player ${p.userId} has negative chips after escrow lock`);
            }
        }

        squid.round = {
            roundId: rId,
            roundNo,
            status: 'active',
            startedAt: Date.now(),
            startedHandSeq: game.handSeq || 0,

            roundStartBB: BB,
            penaltyBB,
            unitChips: unit,
            guaranteePerPlayer: gpp,
            escrowTotal,

            totalTokens: candidates.length,
            awardedTokens: 0,
            remainingTokens: candidates.length,

            participants,
            pendingClaim: null,
            settlement: null
        };

        squid.lifecycle = 'active';
        squid.fundingShortfalls = [];

        const escrowBB = gpp / BB;
        io.in(roomId).emit('server_msg',
            `🦑 本轮开始：${candidates.length} 人、${candidates.length} 枚令牌、每枚 ${penaltyBB}BB；每人已锁定 ${escrowBB}BB 保证金`);
        io.in(roomId).emit('squid_round_started', {
            roundId: rId, roundNo, totalTokens: candidates.length,
            penaltyBB, unitChips: unit, guaranteePerPlayer: gpp
        });

        // Re-check that each participant still has playable chips
        const noChips = participants.filter(p => {
            const player = game.players.find(pl => pl.userId === p.userId);
            return player && player.chips <= 0;
        });
        if (noChips.length > 0) {
            for (const nc of noChips) {
                const player = game.players.find(pl => pl.userId === nc.userId);
                if (player) player.sittingOut = true;
            }
        }
    }

    // ---- Per-hand hooks (§4) ----

    /**
     * Called when a new hand starts. Currently just clears any stale claim state.
     */
    function onHandStarted(game) {
        if (!isActive(game)) return;
        // Clear any stale claim timer from previous hand
        clearClaimTimer(game);
        game.squid.round.pendingClaim = null;
    }

    /**
     * Called after hand settlement (chips distributed, hand history not yet saved).
     * Determines if there's a complete pool winner and creates a claim window.
     *
     * @param {Object} game
     * @param {Object} handOutcome - standardized outcome from buildHandOutcome
     * @returns {boolean} true if a claim window was created (scheduleNextHand deferred)
     */
    function onHandSettled(game, handOutcome, winShare) {
        if (!isActive(game)) return false;
        if (!handOutcome) return false;
        // 正常摊牌 / all-in run-it 已经公开底牌，不再询问是否秀牌领取。
        // 领取窗口只用于打到对手弃牌、赢家仍可选择隐藏底牌的场景。
        if (!handOutcome.endedByFold) return false;
        if (game.squid.round.remainingTokens <= 0) return false; // round already done

        const completeWinnerId = squidRules.findCompletePotWinner(handOutcome);
        if (!completeWinnerId) return false;

        // Check winner is a round participant
        const participant = game.squid.round.participants.find(p => p.userId === completeWinnerId);
        if (!participant) return false;

        // Create claim window (§4.4, §4.5)
        const deadlineAt = Date.now() + SQUID_CLAIM_WINDOW_MS;
        game.squid.round.pendingClaim = {
            userId: completeWinnerId,
            handSeq: handOutcome.handSeq,
            status: 'claimable',     // claimable | awarded | declined | expired
            deadlineAt,
            holeCards: null          // filled when claim is made
        };
        game.squid.pendingHandHistory = { winShare: { ...(winShare || {}) } };

        // Start 10s timer
        clearClaimTimer(game);
        game.squid.claimTimer = setTimeout(() => expireClaim(game), SQUID_CLAIM_WINDOW_MS);

        // Notify the eligible winner privately
        const winner = game.players.find(p => p.userId === completeWinnerId);
        if (winner && winner.socketId) {
            io.to(winner.socketId).emit('server_msg',
                '🦑 你已完整赢池：是否秀出两张底牌并领取 1 枚鱿鱼令牌？');
        }

        // Broadcast claim state (without hole cards)
        broadcastState(game.roomId || '');

        return true; // claim window created — scheduleNextHand is deferred
    }

    // ---- Claim actions (§4.4) ----

    /**
     * Player clicks "秀牌并领取" — reveal both hole cards and award 1 token.
     */
    function claimToken(game, userId, handSeq) {
        if (!isActive(game)) return { ok: false, reason: 'no_active_round' };
        const round = game.squid.round;
        const claim = round.pendingClaim;

        if (!claim || claim.userId !== userId) {
            return { ok: false, reason: 'not_eligible' };
        }
        if (claim.handSeq !== handSeq) {
            return { ok: false, reason: 'wrong_hand' };
        }
        if (claim.status !== 'claimable') {
            return { ok: false, reason: claim.status === 'awarded' ? 'already_awarded' : 'expired' };
        }
        if (Date.now() > claim.deadlineAt) {
            claim.status = 'expired';
            clearClaimTimer(game);
            return { ok: false, reason: 'deadline_passed' };
        }

        // Get the player's hole cards
        const holeCards = game.holeCards?.[userId];
        if (!holeCards || holeCards.length !== 2) {
            return { ok: false, reason: 'no_hole_cards' };
        }

        // §4.4: Atomically: reveal cards, update claim, award token
        claim.status = 'awarded';
        claim.holeCards = holeCards.map(c => ({ suit: c.suit, rank: c.rank }));
        clearClaimTimer(game);

        // Award 1 token
        const participant = round.participants.find(p => p.userId === userId);
        if (participant) {
            participant.tokens = (participant.tokens || 0) + 1;
        }
        round.awardedTokens = (round.awardedTokens || 0) + 1;
        round.remainingTokens = round.totalTokens - round.awardedTokens;

        // Broadcast revealed cards to the table
        io.in(game.roomId || '').emit('squid_token_awarded', {
            userId,
            username: participant ? participant.username : userId,
            handSeq,
            cards: claim.holeCards,
            tokens: participant ? participant.tokens : 0,
            round: {
                totalTokens: round.totalTokens,
                awardedTokens: round.awardedTokens,
                remainingTokens: round.remainingTokens
            }
        });
        io.in(game.roomId || '').emit('server_msg',
            `🦑 ${participant ? participant.username : userId} 秀牌领取了 1 枚鱿鱼令牌！（${round.awardedTokens}/${round.totalTokens}）`);

        // Record squid data on hand for later audit
        if (game.hand) {
            game.hand.squid = game.hand.squid || {};
            game.hand.squid.roundId = round.roundId;
            game.hand.squid.eligibleWinnerId = userId;
            game.hand.squid.revealSource = 'voluntary';
            game.hand.squid.tokenAwardedTo = userId;
            game.hand.squid.remainingTokensAfter = round.remainingTokens;
        }

        // §5.6: If all tokens awarded, settle the round
        if (round.remainingTokens <= 0) {
            finishPendingHandHistory(game);
            settleRound(game);
        } else {
            finishPendingHandHistory(game);
            broadcastState(game.roomId || '');
            // §4.5: Claim decision made — start normal 5s inter-hand
            scheduleNextHand(game.roomId || '');
        }

        return { ok: true };
    }

    /**
     * Player clicks "不秀牌" — decline the token, keep hole cards private.
     */
    function declineToken(game, userId, handSeq) {
        if (!isActive(game)) return { ok: false, reason: 'no_active_round' };
        const round = game.squid.round;
        const claim = round.pendingClaim;

        if (!claim || claim.userId !== userId) return { ok: false, reason: 'not_eligible' };
        if (claim.handSeq !== handSeq) return { ok: false, reason: 'wrong_hand' };
        if (claim.status !== 'claimable') return { ok: false, reason: 'already_resolved' };

        claim.status = 'declined';
        clearClaimTimer(game);

        if (game.hand) {
            game.hand.squid = game.hand.squid || {};
            game.hand.squid.roundId = round.roundId;
            game.hand.squid.eligibleWinnerId = userId;
            game.hand.squid.revealSource = null;
            game.hand.squid.tokenAwardedTo = null;
            game.hand.squid.remainingTokensAfter = round.remainingTokens;
        }

        finishPendingHandHistory(game);
        broadcastState(game.roomId || '');
        // Start normal 5s inter-hand
        scheduleNextHand(game.roomId || '');

        return { ok: true };
    }

    function expireClaim(game) {
        if (!isActive(game)) return;
        const claim = game.squid.round.pendingClaim;
        if (!claim || claim.status !== 'claimable') return;

        claim.status = 'expired';
        game.squid.claimTimer = null;

        if (game.hand) {
            game.hand.squid = game.hand.squid || {};
            game.hand.squid.roundId = game.squid.round.roundId;
            game.hand.squid.eligibleWinnerId = claim.userId;
            game.hand.squid.revealSource = null;
            game.hand.squid.tokenAwardedTo = null;
            game.hand.squid.remainingTokensAfter = game.squid.round.remainingTokens;
        }

        finishPendingHandHistory(game);
        io.in(game.roomId || '').emit('squid_claim_expired', { userId: claim.userId, handSeq: claim.handSeq });
        broadcastState(game.roomId || '');
        // Start normal 5s inter-hand
        scheduleNextHand(game.roomId || '');
    }

    function clearClaimTimer(game) {
        if (game.squid && game.squid.claimTimer) {
            clearTimeout(game.squid.claimTimer);
            game.squid.claimTimer = null;
        }
    }

    // ---- Round settlement (§5) ----

    function settleRound(game) {
        if (!isActive(game)) return;
        const squid = game.squid;
        const round = squid.round;
        if (round.status !== 'active') return;
        if (round.settlement) return; // already settled (idempotent)

        round.status = 'settling';

        // §5.4: Calculate settlement
        const settlement = squidRules.calculateSquidSettlement({
            participants: round.participants,
            totalTokens: round.totalTokens,
            unitChips: round.unitChips
        });

        // Apply refunds — add back to player chips
        for (const [userId, amount] of Object.entries(settlement.refunds)) {
            const player = game.players.find(p => p.userId === userId);
            if (player) {
                player.chips += amount;
            } else {
                // Player may be vacated — look in vacatedPlayers
                const vp = (game.vacatedPlayers || []).find(v => v.userId === userId);
                if (vp) vp.chips += amount;
            }
        }

        // Apply transfers (income for holders) — already included in refunds,
        // but the zero-token players' escrow was kept by the house (added to holders)
        // Transfers are informational only here — the money already moved via escrow
        for (const t of settlement.transfers) {
            const toPlayer = game.players.find(p => p.userId === t.toUserId);
            if (toPlayer) {
                toPlayer.chips += t.amount;
            } else {
                const vp = (game.vacatedPlayers || []).find(v => v.userId === t.toUserId);
                if (vp) vp.chips += t.amount;
            }
        }

        // §5.5: Verify escrow pool is fully distributed
        const finalEscrowInPlay = round.participants.reduce((sum, p) => {
            const player = game.players.find(pl => pl.userId === p.userId);
            const vp = (game.vacatedPlayers || []).find(v => v.userId === p.userId);
            return sum + (player ? player.chips : 0) + (vp ? vp.chips : 0);
        }, 0);

        round.settlement = {
            settledAt: Date.now(),
            refunds: settlement.refunds,
            transfers: settlement.transfers,
            holderIncome: settlement.holderIncome,
            zeroTokenLoss: settlement.zeroTokenLoss
        };
        round.status = 'settled';

        // Build display summary
        const holderNames = round.participants
            .filter(p => (p.tokens || 0) > 0)
            .map(p => `${p.username}(${p.tokens}枚 +${settlement.holderIncome[p.userId] || 0})`)
            .join('、');
        const zeroNames = round.participants
            .filter(p => (p.tokens || 0) === 0)
            .map(p => `${p.username}(-${settlement.zeroTokenLoss[p.userId] || 0})`)
            .join('、');

        io.in(game.roomId || '').emit('squid_round_settled', {
            roundId: round.roundId,
            roundNo: round.roundNo,
            participants: round.participants.map(p => ({
                userId: p.userId,
                username: p.username,
                tokens: p.tokens || 0,
                escrowReturned: settlement.refunds[p.userId] || 0,
                income: settlement.holderIncome[p.userId] || 0,
                loss: settlement.zeroTokenLoss[p.userId] || 0,
                // 展示口径：保证金退回只是解锁，不计入盈亏。
                net: (settlement.holderIncome[p.userId] || 0)
                    - (settlement.zeroTokenLoss[p.userId] || 0)
            })),
            transfers: settlement.transfers
        });
        io.in(game.roomId || '').emit('server_msg',
            `🦑 本轮结算完成！令牌：${holderNames || '无'} | 罚金：${zeroNames || '无'}`);

        // Write audit record (§7.10)
        writeAuditRecord(game, round, settlement);
        squid.completedRounds = (squid.completedRounds || 0) + 1;
        const targetReached = squid.targetRounds > 0 && squid.completedRounds >= squid.targetRounds;

        // §3.3: If still enabled (not stopping), start next round on next hand
        if (squid.lifecycle === 'stopping_after_round' || targetReached) {
            squid.lifecycle = 'idle';
            if (game.config?.squid) game.config.squid.enabled = false;
            squid.round = null;
            io.in(game.roomId || '').emit('server_msg', targetReached
                ? `🦑 已完成设定的 ${squid.targetRounds} 轮，鱿鱼游戏自动关闭`
                : '🦑 鱿鱼游戏已关闭');
        } else if (game.config?.squid?.enabled) {
            // Continue to next round
            squid.lifecycle = 'pending_start';
            squid.round = null;
        } else {
            squid.lifecycle = 'idle';
            squid.round = null;
        }

        // §6.11: If table has pendingEnd, execute now
        if (game.pendingEndAfterSquid) {
            game.pendingEndAfterSquid = false;
            const { endCashTable } = hooks;
            if (endCashTable) {
                endCashTable(game.roomId || '', '训练时长已到（鱿鱼轮完成后）');
                return;
            }
        }

        broadcastState(game.roomId || '');
        scheduleNextHand(game.roomId || '');
    }

    /**
     * Cancel an active round (abnormal — server restart, admin action, etc.).
     * §6.11: Full escrow refund to each participant. No partial penalty.
     */
    function cancelRound(game, reason) {
        if (!isActive(game)) return false;
        const squid = game.squid;
        const round = squid.round;

        clearClaimTimer(game);

        // Refund escrow to each participant
        for (const p of round.participants) {
            const player = game.players.find(pl => pl.userId === p.userId);
            if (player) {
                player.chips += p.escrow;
            } else {
                const vp = (game.vacatedPlayers || []).find(v => v.userId === p.userId);
                if (vp) vp.chips += p.escrow;
            }
        }

        round.status = 'cancelled';
        round.settlement = {
            cancelledAt: Date.now(),
            reason: reason || 'unknown'
        };

        io.in(game.roomId || '').emit('squid_round_cancelled', {
            roundId: round.roundId, reason
        });
        io.in(game.roomId || '').emit('server_msg',
            `🦑 本轮鱿鱼游戏已取消：${reason || '未知原因'}，保证金已全额退还`);

        writeAuditRecord(game, round, null);

        squid.lifecycle = game.config?.squid?.enabled ? 'pending_start' : 'idle';
        squid.round = null;

        broadcastState(game.roomId || '');

        // If table has pendingEnd, execute now
        if (game.pendingEndAfterSquid) {
            game.pendingEndAfterSquid = false;
            const { endCashTable } = hooks;
            if (endCashTable) {
                endCashTable(game.roomId || '', '训练时长已到（鱿鱼轮取消后）');
                return true;
            }
        }

        scheduleNextHand(game.roomId || '');
        return true;
    }

    // ---- Audit (§7.10) ----

    function writeAuditRecord(game, round, settlement) {
        try {
            const record = {
                roundId: round.roundId,
                roomId: game.roomId,
                roundNo: round.roundNo,
                startedAt: round.startedAt,
                endedAt: Date.now(),
                status: settlement ? 'settled' : 'cancelled',
                reason: settlement ? 'completed' : (round.settlement?.reason || 'unknown'),
                roundStartBB: round.roundStartBB,
                penaltyBB: round.penaltyBB,
                guaranteePerPlayer: round.guaranteePerPlayer,
                escrowTotal: round.escrowTotal,
                totalTokens: round.totalTokens,
                participants: round.participants.map(p => ({
                    userId: p.userId,
                    username: p.username,
                    startSeat: p.startSeat,
                    tokens: p.tokens || 0,
                    escrowLocked: p.escrow,
                    escrowRefunded: settlement ? (settlement.refunds[p.userId] || 0) : p.escrow,
                    playableBefore: 0,  // not tracked per-round at this level
                    playableAfter: 0
                })),
                transfers: settlement ? settlement.transfers : [],
                handSeqs: []
            };
            db.appendSquidRound(record);
        } catch (e) {
            console.error('squid audit write failed:', e.message);
        }
    }

    // ---- Membership gates (§6.1, §6.2) ----

    function isRoundParticipant(game, userId) {
        if (!isActive(game)) return false;
        return game.squid.round.participants.some(p => p.userId === userId);
    }

    function canSitDown(game, userId) {
        if (!isActive(game)) return true; // no active round, anyone can sit
        // Active round: only existing participants can be seated
        return isRoundParticipant(game, userId);
    }

    function canSitBack(game, userId) {
        // Original round members can always return
        return isRoundParticipant(game, userId);
    }

    /**
     * Update participant presence when a player stands up or leaves.
     * §6.3: Round member leaving doesn't exit the financial relationship.
     */
    function updateParticipantPresence(game, userId, presence) {
        if (!isActive(game)) return;
        const p = game.squid.round.participants.find(pp => pp.userId === userId);
        if (p) {
            p.presence = presence; // seated | reserved | standing | offline | sitting_out
        }
    }

    // ---- Public state for broadcast (§7.6) ----

    function publicState(game) {
        if (!game || !game.squid) return null;
        const squid = game.squid;
        if (squid.lifecycle === 'idle' && !game.config?.squid?.enabled) return null;

        const state = {
            enabled: squid.lifecycle !== 'idle' || !!(game.config?.squid?.enabled),
            lifecycle: squid.lifecycle,
            pendingPenaltyBB: squid.nextPenaltyBB,
            targetRounds: squid.targetRounds || 0,
            completedRounds: squid.completedRounds || 0,
            stopAfterRound: squid.lifecycle === 'stopping_after_round'
        };

        if (squid.round) {
            const r = squid.round;
            state.round = {
                roundId: r.roundId,
                roundNo: r.roundNo,
                penaltyBB: r.penaltyBB,
                unitChips: r.unitChips,
                guaranteePerPlayer: r.guaranteePerPlayer,
                escrowTotal: r.escrowTotal,
                totalTokens: r.totalTokens,
                awardedTokens: r.awardedTokens,
                remainingTokens: r.remainingTokens,
                participants: r.participants.map(p => ({
                    userId: p.userId,
                    tokens: p.tokens || 0,
                    escrow: p.escrow,
                    presence: p.presence
                }))
            };
        }

        // Include claim info (without hole cards)
        if (squid.round && squid.round.pendingClaim) {
            const c = squid.round.pendingClaim;
            if (c.status === 'claimable') {
                state.claim = {
                    userId: c.userId,
                    handSeq: c.handSeq,
                    deadlineAt: c.deadlineAt
                };
            }
        }

        return state;
    }

    /**
     * Get escrow amount for a player (for ranking/asset calculations).
     */
    function playerEscrow(game, userId) {
        if (!isActive(game)) return 0;
        const p = game.squid.round.participants.find(pp => pp.userId === userId);
        return p ? p.escrow : 0;
    }

    /**
     * Called before endCashTable to check if we need to defer.
     * Returns true if table end must wait for squid round completion.
     */
    function deferTableEnd(game) {
        if (!isActive(game)) return false;
        game.pendingEndAfterSquid = true;
        io.in(game.roomId || '').emit('server_msg',
            '🦑 比赛将在本轮鱿鱼游戏完成后结束');
        return true;
    }

    return {
        // Lifecycle
        startRoundIfNeeded,
        onHandStarted,
        onHandSettled,
        settleRound,
        cancelRound,

        // Config
        requestConfigChange,

        // Claims
        claimToken,
        declineToken,

        // Membership
        isRoundParticipant,
        canSitDown,
        canSitBack,
        updateParticipantPresence,

        // State
        publicState,
        playerEscrow,
        isActiveRound: isActive,
        deferTableEnd,

        // Helpers
        clearClaimTimer
    };
}

module.exports = { createSquidService };
