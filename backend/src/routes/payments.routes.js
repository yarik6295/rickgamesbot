const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const telegramAuth = require('../middleware/telegramAuth');
const db = require('../db/database');
const { getOrCreateUser, invalidateUserCache } = require('../services/userService');
const { callBotApi, BOT_TOKEN } = require('../services/telegramApi');
const bot = require('../bot/bot');
require('dotenv').config();

const MAX_TOPUP_AMOUNT = Number(process.env.MAX_TOPUP_AMOUNT || 1000000);
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

// Webhook НЕ защищён telegramAuth: Telegram не присылает Mini App initData.
// Его защищает X-Telegram-Bot-Api-Secret-Token.
router.post('/telegram/webhook', async (req, res) => {
    if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN не задан' });

    if (WEBHOOK_SECRET) {
        const received = req.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (received !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    const update = req.body || {};

    // Всё, что не связано с платежами (/start, меню, callback_query) —
    // отдельный модуль. Ошибки там не должны ронять обработку платежей.
    try {
        await bot.handleUpdate(update);
    } catch (err) {
        console.error('[bot webhook]', err);
    }

    try {
        if (update.pre_checkout_query) {
            const q = update.pre_checkout_query;
            const payment = await db.get(`
                SELECT payment_id, telegram_id, stars_amount, status
                FROM star_payments WHERE payload = ?
            `, [q.invoice_payload]);

            const valid = payment &&
                payment.status === 'pending' &&
                Number(payment.telegram_id) === Number(q.from?.id) &&
                Number(payment.stars_amount) === Number(q.total_amount) &&
                q.currency === 'XTR';

            await callBotApi('answerPreCheckoutQuery', {
                pre_checkout_query_id: q.id,
                ok: Boolean(valid),
                ...(valid ? {} : { error_message: 'Платёж недействителен. Попробуйте ещё раз.' }),
            });
        }

        const successfulPayment = update.message?.successful_payment;
        const payerId = update.message?.from?.id;

        if (successfulPayment && payerId && successfulPayment.currency === 'XTR') {
            await db.transaction(async (tx) => {
                const payment = await tx.get(`
                    SELECT id, payment_id, user_id, telegram_id, stars_amount, status
                    FROM star_payments WHERE payload = ?
                `, [successfulPayment.invoice_payload]);

                if (!payment || payment.status !== 'pending') return;

                if (
                    Number(payment.telegram_id) !== Number(payerId) ||
                    Number(payment.stars_amount) !== Number(successfulPayment.total_amount)
                ) {
                    throw new Error('successful_payment не совпадает с ожидаемым платежом');
                }

                const duplicate = await tx.get(`
                    SELECT id FROM star_payments WHERE telegram_payment_charge_id = ?
                `, [successfulPayment.telegram_payment_charge_id]);
                if (duplicate) return;

                const user = await tx.get(`SELECT id, coins_balance FROM users WHERE id = ?`, [payment.user_id]);
                if (!user) throw new Error('Пользователь платежа не найден');

                const newBalance = Number(user.coins_balance) + Number(payment.stars_amount);

                await tx.run(`
                    UPDATE users SET coins_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                `, [newBalance, user.id]);

                const updated = await tx.run(`
                    UPDATE star_payments
                    SET status = 'paid', telegram_payment_charge_id = ?, paid_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'pending'
                `, [successfulPayment.telegram_payment_charge_id, payment.id]);

                if (updated.changes !== 1) return;

                await tx.run(`
                    INSERT INTO transactions (user_id, type, amount_coins, balance_after, reference_id)
                    VALUES (?, 'stars_topup', ?, ?, ?)
                `, [user.id, payment.stars_amount, newBalance, payment.id]);

                invalidateUserCache(user.id);
            });
        }

        return res.json({ ok: true });
    } catch (error) {
        console.error('[telegram webhook]', error);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Всё ниже — запросы от Mini App и требуют валидный Telegram initData.
router.use(telegramAuth);

router.post('/topup/invoice', async (req, res) => {
    const amount = Math.floor(Number(req.body?.amount));
    if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Сумма должна быть положительным целым числом Stars' });
    }
    if (amount > MAX_TOPUP_AMOUNT) {
        return res.status(400).json({ error: `Максимум за одно пополнение: ${MAX_TOPUP_AMOUNT} ⭐` });
    }
    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'На сервере не настроен BOT_TOKEN' });
    }

    const user = await getOrCreateUser(req.telegramUser);
    const paymentId = crypto.randomUUID();
    const payload = `topup:${paymentId}`;

    await db.run(`
        INSERT INTO star_payments (payment_id, user_id, telegram_id, stars_amount, payload, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [paymentId, user.id, Number(req.telegramUser.id), amount, payload]);

    try {
        const invoiceLink = await callBotApi('createInvoiceLink', {
            title: 'Пополнение игрового баланса',
            description: `Пополнение игрового баланса на ${amount} ⭐`,
            payload,
            currency: 'XTR',
            prices: [{ label: `${amount} ⭐`, amount }],
        });
        return res.json({ success: true, paymentId, amount, invoiceLink });
    } catch (error) {
        await db.run(`UPDATE star_payments SET status = 'cancelled' WHERE payment_id = ?`, [paymentId]);
        throw error;
    }
});

router.get('/topup/status/:paymentId', async (req, res) => {
    const user = await getOrCreateUser(req.telegramUser);
    const payment = await db.get(`
        SELECT payment_id, stars_amount, status, paid_at
        FROM star_payments WHERE payment_id = ? AND user_id = ?
    `, [req.params.paymentId, user.id]);
    if (!payment) return res.status(404).json({ error: 'Платёж не найден' });

    const freshUser = await db.get(`SELECT coins_balance FROM users WHERE id = ?`, [user.id]);
    return res.json({
        paymentId: payment.payment_id,
        amount: Number(payment.stars_amount),
        status: payment.status,
        paidAt: payment.paid_at || null,
        newBalance: Number(freshUser.coins_balance),
    });
});

module.exports = router;
