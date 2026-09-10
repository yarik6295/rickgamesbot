const express = require('express');
const router = express.Router();
const db = require('../db/database');
const telegramAuth = require('../middleware/telegramAuth');
const { getOrCreateUser, invalidateUserCache, setLeaderboardAnonymous } = require('../services/userService');
const { getReferralStats } = require('../services/referralService');
const { getPiggyBank, withdrawPiggyBank } = require('../services/piggyBankService');
require('dotenv').config();

router.use(telegramAuth);

/**
 * GET /api/user/me
 */
router.get('/me', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    // Оборот — сумма ставок в завершённых игровых раундах. Храним его
    // расчётным, а не отдельной колонкой users: так старые аккаунты сразу
    // получают корректное значение без миграции и риска рассинхронизации.
    const turnover = await db.get(
        `SELECT COALESCE(SUM(bet_coins), 0) AS total_wagered FROM game_rounds WHERE user_id = ?`,
        [user.id]
    );
    res.json({ user: { ...user, total_wagered: Number(turnover?.total_wagered) || 0 } });
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
 * GET /api/user/referrals
 * Статистика и персональная deep-link ссылка для Mini App. Имя бота берётся
 * только из серверной конфигурации, а Telegram ID — из проверенного профиля.
 */
router.get('/referrals', async (req, res) => {
    const stats = await getReferralStats(req.telegramUser);
    const botUsername = String(process.env.BOT_USERNAME || '').replace(/^@/, '');
    const referralLink = botUsername
        ? `https://t.me/${botUsername}?start=ref_${stats.user.telegram_id}`
        : null;
    res.json({
        invitedCount: stats.invitedCount,
        commissionEarned: stats.commissionEarned,
        signupBonus: 10,
        topupPercent: 20,
        referralLink,
    });
});

router.get('/piggy-bank', async (req, res) => {
    res.json({ piggyBank: await getPiggyBank(req.telegramUser) });
});

router.post('/piggy-bank/withdraw', async (req, res) => {
    res.json({ success: true, ...(await withdrawPiggyBank(req.telegramUser)) });
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
