'use strict';

// Pure functions for the Squid Game extension. No IO, no game state mutation.
// All functions are deterministic given their inputs.

// ---- Complete pool winner detection (§4.3) ----

/**
 * Determine if one player won 100% of all effective pots in a hand.
 * Returns the userId of the sole complete winner, or null if:
 *   - pot was split (multiple winners)
 *   - different winners for different pots/runouts
 *   - any runout had a tie
 *   - no one won anything
 *
 * @param {Object} handOutcome - standardized hand outcome from buildHandOutcome
 * @returns {string|null} userId of complete winner, or null
 */
function findCompletePotWinner(handOutcome) {
    if (!handOutcome || !handOutcome.parts || !handOutcome.parts.length) return null;
    if (handOutcome.totalPotAwarded <= 0) return null;

    // Collect all unique winners across all pot parts
    const allWinners = new Set();
    for (const part of handOutcome.parts) {
        if (!part.winners || part.winners.length === 0) return null;
        // A tied pot part (multiple winners) disqualifies complete win
        if (part.winners.length > 1) return null;
        allWinners.add(part.winners[0].userId);
    }

    // Must be exactly one unique winner across all parts
    if (allWinners.size !== 1) return null;

    const soleWinner = [...allWinners][0];

    // Verify they actually received 100% of total awarded
    const totalWon = handOutcome.parts.reduce((sum, part) => {
        const w = part.winners.find(w => w.userId === soleWinner);
        return sum + (w ? w.amount : 0);
    }, 0);

    if (totalWon !== handOutcome.totalPotAwarded) return null;

    return soleWinner;
}

// ---- Escrow calculation (§3.2, §5.4) ----

/**
 * Calculate the guarantee (escrow) amount each participant must lock at round start.
 * @param {Object} params
 * @param {number} params.participantCount - number of round participants
 * @param {number} params.penaltyBB - penalty in BB per token
 * @param {number} params.roundStartBB - BB value locked at round start
 * @returns {number} guarantee per player in chips
 */
function guaranteePerPlayer({ participantCount, penaltyBB, roundStartBB }) {
    return participantCount * penaltyBB * roundStartBB;
}

/**
 * Calculate the unit penalty in chips.
 * @param {number} penaltyBB
 * @param {number} roundStartBB
 * @returns {number}
 */
function unitChips(penaltyBB, roundStartBB) {
    return penaltyBB * roundStartBB;
}

// ---- Settlement calculation (§5.1, §5.4) ----

/**
 * Calculate round-end settlement: who gets refunded what, who pays what to whom.
 * This is deterministic and should be called once at round end.
 *
 * Rules:
 * - Token holders get their full escrow refunded.
 * - Zero-token participants' escrow is distributed to token holders
 *   proportional to their token counts.
 * - Total escrow pool must balance to zero after distribution.
 *
 * @param {Object} params
 * @param {Array<{userId: string, tokens: number, escrow: number}>} params.participants
 * @param {number} params.totalTokens - total tokens for this round (K)
 * @param {number} params.unitChips - penalty per token (N × BB)
 * @returns {{ refunds: Object<string, number>, transfers: Array<{fromUserId: string, toUserId: string, amount: number}>, holderIncome: Object<string, number>, zeroTokenLoss: Object<string, number> }}
 */
function calculateSquidSettlement({ participants, totalTokens, unitChips }) {
    if (!participants || !participants.length || totalTokens <= 0) {
        return { refunds: {}, transfers: [], holderIncome: {}, zeroTokenLoss: {} };
    }

    // Verify invariants
    const totalAwarded = participants.reduce((sum, p) => sum + (p.tokens || 0), 0);
    if (totalAwarded !== totalTokens) {
        throw new Error(
            `Squid settlement invariant violated: totalTokens=${totalTokens} but sum(participants.tokens)=${totalAwarded}`
        );
    }

    const holders = participants.filter(p => (p.tokens || 0) > 0);
    const zeroToken = participants.filter(p => (p.tokens || 0) === 0);

    if (holders.length === 0) {
        // Edge case: no one has tokens but all tokens were "awarded" — shouldn't happen
        // Refund everyone
        const refunds = {};
        participants.forEach(p => { refunds[p.userId] = p.escrow; });
        return { refunds, transfers: [], holderIncome: {}, zeroTokenLoss: {} };
    }

    // 1. All holders get their full escrow refunded
    const refunds = {};
    holders.forEach(h => { refunds[h.userId] = h.escrow; });

    // 2. Zero-token participants' escrow is distributed to holders by token proportion
    const transfers = [];
    const holderIncome = {};
    const zeroTokenLoss = {};

    zeroToken.forEach(d => {
        zeroTokenLoss[d.userId] = d.escrow; // they lose their full escrow
        holders.forEach(h => {
            // pay(d -> h) = tokens[h] × unitChips
            const amount = (h.tokens || 0) * unitChips;
            if (amount > 0) {
                transfers.push({ fromUserId: d.userId, toUserId: h.userId, amount });
                holderIncome[h.userId] = (holderIncome[h.userId] || 0) + amount;
            }
        });
    });

    // 3. Verify escrow pool balances to zero
    const totalEscrow = participants.reduce((sum, p) => sum + (p.escrow || 0), 0);
    const totalRefunded = Object.values(refunds).reduce((sum, v) => sum + v, 0);
    const totalTransferred = transfers.reduce((sum, t) => sum + t.amount, 0);

    if (totalEscrow !== totalRefunded + totalTransferred) {
        throw new Error(
            `Squid settlement: escrow pool imbalance. escrow=${totalEscrow}, refunded=${totalRefunded}, transferred=${totalTransferred}`
        );
    }

    return { refunds, transfers, holderIncome, zeroTokenLoss };
}

// ---- Validation helpers ----

/**
 * Validate that escrow state is consistent.
 * @param {Object} round - squid round object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEscrowState(round) {
    const errors = [];
    if (!round || !round.participants) {
        errors.push('No round or participants');
        return { valid: false, errors };
    }

    const count = round.participants.length;
    const totalEscrow = round.participants.reduce((s, p) => s + (p.escrow || 0), 0);
    const expected = count * (round.guaranteePerPlayer || 0);

    if (totalEscrow !== expected) {
        errors.push(`Escrow total mismatch: ${totalEscrow} vs expected ${expected}`);
    }
    if (totalEscrow !== (round.escrowTotal || 0)) {
        errors.push(`Escrow total vs stored: ${totalEscrow} vs stored ${round.escrowTotal}`);
    }

    // Token invariant
    const awardedTokens = round.participants.reduce((s, p) => s + (p.tokens || 0), 0);
    if (awardedTokens !== (round.awardedTokens || 0)) {
        errors.push(`Token count mismatch: sum=${awardedTokens} vs stored=${round.awardedTokens}`);
    }
    if ((round.totalTokens || 0) !== (round.awardedTokens || 0) + (round.remainingTokens || 0)) {
        errors.push(`Token distribution: ${round.totalTokens} ≠ ${round.awardedTokens} + ${round.remainingTokens}`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Determine eligible participants for a new round from the current game state.
 * Only players who can play (chips > 0, not sittingOut) are eligible.
 * Standing/reserved players are NOT eligible — they join the next round after sitting back.
 *
 * @param {Object} game - room game object
 * @returns {Array<{userId: string, username: string, seat: number, chips: number}>}
 */
function eligibleParticipants(game) {
    if (!game || !game.players) return [];
    return game.players
        .filter(p => p.chips > 0 && !p.sittingOut && !p.standing && !p.reserved)
        .map(p => ({
            userId: p.userId,
            username: p.username,
            seat: p.seat ?? 0,
            chips: p.chips
        }));
}

module.exports = {
    findCompletePotWinner,
    guaranteePerPlayer,
    unitChips,
    calculateSquidSettlement,
    validateEscrowState,
    eligibleParticipants
};
