const express = require('express');
const router = express.Router();
const db = require('../db/database');
const telegramAuth = require('../middleware/telegramAuth');
const { getOrCreateUser } = require('../services/userService');
require('dotenv').config();

router.use(telegramAuth);

const DAILY_BONUS_AMOUNT = Number(process.env.DAILY_BONUS_AMOUNT || 200);
const DAILY_BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/user/me
 * Профиль текущего пользователя (виртуальный баланс, уровень, статистика).
 */
router.get('/me', (req, res) => {
    const user = getOrCreateUser(req.telegramUser);
    res.json({ user, dailyBonus: dailyBonusStatus(user) });
});

function dailyBonusStatus(user) {
    if (!user.last_daily_bonus_at) return { available: true, nextAt: null };
    const last = new Date(user.last_daily_bonus_at).getTime();
    const nextAt = last + DAILY_BONUS_COOLDOWN_MS;
    return { available: Date.now() >= nextAt, nextAt };
}

/**
 * POST /api/user/daily-bonus
 * ЕДИНСТВЕННЫЙ способ пополнить виртуальный баланс (не считая наград в играх).
 * Фиксированная сумма, раз в 24 часа, начисляется только на сервере —
 * никаких сумм с клиента, никакой связи с реальными деньгами.
 */
router.post('/daily-bonus', (req, res) => {
    const claimTx = db.transaction(() => {
        const user = getOrCreateUser(req.telegramUser);
        const status = dailyBonusStatus(user);
        if (!status.available) {
            throw { status: 429, message: 'Ежедневный бонус уже получен. Возвращайтесь позже.', nextAt: status.nextAt };
        }

        const newBalance = user.coins_balance + DAILY_BONUS_AMOUNT;
        db.prepare(`
            UPDATE users SET coins_balance = ?, last_daily_bonus_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newBalance, user.id);

        db.prepare(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after)
            VALUES (?, 'daily_bonus', ?, ?)
        `).run(user.id, DAILY_BONUS_AMOUNT, newBalance);

        return newBalance;
    });

    try {
        const newBalance = claimTx();
        res.json({ success: true, newBalance, amount: DAILY_BONUS_AMOUNT });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Ошибка начисления бонуса', nextAt: err.nextAt });
    }
});

const MAX_TOPUP_AMOUNT = Number(process.env.MAX_TOPUP_AMOUNT || 1000000);

/**
 * POST /api/user/topup
 * Ручное пополнение виртуального баланса на произвольную сумму.
 * Это ДЕМО-баланс: не покупается и не выводится за реальные деньги,
 * поэтому свободное самопополнение — обычная механика для тестового/бонусного режима.
 */
router.post('/topup', (req, res) => {
    const amount = Math.floor(Number(req.body?.amount));

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Сумма должна быть положительным числом' });
    }
    if (amount > MAX_TOPUP_AMOUNT) {
        return res.status(400).json({ error: `Максимум за одно пополнение: ${MAX_TOPUP_AMOUNT} звёзд` });
    }

    const topupTx = db.transaction(() => {
        const user = getOrCreateUser(req.telegramUser);
        const newBalance = user.coins_balance + amount;

        db.prepare(`
            UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(newBalance, user.id);

        db.prepare(`
            INSERT INTO transactions (user_id, type, amount_coins, balance_after)
            VALUES (?, 'self_topup', ?, ?)
        `).run(user.id, amount, newBalance);

        return newBalance;
    });

    const newBalance = topupTx();
    res.json({ success: true, newBalance, amount });
});

/**
 * GET /api/user/transactions
 * История транзакций виртуального баланса.
 */
router.get('/transactions', (req, res) => {
    const user = getOrCreateUser(req.telegramUser);
    const transactions = db.prepare(`
        SELECT type, amount_coins, balance_after, created_at
        FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(user.id);
    res.json({ transactions });
});

module.exports = router;
