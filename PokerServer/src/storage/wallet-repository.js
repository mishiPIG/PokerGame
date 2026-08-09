'use strict';

const crypto = require('crypto');

function createWalletRepository(db) {
    const findOperation = db.prepare('SELECT * FROM wallet_transactions WHERE operation_key = ?');
    // 按前缀数已有条数：用来生成【跨重启/跨重新落座都唯一】的幂等键。
    // （内存里的自增序号在座位对象被重建时会归零，导致同一个键被复用 → IDEMPOTENCY_CONFLICT）
    const countByPrefix = db.prepare("SELECT COUNT(*) AS c FROM wallet_transactions WHERE operation_key LIKE ? || '%'");
    const getBalance = db.prepare('SELECT gold FROM users WHERE id = ? AND deleted_at_ms IS NULL');
    const updateBalance = db.prepare('UPDATE users SET gold = ?, updated_at_ms = ? WHERE id = ?');
    const insertTransaction = db.prepare(`
        INSERT INTO wallet_transactions (
            id, user_id, delta, balance_before, balance_after, transaction_type,
            match_id, hand_id, operation_key, metadata_json, created_at_ms
        ) VALUES (
            @id, @user_id, @delta, @balance_before, @balance_after, @transaction_type,
            @match_id, @hand_id, @operation_key, @metadata_json, @created_at_ms
        )
    `);

    const adjustTx = db.transaction(params => {
        const existing = findOperation.get(params.operationKey);
        if (existing) {
            if (existing.user_id !== params.userId || existing.delta !== params.delta) {
                throw new Error('IDEMPOTENCY_CONFLICT');
            }
            return { applied: false, balance: existing.balance_after, transactionId: existing.id };
        }
        const row = getBalance.get(params.userId);
        if (!row) throw new Error('USER_NOT_FOUND');
        const next = row.gold + params.delta;
        if (!Number.isSafeInteger(next) || next < 0) throw new Error('INSUFFICIENT_GOLD');
        const now = Date.now();
        const id = crypto.randomUUID();
        updateBalance.run(next, now, params.userId);
        insertTransaction.run({
            id,
            user_id: params.userId,
            delta: params.delta,
            balance_before: row.gold,
            balance_after: next,
            transaction_type: params.type,
            match_id: params.matchId || null,
            hand_id: params.handId || null,
            operation_key: params.operationKey,
            metadata_json: JSON.stringify(params.metadata || {}),
            created_at_ms: now
        });
        return { applied: true, balance: next, transactionId: id };
    });

    return {
        adjust(params) {
            if (!params || !params.userId || !params.operationKey || !params.type || !Number.isInteger(params.delta)) {
                throw new Error('INVALID_WALLET_TRANSACTION');
            }
            return adjustTx(params);
        },
        setBalance({ userId, gold, operationKey, metadata = {} }) {
            const existing = findOperation.get(operationKey);
            if (existing) {
                if (existing.user_id !== userId || existing.balance_after !== gold) throw new Error('IDEMPOTENCY_CONFLICT');
                return { applied: false, balance: existing.balance_after, transactionId: existing.id };
            }
            const row = getBalance.get(userId);
            if (!row) throw new Error('USER_NOT_FOUND');
            if (!Number.isInteger(gold) || gold < 0) throw new Error('INVALID_GOLD');
            return adjustTx({
                userId,
                delta: gold - row.gold,
                type: 'admin_adjust',
                operationKey,
                metadata: { ...metadata, requestedBalance: gold }
            });
        },
        // 该前缀下已有多少条 —— 用于生成跨重启/跨重新落座都唯一的幂等序号
        countOperations(prefix) {
            return countByPrefix.get(String(prefix)).c;
        },
        getTransactions(userId, limit = 100) {
            return db.prepare(`
                SELECT * FROM wallet_transactions
                WHERE user_id = ?
                ORDER BY created_at_ms DESC
                LIMIT ?
            `).all(userId, Math.max(1, Math.min(limit, 1000)));
        }
    };
}

module.exports = { createWalletRepository };
