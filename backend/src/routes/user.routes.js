const express = require('express');
const router = express.Router();
const db = require('../db/database');
const telegramAuth = require('../middleware/telegramAuth');
const { getOrCreateUser, invalidateUserCache } = require('../services/userService');
require('dotenv').config();

router.use(telegramAuth);

/**
 * GET /api/user/me
 */
router.get('/me', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    res.json({ user });
});

const MAX_TOPUP_AMOUNT = Number(process.env.MAX_TOPUP_AMOUNT || 1000000);

/**
 * POST /api/user/topup
 */
router.post('/topup', async (req, res) => {
    const amount = Math.floor(Number(req.body?.amount));

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Сумма должна быть положительным числом' });
    }
    if (amount > MAX_TOPUP_AMOUNT) {
        return res.status(400).json({ error: `Максимум за одно пополнение: ${MAX_TOPUP_AMOUNT} звёзд` });
    }

    const newBalance = await db.transaction(async (tx) => {
        const user = await getOrCreateUser(req.telegramUser, tx);
        const newBalance = user.coins_balance + amount;

        await tx.run(`
            UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [newBalance, user.id]);

        await tx.run(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after)
            VALUES (?, 'self_topup', ?, ?)
        `, [user.id, amount, newBalance]);

        invalidateUserCache(user.id);
        return newBalance;
    });

    res.json({ success: true, newBalance, amount });
});

/**
 * GET /api/user/transactions
 */
router.get('/transactions', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    const transactions = await db.all(`
        SELECT type, amount_coins, balance_after, created_at
        FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `, [user.id]);
    res.json({ transactions });
});

module.exports = router;
