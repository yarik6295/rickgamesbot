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
