const express = require('express');
const router = express.Router();
const db = require('../db/database');
const telegramAuth = require('../middleware/telegramAuth');
const { getOrCreateUser, invalidateUserCache, setLeaderboardAnonymous } = require('../services/userService');
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
 * POST /api/user/leaderboard-visibility
 * body: { anonymous: boolean }
 *
 * Управляет тем, показывается ли пользователь в топе игроков (Mini App
 * и бот) под своим именем/фото или как "Аноним". По умолчанию у всех
 * новых пользователей анонимность включена (см. schema.sql).
 */
router.post('/leaderboard-visibility', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    const anonymous = !!req.body?.anonymous;
    await setLeaderboardAnonymous(user.id, anonymous);
    const updated = await getOrCreateUser(req.telegramUser);
    res.json({ user: updated });
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
